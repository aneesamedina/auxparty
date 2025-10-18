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

  // <-- NEW: vote state -->
  const [skipVotes, setSkipVotes] = useState(0);
  const [nextVotes, setNextVotes] = useState({}); // trackUri -> vote count

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
  // NEW: Guest vote handlers
  // -------------------
  const voteSkip = () => {
    setSkipVotes((prev) => prev + 1);
  };

  const voteNext = (songUri) => {
    setNextVotes((prev) => ({ ...prev, [songUri]: (prev[songUri] || 0) + 1 }));
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

  const addSong = async (track, force = false) => {
    const guestName = name || draftName.trim();
    if (!guestName || !track) return alert('Enter your name first');

    try {
      const res = await fetch(`${API_URL}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: guestName, song: track.uri, force }),
        credentials: 'include',
      });

      if (!res.ok) {
        const data = await res.json();
        if (data.canForce) {
          if (window.confirm(`${data.error} Do you want to add it anyway?`)) {
            return addSong(track, true);
          }
        } else {
          return alert(data.error);
        }
      } else {
        const data = await res.json();
        setQueue(data.queue);
        setNowPlaying((prev) => prev || data.nowPlaying);
        setResults([]);
        setSearch('');
        if (!name) {
          setName(guestName);
          localStorage.setItem('guestName', guestName);
        }
      }
    } catch (err) {
      console.error('Error adding song:', err);
      alert('Failed to add song');
    }
  };
  
  const removeSong = async (songUri) => {
    try {
      const res = await fetch(`${API_URL}/queue/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ song: songUri }),
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      const data = await res.json();
      setQueue(data.queue);
    } catch (err) {
      console.error('Error removing song:', err);
    }
  };

  const handleDragEnd = (result) => {
    if (!result.destination) return;

    const newQueue = Array.from(queue);
    const [moved] = newQueue.splice(result.source.index, 1);
    newQueue.splice(result.destination.index, 0, moved);

    setQueue(newQueue);

    fetch(`${API_URL}/queue/reorder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queue: newQueue.map((item) => item.song) }),
    }).catch((err) => {
      console.error("Reorder failed:", err);
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
      {/* ...all previous styles, search UI, now playing, etc... */}
      <h2>Queue</h2>
      <DragDropContext onDragEnd={role === 'host' ? handleDragEnd : undefined}>
        <Droppable droppableId="queue">
          {(provided) => (
            <ul {...provided.droppableProps} ref={provided.innerRef}>
              {queue.map((item, index) => {
                return (
                  <li key={item.song} style={{ display: 'flex', alignItems: 'center', marginBottom: 10, gap: 10 }}>
                    <img
                      src={item.album?.images[0]?.url || ''}
                      alt={item.trackName || item.song}
                      style={{ width: 64, height: 64 }}
                    />
                    <div style={{ flex: 1 }}>
                      <div>{item.trackName || item.song} by {item.artists.join(', ')}</div>
                      <div style={{ fontSize: 12, color: '#555' }}>Added by {item.name}</div>
                    </div>

                    {/* <-- NEW: Guest vote buttons --> */}
                    {role === 'guest' && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <button className="queue-button guest-button" onClick={() => voteNext(item.song)}>
                          ⬆ Vote Next ({nextVotes[item.song] || 0})
                        </button>
                        {index === 0 && (
                          <button className="queue-button guest-button" onClick={voteSkip}>
                            ⏭ Vote Skip ({skipVotes})
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
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