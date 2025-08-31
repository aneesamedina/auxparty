require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

let queue = [];
let nowPlaying = null;
let isPlaying = false;
let skipLock = false;
let lastSpotifyTrackUri = null;

async function spotifyFetch(url, options = {}) {
  const token = process.env.SPOTIFY_TOKEN; // Use your Spotify token
  const headers = options.headers || {};
  headers['Authorization'] = `Bearer ${token}`;
  options.headers = headers;
  const res = await fetch(url, options);
  return res.json();
}

async function fetchAutoplaySong() {
  // your logic to fetch an autoplay song
  return null;
}

async function playNextSong(manual = false) {
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

  nowPlaying = {
    trackName: next.trackName,
    song: next.song,
    artists: next.artists,
    addedBy: next.name,
    album: next.album
  };
  isPlaying = true;
  lastSpotifyTrackUri = next.song;
  io.emit('queueUpdate', { queue, nowPlaying });

  try {
    await spotifyFetch('https://api.spotify.com/v1/me/player/play', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: [next.song] }),
    });

    // Poll Spotify to detect song end or manual skip
    const poll = setInterval(async () => {
      try {
        const player = await spotifyFetch('https://api.spotify.com/v1/me/player');
        if (!player || !player.item) {
          clearInterval(poll);
          isPlaying = false;
          nowPlaying = null;
          io.emit('queueUpdate', { queue, nowPlaying });
          return;
        }

        const currentUri = player.item.uri;

        if (player.is_playing === false) {
          // Song paused, do not skip
          return;
        }

        // Detect manual skip
        if (currentUri !== lastSpotifyTrackUri) {
          clearInterval(poll);
          playNextSong();
          return;
        }

        const progress = player.progress_ms;
        const duration = player.item.duration_ms;

        if (progress >= duration - 1000) {
          clearInterval(poll);
          playNextSong();
        }
      } catch (err) {
        console.error('Polling error:', err);
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

// Express endpoints
app.post('/play', async (req, res) => {
  await playNextSong(true);
  res.sendStatus(200);
});

app.post('/pause', async (req, res) => {
  try {
    await spotifyFetch('https://api.spotify.com/v1/me/player/pause', { method: 'PUT' });
    isPlaying = false;
    io.emit('queueUpdate', { queue, nowPlaying });
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

app.post('/add', (req, res) => {
  const { song, trackName, artists, name, album } = req.body;
  queue.push({ song, trackName, artists, name, album });
  io.emit('queueUpdate', { queue, nowPlaying });
  res.sendStatus(200);
});

const server = require('http').createServer(app);
const { Server } = require('socket.io');
const io = new Server(server, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  socket.emit('queueUpdate', { queue, nowPlaying });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
