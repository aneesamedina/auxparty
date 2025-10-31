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

// skip lock
let skipLock = false;

//skip votes
let skipVotes = {}; // { songUri: Set(userIds) }
let playNextVotes = {}; // { songUri: Set(userIds) }

const SKIP_MIN_VOTES = 5;      // change this to your desired number
const PLAYNEXT_MIN_VOTES = 5;  // for play-next voting

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
  return accessToken;
}

async function spotifyFetch(url, options = {}, retry = true) {
  if (!accessToken) throw new Error('Not authorized');
  const res = await fetch(url, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${accessToken}` },
  });

  console.log(`[SpotifyFetch] ${options.method || 'GET'} ${url} → ${res.status}`);

  if (res.status === 401 && retry) {
    console.warn('[SpotifyFetch] Token expired, refreshing...');
    await refreshAccessToken();
    return spotifyFetch(url, options, false);
  }

  if (res.status === 204) return null;

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const json = await res.json();
    if (res.status >= 400) console.error('[SpotifyFetch Error]', json);
    return json;
  } else {
    const text = await res.text();
    if (res.status >= 400) console.error('[SpotifyFetch Error]', text);
    return text;
  }
}

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
  // If you have sessions, find the correct session queue instead
  queue = queue.filter(item => item.song !== song);

  // Broadcast the updated queue via Socket.IO
  io.emit('queueUpdate', { queue, nowPlaying: nowPlaying || null });

  res.json({ queue });
});

async function playNextSong(manual = false) {
  console.log(`[playNextSong] Called at ${new Date().toISOString()} | isPlaying=${isPlaying}`);

  if (skipLock) return;
  skipLock = true;
  setTimeout(() => skipLock = false, 1000);

  let next;

  if (queue.length > 0) {
    next = queue.shift();
  } else {
    next = await fetchAutoplaySong();
    if (!next) {
      isPlaying = false;
      nowPlaying = null;
      io.emit('queueUpdate', { queue, nowPlaying });
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

  skipVotes = {};
  playNextVotes = {};
  io.emit('voteUpdate', { type: 'skip', song: nowPlaying.song, votes: 0 });
  io.emit('voteUpdate', { type: 'playnext', song: nowPlaying.song, votes: 0 });

  isPlaying = true;
  io.emit('queueUpdate', { queue, nowPlaying });

  try {
    await spotifyFetch('https://api.spotify.com/v1/me/player/play', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: [next.song] }),
    });

    let lastRecovery = 0; // cooldown for unexpected pause recovery
    const SONG_END_BUFFER = 2000; // 3 seconds buffer before end

    const poll = setInterval(async () => {
      try {
        const player = await spotifyFetch('https://api.spotify.com/v1/me/player');
        if (!player || !player.item) {
          console.warn('[Poll] Player missing — possibly lost device');
          clearInterval(poll);
          isPlaying = false;
          nowPlaying = null;
          io.emit('queueUpdate', { queue, nowPlaying });
          return;
        }

        const progress = player.progress_ms;
        const duration = player.item.duration_ms;

        console.log(`[Poll] Progress: ${progress}/${duration} (${player.is_playing ? 'playing' : 'paused'})`);

        // Song ended naturally → next
        if (progress >= duration - SONG_END_BUFFER && isPlaying) {
          console.log('[Poll] Song ended → next');
          clearInterval(poll);
          playNextSong();
          return;
        }

        // Detect unexpected pause/reset
        if (progress === 0 && !player.is_playing && nowPlaying) {
          // Only recover if song hasn’t almost finished
          if (player.item && (player.progress_ms < player.item.duration_ms - SONG_END_BUFFER)) {
            const now = Date.now();
            if (now - lastRecovery > 5000) { // 5s cooldown
              console.warn('[Poll] Playback reset — resending play for nowPlaying');
              lastRecovery = now;
              await spotifyFetch('https://api.spotify.com/v1/me/player/play', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uris: [nowPlaying.song] })
              });
            }
          }
        }

      } catch (err) {
        console.error('[Poll Error]', err);
        clearInterval(poll);
        isPlaying = false;
        nowPlaying = null;
        io.emit('queueUpdate', { queue, nowPlaying });
      }
    }, 2000);

  } catch (err) {
    console.error('Failed to play song:', err);
    isPlaying = false;
    nowPlaying = null;
    io.emit('queueUpdate', { queue, nowPlaying });
  }
}

// Skip/Next
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
    await spotifyFetch('https://api.spotify.com/v1/me/player/play', {
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
      await spotifyFetch('https://api.spotify.com/v1/me/player/play', { method: 'PUT' });
    }

    const updatedPlayer = await spotifyFetch('https://api.spotify.com/v1/me/player');
    const isPlaying = updatedPlayer?.is_playing ?? false;

    io.emit('queueUpdate', { queue, nowPlaying, isPlaying });
    res.json({ message: 'Toggled playback', isPlaying });
  } catch (err) {
    console.error('Host pause failed:', err);
    res.status(500).json({ error: 'Failed to toggle playback', details: err.message });
  }
});

app.post('/host/play-from-index', async (req, res) => {
  const { index } = req.body;
  const sessionId = req.session?.id; // or however you track the host session
  const session = sessions[sessionId];
  if (!session) return res.status(404).send('Session not found');

  const accessToken = session.access_token;
  const playlistId = session.currentPlaylistId;

  try {
    // Fetch playlist tracks
    const playlistRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await playlistRes.json();
    const uris = data.items.map(item => item.track.uri);

    // Play from chosen index
    await fetch('https://api.spotify.com/v1/me/player/play', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uris,
        offset: { position: index },
        position_ms: 0,
      }),
    });

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to start playback');
  }
});

// Resume Spotify (generic)
app.post('/resume', async (req, res) => {
  try {
    await spotifyFetch('https://api.spotify.com/v1/me/player/play', { method: 'PUT' });
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
  console.log('New client connected:', socket.id);
  socket.emit('testMessage', { msg: 'Hello from server!' });
  socket.emit('queueUpdate', { queue, nowPlaying });
  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));

  Object.keys(skipVotes).forEach(song => {
    socket.emit('voteUpdate', { type: 'skip', song, votes: skipVotes[song].size });
  });
  Object.keys(playNextVotes).forEach(song => {
    socket.emit('voteUpdate', { type: 'playnext', song, votes: playNextVotes[song].size });
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));