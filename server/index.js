require('dotenv').config();
const express = require('express');
const cors = require('cors');
const querystring = require('querystring');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const sessions = {}; // sessionId -> { name, role }

const app = express();
const PORT = process.env.PORT || 3001;
const redirect_uri = process.env.SPOTIFY_REDIRECT_URI;
const client_id = process.env.SPOTIFY_CLIENT_ID;
const client_secret = process.env.SPOTIFY_CLIENT_SECRET;

const playlist_id = '2Ly1ZZ9s22gQEd2XKLfHyR';
let autoplayIndex = 0;

app.use(cors({
  origin: 'https://auxparty-pied.vercel.app',
  credentials: true
}));
app.use(express.json());

let history = []; // store songs that have already played
let accessToken = null;
let refreshToken = null;
let queue = [];
let nowPlaying = null;
let isPlaying = false;

// skip lock - now a boolean used as a simple mutex
let skipLock = false;

//skip votes
let skipVotes = {}; // { songUri: Set(userIds) }
let playNextVotes = {}; // { songUri: Set(userIds) }

const SKIP_MIN_VOTES = 2;      // change this to your desired number
const PLAYNEXT_MIN_VOTES = 2;  // for play-next voting

// --- Helpers for logging ---
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// Spotify Auth
app.get('/login', (req, res) => {
  const scope = 'user-modify-playback-state user-read-playback-state';
  const authUrl = 'https://accounts.spotify.com/authorize?' + querystring.stringify({
    response_type: 'code',
    client_id,
    scope,
    redirect_uri
  });
  res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code || null;
  try {
    // Get Spotify tokens
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(client_id + ':' + client_secret).toString('base64')
      },
      body: querystring.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri
      })
    });
    const data = await tokenRes.json();

    accessToken = data.access_token;
    refreshToken = data.refresh_token;
    log('[AUTH] Received tokens; accessToken set');

    // Create host session AFTER Spotify OAuth
    const sessionId = Math.random().toString(36).substring(2, 15);
    sessions[sessionId] = { name: 'Host', role: 'host', verified: true };

    // Redirect to frontend host page with sessionId
    res.redirect(`https://auxparty-pied.vercel.app/host?sessionId=${sessionId}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error during Spotify login.');
  }
});

async function refreshAccessToken() {
  if (!refreshToken) throw new Error('No refresh token available');
  log('[refreshAccessToken] refreshing token...');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(client_id + ':' + client_secret).toString('base64')
    },
    body: querystring.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    })
  });
  const data = await res.json();
  accessToken = data.access_token;
  log('[refreshAccessToken] new access token received at', new Date().toISOString());
  return accessToken;
}

async function spotifyFetch(url, options = {}, retry = true) {
  if (!accessToken) throw new Error('Not authorized');
  log('[spotifyFetch] URL:', url, 'method:', options.method || 'GET');
  const res = await fetch(url, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401 && retry) {
    log('[spotifyFetch] 401 received, attempting token refresh...');
    await refreshAccessToken();
    return spotifyFetch(url, options, false);
  }
  if (res.status === 204) return null; // No Content, e.g., pause success with empty body
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const json = await res.json();
    return json;
  } else {
    const text = await res.text();
    return text;
  }
}

// ---- Debug endpoints ----
app.get('/debug/state', async (req, res) => {
  try {
    const player = await spotifyFetch('https://api.spotify.com/v1/me/player').catch(e => ({ error: e.message }));
    res.json({
      queue,
      nowPlaying,
      historyLength: history.length,
      skipVotesSummary: Object.fromEntries(Object.entries(skipVotes).map(([k,v]) => [k, v.size])),
      playNextVotesSummary: Object.fromEntries(Object.entries(playNextVotes).map(([k,v]) => [k, v.size])),
      player
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/debug/devices', async (req, res) => {
  try {
    const devices = await spotifyFetch('https://api.spotify.com/v1/me/player/devices');
    res.json(devices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Existing endpoints ----
app.post('/login', (req, res) => {
  const { name, role } = req.body;
  if (!name || !role || !['host','guest'].includes(role)) {
    return res.status(400).json({ error: 'Missing or invalid name/role' });
  }

  const sessionId = Math.random().toString(36).substring(2, 15);
  sessions[sessionId] = { name, role };
  res.json({ sessionId, name, role });
});

app.get('/queue', (req, res) => {
  res.json({ queue, nowPlaying });
});

app.post('/queue', async (req, res) => {
  const { name, song: uri, force } = req.body;
  if (!name || !uri) return res.status(400).json({ error: 'Missing name or song URI' });

  // Check duplicates or already played
  const alreadyPlaying = nowPlaying?.song === uri;
  const inQueue = queue.some(item => item.song === uri);
  const inHistory = history.some(item => item.song === uri);

  if (!force && (alreadyPlaying || inQueue || inHistory)) {
    let errorMsg = '';
    if (alreadyPlaying) errorMsg = 'This song is already playing!';
    else if (inQueue) errorMsg = 'This song is already in the queue!';
    else if (inHistory) errorMsg = 'This song has already been played!';

    return res.status(400).json({ error: errorMsg, canForce: true }); // signal frontend that it can be forced
  }

  try {
    const trackId = uri.split(':')[2];
    const trackData = await spotifyFetch(`https://api.spotify.com/v1/tracks/${trackId}`);
    const newItem = {
      name,
      song: uri,
      trackName: trackData.name,
      artists: trackData.artists.map(a => a.name),
      album: {
        name: trackData.album.name,
        images: trackData.album.images
      }
    };
    queue.push(newItem);

    if (!nowPlaying) {
      playNextSong();
    }

    io.emit('queueUpdate', { queue, nowPlaying });
    res.json({ queue, nowPlaying });
  } catch (err) {
    console.error('Failed to add song:', err);
    res.status(500).json({ error: 'Failed to add song' });
  }
});

app.post('/vote/skip', (req, res) => {
  const { userId, song } = req.body;
  if (!userId || !song) return res.status(400).json({ error: 'Missing user or song' });

  if (!skipVotes[song]) skipVotes[song] = new Set();

  if (skipVotes[song].has(userId)) {
    // User already voted → rescind vote
    skipVotes[song].delete(userId);
  } else {
    // Add vote
    skipVotes[song].add(userId);
  }
  const votes = skipVotes[song].size;

  io.emit('voteUpdate', { type: 'skip', song, votes });

  if (votes >= SKIP_MIN_VOTES) {
    // Remove song from queue
    queue = queue.filter(item => item.song !== song);

    // Clear votes for that song
    skipVotes[song] = new Set();

    io.emit('queueUpdate', { queue, nowPlaying });
    io.emit('voteUpdate', { type: 'skip', song, votes: 0 });
  }

  res.json({ success: true, votes });
});

app.post('/vote/playnext', (req, res) => {
  const { userId, song } = req.body;
  if (!userId || !song) return res.status(400).json({ error: 'Missing user or song' });

  if (!playNextVotes[song]) playNextVotes[song] = new Set();

  // check if they already voted for this song
  if (playNextVotes[song].has(userId)) {
    playNextVotes[song].delete(userId);
  } else{
    playNextVotes[song].add(userId);
  }

  const votes = playNextVotes[song].size;

  io.emit('voteUpdate', { type: 'playnext', song, votes });

  if (votes >= PLAYNEXT_MIN_VOTES) {
    const targetIndex = queue.findIndex(q => q.song === song);
    if (targetIndex !== -1) {
      const [target] = queue.splice(targetIndex, 1);
      queue.unshift(target);
    }

    playNextVotes[song] = new Set();
    io.emit('queueUpdate', { queue, nowPlaying });
    io.emit('voteUpdate', { type: 'playnext', song, votes: 0 });
  }

  res.json({ success: true, votes });
});

app.post('/queue/reorder', (req, res) => {
  const { queue: newOrder } = req.body;
  if (!Array.isArray(newOrder)) return res.status(400).json({ error: 'Invalid queue' });

  // Reorder existing queue based on song URIs
  const reorderedQueue = [];
  newOrder.forEach(uri => {
    const item = queue.find(q => q.song === uri);
    if (item) reorderedQueue.push(item);
  });

  queue = reorderedQueue;
  io.emit('queueUpdate', { queue, nowPlaying });
  res.json({ queue });
});

app.post('/queue/remove', (req, res) => {
  const { song } = req.body;
  if (!song) return res.status(400).json({ error: 'Song is required' });

  // Remove the song from the queue
  queue = queue.filter(item => item.song !== song);

  // Broadcast the updated queue via Socket.IO
  io.emit('queueUpdate', { queue, nowPlaying: nowPlaying || null });

  res.json({ queue });
});

// ---- Improved playNextSong: device-aware and robust locking ----
async function pickActiveDevice() {
  try {
    const devicesRes = await spotifyFetch('https://api.spotify.com/v1/me/player/devices');
    const devices = devicesRes.devices || [];
    if (!devices.length) return null;
    // Prefer an active device; otherwise take the first available
    const active = devices.find(d => d.is_active) || devices[0];
    return active;
  } catch (err) {
    log('[pickActiveDevice] error:', err.message || err);
    return null;
  }
}

async function playNextSong(manual = false) {
  if (skipLock) {
    log('[playNextSong] skipped because lock is engaged');
    return;
  }
  skipLock = true;
  log('[playNextSong] lock acquired');

  let next;
  try {
    if (queue.length > 0) {
      next = queue.shift();
    } else {
      next = await fetchAutoplaySong();
      if (!next) {
        isPlaying = false;
        nowPlaying = null;
        io.emit('queueUpdate', { queue, nowPlaying });
        log('[playNextSong] no next song found (autoplay empty)');
        skipLock = false;
        return;
      }
    }

    if (nowPlaying) history.push(nowPlaying); // save current song to history

    nowPlaying = {
      trackName: next.trackName,
      song: next.song,
      artists: next.artists,
      addedBy: next.name,
      album: next.album
    };

    // reset votes and emit resets for the new nowPlaying
    skipVotes = {};
    playNextVotes = {};
    io.emit('voteUpdate', { type: 'skip', song: nowPlaying.song, votes: 0 });
    io.emit('voteUpdate', { type: 'playnext', song: nowPlaying.song, votes: 0 });

    isPlaying = true;
    io.emit('queueUpdate', { queue, nowPlaying });
    log('[playNextSong] about to play:', next.song, 'title:', next.trackName);

    // Try to pick an active device and include its id if present
    const device = await pickActiveDevice();
    let playUrl = 'https://api.spotify.com/v1/me/player/play';
    if (device && device.id) {
      playUrl += `?device_id=${encodeURIComponent(device.id)}`;
      log('[playNextSong] using device:', device.id, device.name, 'is_active:', device.is_active);
    } else {
      log('[playNextSong] no device found - attempting play without device_id (may fail)');
    }

    await spotifyFetch(playUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: [next.song] }),
    });

    // begin polling player state to detect end-of-track
    const poll = setInterval(async () => {
      try {
        const player = await spotifyFetch('https://api.spotify.com/v1/me/player');
        log('[poll] player:', {
          is_playing: player?.is_playing,
          device_id: player?.device?.id,
          device_name: player?.device?.name,
          progress_ms: player?.progress_ms,
          duration_ms: player?.item?.duration_ms,
          item_id: player?.item?.id
        });

        if (!player || !player.item) {
          clearInterval(poll);
          isPlaying = false;
          nowPlaying = null;
          io.emit('queueUpdate', { queue, nowPlaying });
          log('[poll] player missing item - clearing nowPlaying');
          skipLock = false;
          return;
        }

        const progress = player.progress_ms || 0;
        const duration = player.item.duration_ms || 0;

        // If playback isn't active but we expect it to be, log it (helps debugging)
        if (!player.is_playing && progress < duration - 2000) {
          log('[poll] detected player not playing while track in progress (possible device switch)');
        }

        // If near end, advance
        if (progress >= duration - 1000 && isPlaying) {
          clearInterval(poll);
          log('[poll] track ended - advancing to next');
          // unlock before calling recursively to avoid permanent lock if recursive throws
          skipLock = false;
          await playNextSong();
        }
      } catch (err) {
        console.error('[poll][ERROR]:', err);
        clearInterval(poll);
        isPlaying = false;
        nowPlaying = null;
        io.emit('queueUpdate', { queue, nowPlaying });
        skipLock = false;
      }
    }, 2000);

  } catch (err) {
    console.error('[playNextSong][ERROR] failed to play song:', err);
    isPlaying = false;
    nowPlaying = null;
    io.emit('queueUpdate', { queue, nowPlaying });
    skipLock = false;
  }
}

// Skip/Next via API
app.post('/play', async (req, res) => {
  try {
    await playNextSong(true);
    res.json({ message: 'Skipped to next song', queue, nowPlaying });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to play next song' });
  }
});

// Host Previous
app.post('/host/previous', async (req, res) => {
  if (history.length === 0) {
    return res.status(400).json({ error: 'No previous song in history' });
  }

  const previousSong = history.pop();
  if (nowPlaying) queue.unshift(nowPlaying); // optional: put current song back in front
  nowPlaying = previousSong;

  try {
    // try to select a device when playing previous
    const device = await pickActiveDevice();
    let playUrl = 'https://api.spotify.com/v1/me/player/play';
    if (device && device.id) playUrl += `?device_id=${encodeURIComponent(device.id)}`;

    await spotifyFetch(playUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: [previousSong.song] }),
    });

    io.emit('queueUpdate', { queue, nowPlaying });
    res.json({ message: 'Playing previous song', nowPlaying });
  } catch (err) {
    console.error('Previous failed:', err);
    res.status(500).json({ error: 'Failed to play previous song' });
  }
});

// Pause Spotify (generic)
app.post('/host/pause', async (req, res) => {
  try {
    const player = await spotifyFetch('https://api.spotify.com/v1/me/player');
    if (!player) {
      return res.status(400).json({ error: 'No active playback found.' });
    }

    if (player.is_playing) {
      await spotifyFetch('https://api.spotify.com/v1/me/player/pause', { method: 'PUT' });
    } else {
      // include device id when resuming if possible
      const device = player.device;
      let playUrl = 'https://api.spotify.com/v1/me/player/play';
      if (device && device.id) playUrl += `?device_id=${encodeURIComponent(device.id)}`;
      await spotifyFetch(playUrl, { method: 'PUT' });
    }

    const updatedPlayer = await spotifyFetch('https://api.spotify.com/v1/me/player');
    const isPlayingRes = updatedPlayer?.is_playing ?? false;

    io.emit('queueUpdate', { queue, nowPlaying, isPlaying: isPlayingRes });
    res.json({ message: 'Toggled playback', isPlaying: isPlayingRes });
  } catch (err) {
    console.error('Host pause failed:', err);
    res.status(500).json({ error: 'Failed to toggle playback', details: err.message });
  }
});

// Resume Spotify (generic)
app.post('/resume', async (req, res) => {
  try {
    const device = await pickActiveDevice();
    let playUrl = 'https://api.spotify.com/v1/me/player/play';
    if (device && device.id) playUrl += `?device_id=${encodeURIComponent(device.id)}`;

    await spotifyFetch(playUrl, { method: 'PUT' });
    isPlaying = true;
    res.json({ message: 'Playback resumed', nowPlaying });
  } catch (err) {
    console.error('Resume failed:', err);
    res.status(500).json({ error: 'Failed to resume' });
  }
});

app.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Query required' });

  try {
    const data = await spotifyFetch(`https://api.spotify.com/v1/search?${querystring.stringify({ q, type: 'track', limit: 10 })}`);
    const tracks = data.tracks.items.map(track => ({
      name: track.name,
      artists: track.artists.map(a => a.name),
      uri: track.uri,
      album: {
        name: track.album.name,
        images: track.album.images
      }
    }));
    res.json({ tracks });
  } catch (err) {
    console.error('Search failed:', err);
    res.status(500).json({ error: 'Failed to search Spotify' });
  }
});

async function fetchAutoplaySong() {
  try {
    const data = await spotifyFetch(`https://api.spotify.com/v1/playlists/${playlist_id}/tracks?limit=50`);
    if (!data.items || data.items.length === 0) return null;

    const track = data.items[autoplayIndex % data.items.length].track;
    autoplayIndex++;

    return {
      name: 'Autoplay',
      song: track.uri,
      trackName: track.name,
      artists: track.artists.map(a => a.name),
      album: {
        name: track.album.name,
        images: track.album.images
      }
    };
  } catch (err) {
    console.error('Failed to fetch autoplay song:', err);
    return null;
  }
}

const http = require('http');
const { Server } = require('socket.io');

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: 'https://auxparty-pied.vercel.app',
    methods: ['GET','POST'],
    credentials: true,
  }
});

io.on('connection', (socket) => {
  log('New client connected:', socket.id);
  socket.emit('testMessage', { msg: 'Hello from server!' });
  socket.emit('queueUpdate', { queue, nowPlaying });
  socket.on('disconnect', () => log('Client disconnected:', socket.id));

  Object.keys(skipVotes).forEach(song => {
    socket.emit('voteUpdate', { type: 'skip', song, votes: skipVotes[song].size });
  });
  Object.keys(playNextVotes).forEach(song => {
    socket.emit('voteUpdate', { type: 'playnext', song, votes: playNextVotes[song].size });
  });
});

server.listen(PORT, () => log(`Server running on port ${PORT}`));