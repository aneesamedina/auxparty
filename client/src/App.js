import { useState, useEffect } from 'react';
import { io } from 'socket.io-client'; // <-- add this

const API_URL = process.env.REACT_APP_API_URL;

function App() {
  const [queue, setQueue] = useState([]);
  const [name, setName] = useState('');
  const [song, setSong] = useState('');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState([]);
  const [nowPlaying, setNowPlaying] = useState(null);

  const normalizeNowPlaying = (np) => {
    if (!np) return null;
    return {
      trackName: np.trackName,
      artists: Array.isArray(np.artists) ? np.artists : [np.artists],
      addedBy: np.addedBy || ''
    };
  };

  // --------------------------
  // Socket.IO for real-time updates
  useEffect(() => {
    const socket = io(API_URL, { withCredentials: true });

    socket.on('queueUpdate', ({ queue, nowPlaying }) => {
      setQueue(queue);
      setNowPlaying(normalizeNowPlaying(nowPlaying));
    });

    // Test connection
    socket.on('testMessage', (data) => {
      console.log('Received from server:', data);
    });

    return () => socket.disconnect();
  }, []);
  // --------------------------

  // Keep polling as a fallback if you want
  useEffect(() => {
    const fetchQueue = async () => {
      try {
        const res = await fetch(`${API_URL}/queue`, { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP error ${res.status}`);
        const data = await res.json();
        setQueue(prev => JSON.stringify(prev) !== JSON.stringify(data.queue) ? data.queue : prev);
        setNowPlaying(prev => JSON.stringify(prev) !== JSON.stringify(data.nowPlaying) ? normalizeNowPlaying(data.nowPlaying) : prev);
      } catch (err) {
        console.error("Error fetching queue:", err);
      }
    };

    fetchQueue();
    const interval = setInterval(fetchQueue, 3000);
    return () => clearInterval(interval);
  }, []);

  const searchSong = async () => {
    if (!search) return;
    try {
      const res = await fetch(`${API_URL}/search?q=${encodeURIComponent(search)}`, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      const data = await res.json();
      setResults(Array.isArray(data.tracks) ? data.tracks : []);
    } catch (err) {
      console.error("Error searching:", err);
    }
  };

  const addSong = async () => {
    if (!name || !song) return alert('Enter name and Spotify URI');

    try {
      const res = await fetch(`${API_URL}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, song }),
        credentials: 'include',
      });

      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      const data = await res.json();

      setQueue(data.queue);
      setNowPlaying(prev => prev || data.nowPlaying);

      setName('');
      setSong('');
    } catch (err) {
      console.error("Error adding song:", err);
    }
  };

  const addSongToQueue = (track) => {
    setSong(track.uri);
    setResults([]);
    setSearch('');
  };

  const playNext = async () => {
    try {
      const res = await fetch(`${API_URL}/play`, { method: 'POST', credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      const data = await res.json();
      setNowPlaying(normalizeNowPlaying(data.nowPlaying));
      setQueue(data.queue);
    } catch (err) {
      console.error("Error playing next:", err);
    }
  };

  return (
    <div style={{ padding: 20 }}>
      <h1>Party Queue</h1>

      <div style={{ marginBottom: 20 }}>
        <a href={`${API_URL}/login`} target="_blank" rel="noreferrer">Host Login (Spotify)</a>
        <button onClick={playNext} style={{ marginLeft: 10 }}>Next Song</button>
      </div>

      <div style={{ marginBottom: 20 }}>
        <input placeholder="Your Name" value={name} onChange={e => setName(e.target.value)} />
        <input placeholder="Spotify URI" value={song} onChange={e => setSong(e.target.value)} style={{ marginLeft: 10 }} />
        <button onClick={addSong} style={{ marginLeft: 10 }}>Add to Queue</button>
      </div>

      <div>
        <input placeholder="Search Spotify" value={search} onChange={e => setSearch(e.target.value)} />
        <button onClick={searchSong} style={{ marginLeft: 10 }}>Search</button>

        <ul>
          {results.map((track, idx) => (
            <li key={idx}>
              {track.name} - {track.artists.join(', ')}
              <button onClick={() => addSongToQueue(track)} style={{ marginLeft: 10 }}>Select</button>
            </li>
          ))}
        </ul>
      </div>

      <h2>Now Playing</h2>
      {nowPlaying && (
        <div>
          {nowPlaying.trackName} by {nowPlaying.artists.join(', ')} 
        </div>
      )}

      <h2>Queue</h2>
      <ul>
        {queue.map((item, index) => (
          <li key={index}>
            {item.name} → {item.trackName || item.song} by {item.artists.join(', ')}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default App;