require('dotenv').config();
const express = require('express');
const cors = require('cors');

const querystring = require('querystring');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3001;
const redirect_uri = process.env.SPOTIFY_REDIRECT_URI;
const client_id = process.env.SPOTIFY_CLIENT_ID;
const client_secret = process.env.SPOTIFY_CLIENT_SECRET;

let playedTracks = new Set();
const DEFAULT_PLAYLIST_ID = process.env.DEFAULT_PLAYLIST_ID; // put your default playlist ID in .env

app.use(cors({
  origin: 'https://auxparty-pied.vercel.app',
  credentials: true
}));
app.use(express.json());

let accessToken = null;
let refreshToken = null;
let queue = [];
let nowPlaying = null;
let isPlaying = false;

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
    res.send('Logged in! You can now control playback.');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error during Spotify login.');
  }
});

// Helpers
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
  if (res.status === 401 && retry) {
    await refreshAccessToken();
    return spotifyFetch(url, options, false);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Queue endpoints
app.get('/queue', (req, res) => {
  res.json({ queue, nowPlaying });
});

app.post('/queue', async (req, res) => {
  const { name, song: uri } = req.body;
  if (!name || !uri) return res.status(400).json({ error: 'Missing name or song URI' });

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

    // Only auto-play if nothing is playing
    if (!nowPlaying) {
      playNextSong();
    } else {
      // Update clients with new queue
      io.emit('queueUpdate', { queue, nowPlaying });
    }

    // Respond with actual current state
    res.json({ queue, nowPlaying });
  } catch (err) {
    console.error('Failed to add song:', err);
    res.status(500).json({ error: 'Failed to add song' });
  }
});

// Play next song
let currentPoll = null;

async function playNextSong() {
  try {
    let next;

    // Get next song from queue or random
    if (queue.length > 0) {
      next = queue.shift();
    } else {
      next = await getRandomTrack();
    }

    if (!next || !next.song) {
      console.warn('No next track available, retrying in 2s...');
      nowPlaying = null;
      isPlaying = false;
      io.emit('queueUpdate', { queue, nowPlaying });
      return setTimeout(playNextSong, 2000);
    }

    nowPlaying = next;
    isPlaying = true;

    // Play the song on Spotify
    try {
      await spotifyFetch('https://api.spotify.com/v1/me/player/play', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uris: [next.song] }),
      });
    } catch (err) {
      console.warn('Failed to play song, maybe no active device:', err);
      // Retry in 2s
      return setTimeout(playNextSong, 2000);
    }

    io.emit('queueUpdate', { queue, nowPlaying });

    // Start polling to detect when the track ends
    pollCurrentTrack(next.song);

  } catch (err) {
    console.error('playNextSong error:', err);
    nowPlaying = null;
    isPlaying = false;
    io.emit('queueUpdate', { queue, nowPlaying });
    setTimeout(playNextSong, 2000);
  }
}

function pollCurrentTrack(trackUri) {
  // Prevent multiple polls
  if (currentPoll) clearInterval(currentPoll);

  currentPoll = setInterval(async () => {
    try {
      const player = await spotifyFetch('https://api.spotify.com/v1/me/player');
      if (!player || !player.item || !player.is_playing) {
        clearInterval(currentPoll);
        nowPlaying = null;
        isPlaying = false;
        io.emit('queueUpdate', { queue, nowPlaying });
        return;
      }

      const { uri, progress_ms, duration_ms } = player.item;

      // Trigger next song when current ends
      if (uri === trackUri && progress_ms >= duration_ms - 500) { // 500ms buffer
        clearInterval(currentPoll);
        playNextSong();
      }

    } catch (err) {
      console.error('Polling error:', err);
      clearInterval(currentPoll);
      nowPlaying = null;
      isPlaying = false;
      io.emit('queueUpdate', { queue, nowPlaying });
    }
  }, 2000);
}

//get random unplayed track
async function getRandomTrack() {
  if (!accessToken) throw new Error('Not authorized');

  const res = await fetch(`https://api.spotify.com/v1/playlists/${DEFAULT_PLAYLIST_ID}/tracks?limit=100`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const data = await res.json();
  const unplayed = data.items.filter(item => !playedTracks.has(item.track.id));

  if (unplayed.length === 0) {
    playedTracks.clear(); // reset if all tracks have been played
    return getRandomTrack();
  }

  const randomTrack = unplayed[Math.floor(Math.random() * unplayed.length)];
  playedTracks.add(randomTrack.track.id);

  return {
    trackName: randomTrack.track.name,
    song: randomTrack.track.uri,
    artists: randomTrack.track.artists.map(a => a.name),
    album: {
      name: randomTrack.track.album.name,
      images: randomTrack.track.album.images
    },
    addedBy: 'Auto' // indicates it’s from the default playlist
  };
}

// Manual skip
app.post('/play', async (req, res) => {
  try {
    await playNextSong();
    res.json({ message: 'Skipped to next song', queue, nowPlaying });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to play next song' });
  }
});

// Search
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

const http = require('http');
const { Server } = require('socket.io');

// Wrap Express app
const server = http.createServer(app);

// Create Socket.IO instance
const io = new Server(server, {
  cors: {
    origin: 'https://auxparty-pied.vercel.app',
    methods: ['GET','POST'],
    credentials: true,
  }
});

// Listen for connections
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // Send a test message immediately
  socket.emit('testMessage', { msg: 'Hello from server!' });
  socket.emit('queueUpdate', { queue, nowPlaying });
  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

// Replace app.listen with server.listen
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));