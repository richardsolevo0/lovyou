import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || window.location.origin;
const socket = io(SERVER_URL, {
  autoConnect: false,
  withCredentials: true
});

function getInitialRoom() {
  const params = new URLSearchParams(window.location.search);
  let room = params.get("room");

  if (!room) {
    room = Math.random().toString(36).substring(2, 8);
    params.set("room", room);
    window.history.replaceState(null, "", `${window.location.pathname}?${params}`);
  }

  return room;
}

async function api(path, options = {}) {
  const res = await fetch(`${SERVER_URL}${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...options.headers
    },
    ...options
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.error || "Erreur serveur");
  }

  return data;
}

function AuthScreen({ onAuth }) {
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ username: "", password: "" });
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const title = mode === "login" ? "Connexion" : "Inscription";

  const submit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");

    try {
      const data = await api(`/api/${mode}`, {
        method: "POST",
        body: JSON.stringify(form)
      });
      onAuth(data.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <p className="eyebrow">Lovyou watch party</p>
        <h1>{title}</h1>

        <label>
          <span>Pseudo</span>
          <input
            value={form.username}
            onChange={(event) => setForm((prev) => ({ ...prev, username: event.target.value }))}
            minLength={2}
            maxLength={32}
            autoComplete="username"
            required
          />
        </label>

        <label>
          <span>Mot de passe</span>
          <input
            value={form.password}
            onChange={(event) => setForm((prev) => ({ ...prev, password: event.target.value }))}
            type="password"
            minLength={6}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            required
          />
        </label>

        {error && <p className="error-text">{error}</p>}

        <button type="submit" disabled={submitting}>
          {submitting ? "Patiente..." : title}
        </button>

        <button
          type="button"
          className="ghost-button"
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError("");
          }}
        >
          {mode === "login" ? "Creer un compte" : "J'ai deja un compte"}
        </button>
      </form>
    </main>
  );
}

function App() {
  const videoRef = useRef(null);
  const fileRef = useRef(null);
  const lastSyncRef = useRef(0);
  const remoteActionRef = useRef(false);

  const [authLoading, setAuthLoading] = useState(true);
  const [user, setUser] = useState(null);
  const [room] = useState(getInitialRoom);
  const [isHost, setIsHost] = useState(false);
  const [videoUrl, setVideoUrl] = useState("");
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [uploading, setUploading] = useState(false);
  const [, setNotice] = useState("");

  const roomLink = useMemo(() => window.location.href, []);

  const syncHostState = useCallback(() => {
    const video = videoRef.current;
    if (!isHost || !video || !video.src) return;

    socket.emit("update state", {
      room,
      time: video.currentTime,
      playing: !video.paused
    });
  }, [isHost, room]);

  useEffect(() => {
    api("/api/me")
      .then((data) => setUser(data.user))
      .catch(() => setUser(null))
      .finally(() => setAuthLoading(false));
  }, []);

  useEffect(() => {
    if (!user) {
      socket.disconnect();
      return;
    }

    const joinRoom = () => {
      socket.emit("join room", { room });
    };

    const handleConnectError = (error) => {
      setNotice(error.message || "Connexion temps reel impossible.");
    };

    socket.on("connect", joinRoom);
    socket.on("connect_error", handleConnectError);

    if (!socket.connected) {
      socket.connect();
    } else {
      joinRoom();
    }

    api(`/api/rooms/${room}/messages`)
      .then((data) => setMessages(data.messages || []))
      .catch((error) => setNotice(error.message));

    return () => {
      socket.off("connect", joinRoom);
      socket.off("connect_error", handleConnectError);
    };
  }, [room, user]);

  useEffect(() => {
    const runRemoteAction = (action) => {
      remoteActionRef.current = true;
      const result = action();

      if (result?.finally) {
        result.finally(() => {
          window.setTimeout(() => {
            remoteActionRef.current = false;
          }, 0);
        });
        return;
      }

      window.setTimeout(() => {
        remoteActionRef.current = false;
      }, 0);
    };

    const handleRole = ({ isHost: nextIsHost }) => {
      setIsHost(Boolean(nextIsHost));
      setNotice(nextIsHost ? "Tu controles la room." : "Tu regardes en synchro.");
    };

    const handleChatMessage = (msg) => {
      setMessages((prev) => [...prev, msg]);
    };

    const handleChangeVideo = (url) => {
      setVideoUrl(`${SERVER_URL}${url}`);
      setNotice("Nouvelle video chargee.");
    };

    const handleSyncState = ({ time = 0, playing = false, video = null }) => {
      if (video) {
        const nextUrl = `${SERVER_URL}${video}`;
        if (videoRef.current?.src !== nextUrl) {
          setVideoUrl(nextUrl);
        }
      }

      const player = videoRef.current;
      if (!player) return;

      lastSyncRef.current = Date.now();

      if (Number.isFinite(time)) {
        const drift = time - player.currentTime;
        const absoluteDrift = Math.abs(drift);

        if (absoluteDrift > 1.2) {
          runRemoteAction(() => {
            player.currentTime = time;
          });
          player.playbackRate = 1;
        } else if (playing && absoluteDrift > 0.25) {
          player.playbackRate = drift > 0 ? 1.04 : 0.96;
        } else {
          player.playbackRate = 1;
        }
      }

      if (playing && player.paused) {
        runRemoteAction(() =>
          player.play().catch(() => {
            setNotice("Lecture en attente d'un clic navigateur.");
          })
        );
      }

      if (!playing && !player.paused) {
        player.playbackRate = 1;
        runRemoteAction(() => {
          player.pause();
        });
      }
    };

    socket.on("role", handleRole);
    socket.on("chat message", handleChatMessage);
    socket.on("change video", handleChangeVideo);
    socket.on("sync state", handleSyncState);

    return () => {
      socket.off("role", handleRole);
      socket.off("chat message", handleChatMessage);
      socket.off("change video", handleChangeVideo);
      socket.off("sync state", handleSyncState);
    };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(syncHostState, 1000);
    return () => window.clearInterval(interval);
  }, [syncHostState]);

  const copyRoomLink = async () => {
    await navigator.clipboard.writeText(roomLink);
    setNotice("Lien de room copie.");
  };

  const logout = async () => {
    await api("/api/logout", { method: "POST" }).catch(() => {});
    socket.disconnect();
    setUser(null);
    setMessages([]);
    setVideoUrl("");
  };

  const sendMessage = (event) => {
    event.preventDefault();
    const text = input.trim();

    if (!text) return;

    socket.emit("chat message", { room, msg: text });
    setInput("");
  };

  const uploadVideo = async (event) => {
    const file = event.target.files?.[0];

    if (!isHost) {
      setNotice("Seul l'hote peut changer la video.");
      event.target.value = "";
      return;
    }

    if (!file) return;

    setUploading(true);
    setNotice("Upload en cours...");

    try {
      const formData = new FormData();
      formData.append("video", file);
      formData.append("room", room);

      const res = await fetch(`${SERVER_URL}/upload`, {
        method: "POST",
        credentials: "include",
        body: formData
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Upload impossible");
      }

      socket.emit("change video", { room, url: data.url });
      setNotice("Video envoyee a la room.");
    } catch (error) {
      setNotice(error.message || "Erreur lors de l'upload.");
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  };

  const handlePlay = () => {
    if (remoteActionRef.current) return;

    if (!isHost) {
      videoRef.current?.pause();
      setNotice("Seul l'hote controle la lecture.");
      return;
    }

    syncHostState();
  };

  const handlePause = () => {
    if (remoteActionRef.current) return;
    if (isHost) syncHostState();
  };

  const handleSeeked = () => {
    if (remoteActionRef.current) return;
    if (isHost) syncHostState();
  };

  if (authLoading) {
    return (
      <main className="auth-shell">
        <div className="auth-card">
          <p>Chargement...</p>
        </div>
      </main>
    );
  }

  if (!user) {
    return <AuthScreen onAuth={setUser} />;
  }

  return (
    <main className="app-shell">
      <section className="watch">
        <header className="topbar">
          <div>
            <p className="eyebrow">Lovyou watch party</p>
            <h1>Room {room}</h1>
          </div>

          <div className="topbar-actions">
            <span className="identity">{user.username}</span>
            <span className={`role ${isHost ? "host" : "viewer"}`}>
              {isHost ? "Host" : "Viewer"}
            </span>
            <button type="button" disabled={!isHost || uploading} onClick={() => fileRef.current?.click()}>
              {uploading ? "Upload..." : "Video"}
            </button>
            <button type="button" onClick={copyRoomLink}>
              Copier le lien
            </button>
            <button type="button" className="ghost-button compact" onClick={logout}>
              Deconnexion
            </button>
          </div>
        </header>

        <div className="player-frame">
          {videoUrl ? (
            <video
              ref={videoRef}
              controls={isHost}
              src={videoUrl}
              playsInline
              onPlay={handlePlay}
              onPause={handlePause}
              onSeeked={handleSeeked}
            />
          ) : (
            <div className="empty-player">
              <strong>Aucune video</strong>
              <span>{isHost ? "Ajoute une video pour lancer la room." : "En attente du host."}</span>
            </div>
          )}
        </div>
        <input ref={fileRef} type="file" accept="video/*" onChange={uploadVideo} hidden />
      </section>

      <aside className="chat-panel">
        <div className="messages">
          {messages.length === 0 ? (
            <p className="muted">Aucun message pour l'instant.</p>
          ) : (
            messages.map((message) => (
              <div className="message" key={message.id}>
                <span>
                  {message.author?.name || "Compte"}
                  {message.fromHost ? " - Host" : ""}
                </span>
                <p>{message.text}</p>
              </div>
            ))
          )}
        </div>

        <form className="chat-form" onSubmit={sendMessage}>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Ecris un message..."
            maxLength={400}
          />
          <button type="submit">Envoyer</button>
        </form>
      </aside>
    </main>
  );
}

export default App;
