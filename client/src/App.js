import { useState, useEffect } from 'react';
import { io } from 'socket.io-client';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';


const API_URL = process.env.REACT_APP_API_URL;

// -------------------
// Login Page Component
// -------------------
function LoginPage({ onSelectRole }) {
  const handleHostLogin = () => {
  window.location.href = `${API_URL}/login`;
  };

  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        textAlign: 'center',
        padding: 40,
        background: 'linear-gradient(135deg, #a55a88ff, #1dd1a1, #458ed3ff)',
        backgroundSize: '400% 400%',
        animation: 'gradientAnimation 15s ease infinite',
        color: '#fff',
      }}
    >
      <h1>Welcome to Aux Party</h1>
      <p>Select your role to continue:</p>
      <div style={{ marginTop: 40, display: 'flex', flexDirection: 'column', gap: 20 }}>
        <button className="role-button host-button" onClick={handleHostLogin}>
          Host (Spotify)
        </button>
        <button className="role-button guest-button" onClick={() => onSelectRole('guest')}>
          Guest
        </button>
      </div>
      <style>{`
        @keyframes gradientAnimation {
          0%{background-position:0% 50%}
          50%{background-position:100% 50%}
          100%{background-position:0% 50%}
        }
        .role-button {
          padding: 15px 30px;
          font-size: 20px;
          border-radius: 8px;
          cursor: pointer;
          border: none;
          color: #fff;
          transition: all 0.3s ease;
        }
        .host-button { background-color: #aaaaaaff; }
        .guest-button { background-color: #303030ff; }
        .role-button:hover {
          box-shadow: 0 0 15px rgba(255, 255, 255, 0.6);
          transform: scale(1.05);
        }
      `}</style>
    </div>
  );
}



function HostPage() {
  const [sessionId, setSessionId] = useState(null);

  useEffect(() => {
    // Extract sessionId from URL
    const params = new URLSearchParams(window.location.search);
    const sid = params.get('sessionId');
    if (sid) setSessionId(sid);
  }, []);

  if (!sessionId) {
    return <div>Waiting for Spotify login...</div>;
  }

  return <MainQueueApp role="host" sessionId={sessionId} />;
}

// -------------------
// Main Queue App Component
// -------------------
function MainQueueApp({ role }) {
  const [queue, setQueue] = useState([]);
  const [name, setName] = useState(() => localStorage.getItem('guestName') || '');
  const [draftName, setDraftName] = useState('');
  const [song, setSong] = useState('');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState([]);
  const [nowPlaying, setNowPlaying] = useState(null);
  const [isPaused, setIsPaused] = useState(false);

  const normalizeNowPlaying = (np) => {
    if (!np) return null;
    return {
      trackName: np.trackName,
      artists: Array.isArray(np.artists) ? np.artists : [np.artists],
      addedBy: np.addedBy || '',
      album: np.album,
    };
  };

  // -------------------
  // Playback Controls
  // -------------------
  const playPrevious = async () => {
    try {
      const res = await fetch(`${API_URL}/host/previous`, { method: 'POST', credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      const data = await res.json();
      setNowPlaying(normalizeNowPlaying(data.nowPlaying));
      if (data.queue) setQueue(data.queue);
    } catch (err) {
      console.error('Error playing previous:', err);
      alert('No previous track available or failed to skip.');
    }
  };
  
  const togglePause = async () => {
    try {
      const res = await fetch(`${API_URL}/host/pause`, { method: 'POST', credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      const data = await res.json();
      setIsPaused(!data.isPlaying);
    } catch (err) {
      console.error('Error toggling pause:', err);
    }
  };

  const playNext = async () => {
    try {
      const res = await fetch(`${API_URL}/play`, { method: 'POST', credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      const data = await res.json();
      setNowPlaying(normalizeNowPlaying(data.nowPlaying));
      setQueue(data.queue);
      setIsPaused(false);
    } catch (err) {
      console.error('Error playing next:', err);
    }
  };

  // -------------------
  // Socket.IO for real-time updates
  // -------------------
  useEffect(() => {
    const socket = io(API_URL, { withCredentials: true });
    socket.on('queueUpdate', ({ queue, nowPlaying }) => {
      setQueue(queue);
      setNowPlaying(normalizeNowPlaying(nowPlaying));
    });
    return () => socket.disconnect();
  }, []);

  // -------------------
  // Polling fallback
  // -------------------
  useEffect(() => {
    const fetchQueue = async () => {
      try {
        const res = await fetch(`${API_URL}/queue`, { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP error ${res.status}`);
        const data = await res.json();
        setQueue(JSON.stringify(queue) !== JSON.stringify(data.queue) ? data.queue : queue);
        setNowPlaying(
          JSON.stringify(nowPlaying) !== JSON.stringify(data.nowPlaying)
            ? normalizeNowPlaying(data.nowPlaying)
            : nowPlaying
        );
      } catch (err) {
        console.error('Error fetching queue:', err);
      }
    };
    fetchQueue();
    const interval = setInterval(fetchQueue, 3000);
    return () => clearInterval(interval);
  }, [queue, nowPlaying]);

  // -------------------
  // Search & Add Songs
  // -------------------
  const searchSong = async () => {
    if (!search) return;
    try {
      const res = await fetch(`${API_URL}/search?q=${encodeURIComponent(search)}`, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      const data = await res.json();
      setResults(Array.isArray(data.tracks) ? data.tracks : []);
    } catch (err) {
      console.error('Error searching:', err);
    }
  };

  const addSong = async (track) => {
    const guestName = name || draftName.trim();
    if (!guestName || !track) return alert('Enter your name first');
    try {
      const res = await fetch(`${API_URL}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: guestName, song: track.uri }),
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      const data = await res.json();
      setQueue(data.queue);
      setNowPlaying((prev) => prev || data.nowPlaying);
      setResults([]);
      setSearch('');
      if (!name) {
        setName(guestName);
        localStorage.setItem('guestName', guestName);
      }
    } catch (err) {
      console.error('Error adding song:', err);
    }
  };
  
  const handleDragEnd = (result) => {
    if (!result.destination) return;

    const newQueue = Array.from(queue);
    const [moved] = newQueue.splice(result.source.index, 1);
    newQueue.splice(result.destination.index, 0, moved);

    // 🔹 Optimistically update UI
    setQueue(newQueue);

    // 🔹 Send update to server
    fetch(`${API_URL}/queue/reorder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queue: newQueue.map((item) => item.song) }),
    }).catch((err) => {
      console.error("Reorder failed:", err);
      // Optional: rollback if server fails
      setQueue(queue);
    });
  };

  // -------------------
  // Render
  // -------------------
  return (
    <div
      style={{
        minHeight: '100vh',
        padding: 20,
        background: 'linear-gradient(135deg, #a55a88ff, #1dd1a1, #458ed3ff)',
        backgroundSize: '400% 400%',
        animation: 'gradientAnimation 15s ease infinite',
        color: '#fff',
      }}
    >
      <style>{`
        @keyframes gradientAnimation {
          0%{background-position:0% 50%}
          50%{background-position:100% 50%}
          100%{background-position:0% 50%}
        }
        .queue-button, .role-button {
          padding: 8px 20px;
          font-size: 16px;
          border-radius: 12px;
          border: none;
          cursor: pointer;
          color: #fff;
          transition: all 0.2s ease;
        }
        .queue-button:hover, .role-button:hover {
          transform: scale(1.05);
          box-shadow: 0 0 15px rgba(255,255,255,0.6);
          filter: brightness(1.1);
        }
        .host-button { background-color: #aaaaaaff; }
        .guest-button { background-color: #303030ff; }
        .song-input {
          padding: 8px 12px;
          font-size: 16px;
          border-radius: 8px;
          border: none;
          margin-right: 8px;
        }
        .song-item {
          display: flex;
          align-items: center;
          margin-bottom: 10px;
          gap: 10px;
        }
        .song-item img {
          width: 64px;
          height: 64px;
          border-radius: 8px;
        }
        .song-info {
          display: flex;
          flex-direction: column;
        }
        .song-info .title { font-weight: bold; font-size: 16px; }
        .song-info .artists, .song-info .added-by { font-size: 12px; color: #eee; }
      `}</style>

      <h1>Aux Party - {role === 'guest' ? 'Guest' : 'Host'}</h1>

      {role === 'host' && (
        <div style={{ marginBottom: 20, display: 'flex', gap: 10 }}>
          <button className="queue-button host-button" onClick={playPrevious}>Previous</button>
          <button className="queue-button host-button" onClick={togglePause}>
            {isPaused ? '▶ Resume' : '⏸ Pause'}
          </button>
          <button className="queue-button host-button" onClick={playNext}>Next</button>
        </div>
      )}

      <div style={{ marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
        {!name && <input className="song-input" placeholder="Your Name" value={draftName} onChange={(e) => setDraftName(e.target.value)} />}
        {name && <span>👋 Welcome, {name}</span>}
      </div>

      <div style={{ marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
        <input className="song-input" placeholder="Search Spotify" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className="queue-button host-button" onClick={searchSong}>🔍 Search</button>
      </div>

      <ul>
        {results.map((track, idx) => (
          <li key={idx} className="song-item">
            <img src={track.album?.images[0]?.url} alt={track.name} />
            <div className="song-info">
              <div className="title">{track.name}</div>
              <div className="artists">{track.artists.join(', ')}</div>
            </div>
            <button className="queue-button host-button" onClick={() => addSong(track)}>➕ Add to Queue</button>
          </li>
        ))}
      </ul>

      <h2>Now Playing</h2>
      {nowPlaying && (
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
          <img src={nowPlaying.album?.images[0]?.url || ''} alt={nowPlaying.trackName} style={{ width: 64, height: 64, marginRight: 10 }} />
          <div>
            <div>{nowPlaying.trackName}</div>
            <div style={{ fontSize: 12, color: '#555' }}>
              {nowPlaying.artists.join(', ')}
              {nowPlaying.addedBy && <p>Added by {nowPlaying.addedBy}</p>}
            </div>
          </div>
        </div>
      )}

      <h2>Queue</h2>
      DragDropContext onDragEnd={role === 'host' ? handleDragEnd : undefined}>
        <Droppable droppableId="queue">
          {(provided) => (
            <ul {...provided.droppableProps} ref={provided.innerRef}>
              {queue.map((item, index) => (
                role === 'host' ? (
                  <Draggable key={item.song} draggableId={item.song} index={index}>
                    {(provided) => (
                      <li
                        ref={provided.innerRef}
                        {...provided.draggableProps}
                        {...provided.dragHandleProps}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          marginBottom: 10,
                          ...provided.draggableProps.style
                        }}
                      >
                        <img
                          src={item.album?.images[0]?.url || ''}
                          alt={item.trackName || item.song}
                          style={{ width: 64, height: 64, marginRight: 10 }}
                        />
                        <div>
                          <div>{item.trackName || item.song} by {item.artists.join(', ')}</div>
                          <div style={{ fontSize: 12, color: '#555' }}>Added by {item.name}</div>
                        </div>
                      </li>
                    )}
                  </Draggable>
                ) : (
                  <li key={item.song} style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
                    <img
                      src={item.album?.images[0]?.url || ''}
                      alt={item.trackName || item.song}
                      style={{ width: 64, height: 64, marginRight: 10 }}
                    />
                    <div>
                      <div>{item.trackName || item.song} by {item.artists.join(', ')}</div>
                      <div style={{ fontSize: 12, color: '#555' }}>Added by {item.name}</div>
                    </div>
                  </li>
                )
              ))}
              {provided.placeholder}
            </ul>
          )}
        </Droppable>
      </DragDropContext>
    </div>
  );
}

// -------------------
// Main App Component
// -------------------
function App() {
  const [role, setRole] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('sessionId')) {
      setRole('host');
    }
  }, []);

  if (!role) return <LoginPage onSelectRole={setRole} />;
  if (role === 'host') return <HostPage />;
  return <MainQueueApp role="guest" />;
}

export default App;