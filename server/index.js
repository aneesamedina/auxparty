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

const playlist_id = '6y9w7QNN7CqmPF6MxE4VGA'; // replace with your playlist ID
let autoplayIndex = 0; // keeps track of which song to play next in autoplay

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

app.post('/login', (req, res) => {
  const { name, role } = req.body;
  if (!name || !role || !['host','guest'].includes(role)) {
    return res.status(400).json({ error: 'Missing or invalid name/role' });
  }

  const sessionId = Math.random().toString(36).substring(2, 15);
  sessions[sessionId] = { name, role };
  res.json({ sessionId, name, role });
});

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
    }

    // Respond with actual current state
    res.json({ queue, nowPlaying });
  } catch (err) {
    console.error('Failed to add song:', err);
    res.status(500).json({ error: 'Failed to add song' });
  }
});

// Play next song
let currentAutoplayUri = null;
let isPlayingSong = false;

async function playNextSong() {
  if (isPlayingSong) return; // ignore if a song is already playing
  isPlayingSong = true;

  let next;
  if (queue.length > 0) {
    next = queue.shift();
    currentAutoplayUri = null; // reset autoplay
  } else {
    next = await fetchAutoplaySong();
    if (!next) {
      isPlayingSong = false;
      nowPlaying = null;
      io.emit('queueUpdate', { queue, nowPlaying });
      return;
    }
    currentAutoplayUri = next.song;
    autoplayIndex++; // increment only now
  }

  nowPlaying = { /* ... */ };
  io.emit('queueUpdate', { queue, nowPlaying });

  // Play on Spotify
  await spotifyFetch('https://api.spotify.com/v1/me/player/play', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uris: [next.song] }),
  });

  // Polling
  const poll = setInterval(async () => {
    const player = await spotifyFetch('https://api.spotify.com/v1/me/player');
    if (!player?.item) return;

    const progress = player.progress_ms;
    const duration = player.item.duration_ms;

    if (!player.is_playing || player.item.uri !== next.song || progress >= duration - 1000) {
      clearInterval(poll);
      isPlayingSong = false;
      playNextSong();
    }
  }, 2000);
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