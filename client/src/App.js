import { useState, useEffect } from 'react';

const API_URL = process.env.REACT_APP_API_URL;

function App() {
  const [queue, setQueue] = useState([]);
  const [name, setName] = useState('');
  const [song, setSong] = useState('');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState([]);

  // Poll queue every 3 seconds
  useEffect(() => {
    const fetchQueue = async () => {
      try {
        const res = await fetch(`${API_URL}/queue`, { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP error ${res.status}`);
        const data = await res.json();
        setQueue(Array.isArray(data) ? data : []);
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
      setQueue(Array.isArray(data.queue) ? data.queue : []);
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
      alert(data.message || "Played next song!");
    } catch (err) {
      console.error("Error playing next:", err);
    }
  };

  return (
    <div style={{ padding: 20 }}>
      <h1>Party Queue</h1>

      <div style={{ marginBottom: 20 }}>
        <a href={`${API_URL}/login`} target="_blank" rel="noreferrer">
          Host Login (Spotify)
        </a>
        <button onClick={playNext} style={{ marginLeft: 10 }}>Play Next</button>
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
          {results.map((track, idx) => {
            const artists = Array.isArray(track.artists)
              ? track.artists.map(a => (typeof a === 'string' ? a : a.name)).join(', ')
              : 'Unknown Artist';
            return (
              <li key={idx}>
                {track.name} - {artists}
                <button onClick={() => addSongToQueue(track)} style={{ marginLeft: 10 }}>Select</button>
              </li>
            );
          })}
        </ul>
      </div>

      <h2>Queue</h2>
      <ul>
        {queue.map((item, index) => {
          const artists = Array.isArray(item.artists) ? item.artists.join(', ') : item.artists || 'Unknown';
          return (
            <li key={index}>
              {item.name} → {item.trackName || item.song} by {artists}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default App;