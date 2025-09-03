import { useState, useEffect } from 'react';
import { io } from 'socket.io-client';

const API_URL = process.env.REACT_APP_API_URL;

function App() {
  const [queue, setQueue] = useState([]);
  const [nowPlaying, setNowPlaying] = useState(null);
  const [role, setRole] = useState(null);
  const [name, setName] = useState('');
  const [sessionId, setSessionId] = useState(null);

  const socket = io(API_URL, { withCredentials: true });

  useEffect(() => {
    socket.on('queueUpdate', ({ queue, nowPlaying }) => {
      setQueue(queue);
      setNowPlaying(nowPlaying);
    });

    return () => socket.disconnect();
  }, []);

  const joinSession = async (roleSelected) => {
    try {
      const res = await fetch(`${API_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, role: roleSelected }),
        credentials: 'include',
      });
      const data = await res.json();
      setSessionId(data.sessionId);
      setRole(roleSelected);
    } catch (err) {
      console.error('Login error:', err);
    }
  };

  const addToQueue = async (songUri) => {
    try {
      const res = await fetch(`${API_URL}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, song: songUri }),
        credentials: 'include',
      });
      const data = await res.json();
      setQueue(data.queue);
      setNowPlaying(data.nowPlaying);
    } catch (err) {
      console.error('Queue error:', err);
    }
  };

  // Host controls
  const playNext = async () => {
    try {
      const res = await fetch(`${API_URL}/play`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      setNowPlaying(data.nowPlaying);
      setQueue(data.queue);
    } catch (err) {
      console.error('Next error:', err);
    }
  };

  const pausePlayback = async () => {
    try {
      await fetch(`${API_URL}/pause`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch (err) {
      console.error('Pause error:', err);
    }
  };

  const playPrevious = async () => {
    try {
      const res = await fetch(`${API_URL}/previous`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      setNowPlaying(data.nowPlaying);
      setQueue(data.queue);
    } catch (err) {
      console.error('Previous error:', err);
    }
  };

  return (
    <div style={{ padding: 20 }}>
      {!role ? (
        <div>
          <input
            type="text"
            placeholder="Enter your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button onClick={() => joinSession('host')}>Join as Host</button>
          <button onClick={() => joinSession('guest')}>Join as Guest</button>
        </div>
      ) : (
        <div>
          <h2>Now Playing:</h2>
          {nowPlaying ? (
            <div>
              <strong>{nowPlaying.trackName}</strong> by {nowPlaying.artists.join(', ')}
            </div>
          ) : (
            <p>No song playing</p>
          )}

          {role === 'host' && (
            <div style={{ marginBottom: 20, display: 'flex', gap: 10 }}>
              <button onClick={playPrevious}>⏮ Previous</button>
              <button onClick={pausePlayback}>⏸ Pause</button>
              <button onClick={playNext}>⏭ Next</button>
            </div>
          )}

          <h3>Queue:</h3>
          <ul>
            {queue.map((item, idx) => (
              <li key={idx}>
                {item.trackName} by {item.artists.join(', ')} (added by {item.name})
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default App;