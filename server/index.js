require('dotenv').config();
const express = require('express');
const cors = require('cors');
const querystring = require('querystring');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3001;

// CORS setup
app.use(cors({
  origin: 'http://localhost:3000',
  credentials: true
}));
app.use(express.json());

const redirect_uri = process.env.SPOTIFY_REDIRECT_URI;
const client_id = process.env.SPOTIFY_CLIENT_ID;
const client_secret = process.env.SPOTIFY_CLIENT_SECRET;

// In-memory store
let accessToken = null;
let refreshToken = null;
let queue = [];

// -----------------
// Spotify Auth
// -----------------

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
    const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${client_id}:${client_secret}`).toString('base64')
      },
      body: querystring.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri
      })
    });
    const data = await tokenResponse.json();
    accessToken = data.access_token;
    refreshToken = data.refresh_token;

    res.send('Logged in! You can now control playback.');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error during Spotify login.');
  }
});

// Refresh access token
async function refreshAccessToken() {
  if (!refreshToken) throw new Error('No refresh token available');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${client_id}:${client_secret}`).toString('base64')
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

// -----------------
// Spotify Fetch Helper
// -----------------

async function spotifyFetch(url, options = {}) {
  if (!accessToken) throw new Error('Not authorized');

  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${accessToken}`,
      },
    });

    // Refresh token if expired
    if (res.status === 401) {
      await refreshAccessToken();
      return spotifyFetch(url, options);
    }

    // Handle 204 No Content
    if (res.status === 204) return null;

    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (err) {
    console.error('Spotify fetch error:', err);
    throw err;
  }
}

// -----------------
// Queue Endpoints
// -----------------

app.get('/queue', (req, res) => res.json(queue));

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
      artists: trackData.artists.map(a => a.name).join(', '),
    };

    queue.push(newItem);
    res.json({ queue });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add song' });
  }
});

// -----------------
// Playback Endpoint
// -----------------

app.post('/play', async (req, res) => {
  if (!queue.length) return res.json({ message: 'Queue is empty' });

  const next = queue.shift();
  try {
    await spotifyFetch('https://api.spotify.com/v1/me/player/play', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: [next.song] })
    });
    res.json({ message: `Now playing: ${next.trackName} by ${next.artists}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to play song' });
  }
});

// -----------------
// Spotify Search Endpoint
// -----------------

app.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Query required' });

  try {
    const data = await spotifyFetch(`https://api.spotify.com/v1/search?${querystring.stringify({ q, type: 'track', limit: 10 })}`);
    const tracks = data.tracks.items.map(track => ({
      name: track.name,
      artists: track.artists.map(a => a.name),
      uri: track.uri
    }));
    res.json({ tracks });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to search Spotify' });
  }
});

// -----------------
// Start Server
// -----------------

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));