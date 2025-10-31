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
        background: 'linear-gradient(135deg, #ff7518, #4b0082, #000000)',
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
        .guest-button { background-color: #646060ff; }
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
function MainQueueApp({ role, sessionId = null }) {
  const [queue, setQueue] = useState([]);
  const [name, setName] = useState(() => localStorage.getItem('guestName') || '');
  const [draftName, setDraftName] = useState('');
  const [song, setSong] = useState('');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState([]);
  const [nowPlaying, setNowPlaying] = useState(null);
  const [isPaused, setIsPaused] = useState(false);

  const [skipVotesCount, setSkipVotesCount] = useState({});
  const [playNextVotesCount, setPlayNextVotesCount] = useState({});

  const [skipMinVotes, setSkipMinVotes] = useState(2);
  const [playNextMinVotes, setPlayNextMinVotes] = useState(2);

  const normalizeNowPlaying = (np) => {
    if (!np) return null;
    return {
      trackName: np.trackName,
      artists: Array.isArray(np.artists) ? np.artists : [np.artists || 'Unknown Artist'],
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
  // Socket.IO
  // -------------------
  useEffect(() => {
    const socket = io(API_URL, { withCredentials: true });

    socket.on('queueUpdate', ({ queue, nowPlaying }) => {
      setQueue(queue);
      setNowPlaying(normalizeNowPlaying(nowPlaying));
    });

    socket.on('voteUpdate', ({ type, song, votes }) => {
      if (!song) return;
      if (type === 'skip') setSkipVotesCount(prev => ({ ...prev, [song]: votes }));
      if (type === 'playnext') setPlayNextVotesCount(prev => ({ ...prev, [song]: votes }));
    });

    socket.on('thresholdsUpdate', ({ skipMinVotes, playNextMinVotes }) => {
      if (skipMinVotes !== undefined) setSkipMinVotes(skipMinVotes);
      if (playNextMinVotes !== undefined) setPlayNextMinVotes(playNextMinVotes);
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
        if (data.canForce && window.confirm(`${data.error} Do you want to add it anyway?`)) {
          return addSong(track, true);
        } else {
          return alert(data.error);
        }
      } else {
        const data = await res.json();
        setQueue(data.queue);
        setNowPlaying(prev => prev || normalizeNowPlaying(data.nowPlaying));
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
    }).catch(err => {
      console.error("Reorder failed:", err);
      setQueue(queue);
    });
  };

  const voteSkip = async (songUri) => {
    if (!name) return alert('Enter your name first');
    try {
      const res = await fetch(`${API_URL}/vote/skip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: name, song: songUri }),
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) return alert(data.error);
      setSkipVotesCount(prev => ({ ...prev, [songUri]: data.votes }));
    } catch (err) {
      console.error('Vote skip error:', err);
    }
  };

  const votePlayNext = async (songUri) => {
    if (!name) return alert('Enter your name first');
    try {
      const res = await fetch(`${API_URL}/vote/playnext`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: name, song: songUri }),
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) return alert(data.error);
      setPlayNextVotesCount(prev => ({ ...prev, [songUri]: data.votes }));
    } catch (err) {
      console.error('Vote play-next error:', err);
    }
  };

  // -------------------
  // Render
  // -------------------
  return (
    <div style={{ minHeight: '100vh', padding: 20, background: 'linear-gradient(135deg, #ff7518, #4b0082, #000)', color: '#fff' }}>
      <h1>Aux Party - {role === 'guest' ? 'Guest' : 'Host'}</h1>

      {role === 'host' && (
        <>
          <div style={{ marginBottom: 20, display: 'flex', gap: 10 }}>
            <button onClick={playPrevious}>Previous</button>
            <button onClick={togglePause}>{isPaused ? '▶ Resume' : '⏸ Pause'}</button>
            <button onClick={playNext}>Next</button>
          </div>

          <div style={{ marginBottom: 20 }}>
            <h3>Vote Thresholds</h3>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <label>
                Skip Votes Needed:
                <input type="number" value={skipMinVotes} min={1} onChange={e => setSkipMinVotes(Number(e.target.value))} />
              </label>
              <label>
                Play Next Votes Needed:
                <input type="number" value={playNextMinVotes} min={1} onChange={e => setPlayNextMinVotes(Number(e.target.value))} />
              </label>
              <button onClick={async () => {
                if (!sessionId) return alert("Session ID missing!");
                try {
                  await fetch(`${API_URL}/host/set-votes`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId, skipThreshold: skipMinVotes, playNextThreshold: playNextMinVotes }),
                    credentials: 'include',
                  });
                  alert("Thresholds updated!");
                } catch (err) {
                  console.error(err);
                  alert("Failed to update thresholds");
                }
              }}>Update Thresholds</button>
            </div>
          </div>
        </>
      )}

      <div style={{ marginBottom: 20 }}>
        {!name && <input placeholder="Your Name" value={draftName} onChange={e => setDraftName(e.target.value)} />}
        {name && <span>👋 Welcome, {name}</span>}
      </div>

      <div style={{ marginBottom: 20 }}>
        <input placeholder="Search Spotify" value={search} onChange={e => setSearch(e.target.value)} />
        <button onClick={searchSong}>🔍 Search</button>
      </div>

      <ul>
        {results.map((track, idx) => (
          <li key={idx}>
            <img src={track.album?.images[0]?.url} alt={track.name} width={64} height={64} />
            <div>{track.name} by {(track.artists || []).join(', ')}</div>
            <button onClick={() => addSong(track)}>➕ Add to Queue</button>
          </li>
        ))}
      </ul>

      <h2>Now Playing</h2>
      {nowPlaying && (
        <div>
          <img src={nowPlaying.album?.images[0]?.url || ''} alt={nowPlaying.trackName} width={64} height={64} />
          <div>{nowPlaying.trackName} by {(nowPlaying.artists || []).join(', ')}</div>
          {nowPlaying.addedBy && <p>Added by {nowPlaying.addedBy}</p>}
        </div>
      )}

      <h2>Queue</h2>
      <DragDropContext onDragEnd={role === 'host' ? handleDragEnd : undefined}>
        <Droppable droppableId="queue">
          {(provided) => (
            <ul {...provided.droppableProps} ref={provided.innerRef}>
              {queue.map((item, index) => {
                const artists = item.artists || [];
                if (role === 'host') {
                  return (
                    <Draggable key={item.song} draggableId={item.song} index={index}>
                      {(provided) => (
                        <li ref={provided.innerRef} {...provided.draggableProps} {...provided.dragHandleProps}>
                          <img src={item.album?.images[0]?.url || ''} alt={item.trackName || item.song} width={64} height={64} />
                          <div>{item.trackName || item.song} by {artists.join(', ')}</div>
                          <div>Added by {item.name}</div>
                          <button onClick={() => removeSong(item.song)}>❌ Remove</button>
                        </li>
                      )}
                    </Draggable>
                  );
                } else {
                  return (
                    <li key={item.song}>
                      <img src={item.album?.images[0]?.url || ''} alt={item.trackName || item.song} width={64} height={64} />
                      <div>{item.trackName || item.song} by {artists.join(', ')}</div>
                      <div>Added by {item.name}</div>
                      <button onClick={() => voteSkip(item.song)}>⏭ Vote Skip ({skipVotesCount[item.song] || 0})</button>
                      <button onClick={() => votePlayNext(item.song)}>🔝 Vote Play Next ({playNextVotesCount[item.song] || 0})</button>
                    </li>
                  );
                }
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