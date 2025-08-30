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
async function playNextSong() {
  console.log("=== playNextSong CALLED ===");

  let next;
  if (queue.length > 0) {
    next = queue.shift();
    console.log("➡️ Playing from queue:", next.trackName, "-", next.artists.join(", "));
  } else {
    next = await fetchAutoplaySong();
    if (!next) {
      console.log("❌ No autoplay song available, returning.");
      return;
    }
    console.log("🎶 Playing from autoplay:", next.trackName, "-", next.artists.join(", "));
  }

  nowPlaying = next;
  console.log("NowPlaying set:", nowPlaying.uri);

  try {
    await spotifyFetch("https://api.spotify.com/v1/me/player/play", {
      method: "PUT",
      body: JSON.stringify({ uris: [next.uri] }),
    });
    console.log("✅ Sent play request to Spotify:", next.uri);

    // Poll for song progress
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      try {
        const player = await spotifyFetch("https://api.spotify.com/v1/me/player");
        const progress = player?.progress_ms || 0;
        const duration = player?.item?.duration_ms || 1;
        const isPlaying = player?.is_playing;

        console.log(
          `Polling [${attempts}] progress=${progress}/${duration} (${(
            (progress / duration) *
            100
          ).toFixed(1)}%), isPlaying=${isPlaying}`
        );

        if (!isPlaying) {
          console.log("⚠️ Player not playing. Skipping to next track.");
          clearInterval(poll);
          playNextSong();
        } else if (progress >= duration - 2000) {
          console.log("⏭️ Song finished. Moving to next.");
          clearInterval(poll);
          playNextSong();
        }
      } catch (err) {
        console.error("Polling error:", err.message);
        clearInterval(poll);
      }
    }, 5000);
  } catch (err) {
    console.error("❌ Error in playNextSong:", err.message);
  }
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