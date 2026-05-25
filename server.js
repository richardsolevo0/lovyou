const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const cors = require("cors");
const { DatabaseSync } = require("node:sqlite");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const isProduction = process.env.NODE_ENV === "production";
const cookieSecure = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE === "true"
  : isProduction;

if (isProduction) {
  app.set("trust proxy", 1);
}

const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true,
    methods: ["GET", "POST"]
  }
});

const PORT = Number(process.env.PORT) || 3000;
const publicDir = path.join(__dirname, "public");
const frontendDistDir = path.join(__dirname, "frontend", "dist");
function resolveStorageDir(value, fallback) {
  if (!value) return fallback;
  return path.isAbsolute(value) ? value : path.join(__dirname, value);
}

const dataDir = resolveStorageDir(process.env.DATA_DIR, path.join(__dirname, "data"));
const videosDir = resolveStorageDir(
  process.env.VIDEOS_DIR || process.env.UPLOADS_DIR,
  path.join(publicDir, "videos")
);
const dbPath = path.join(dataDir, "lovyou.sqlite");
const sessionMaxAgeMs = 1000 * 60 * 60 * 24 * 14;

fs.mkdirSync(videosDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    url TEXT NOT NULL,
    original_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

const statements = {
  createUser: db.prepare(
    "INSERT INTO users (id, username, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)"
  ),
  getUserByUsername: db.prepare("SELECT * FROM users WHERE lower(username) = lower(?)"),
  getUserById: db.prepare("SELECT id, username, created_at FROM users WHERE id = ?"),
  createSession: db.prepare(
    "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
  ),
  getSession: db.prepare(`
    SELECT sessions.id AS session_id, sessions.expires_at, users.id, users.username, users.created_at
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.id = ?
  `),
  deleteSession: db.prepare("DELETE FROM sessions WHERE id = ?"),
  ensureRoom: db.prepare(
    "INSERT OR IGNORE INTO rooms (id, name, created_by, created_at) VALUES (?, ?, ?, ?)"
  ),
  getRoomByName: db.prepare("SELECT * FROM rooms WHERE name = ?"),
  createMessage: db.prepare(
    "INSERT INTO messages (id, room_id, user_id, text, created_at) VALUES (?, ?, ?, ?, ?)"
  ),
  listMessages: db.prepare(`
    SELECT messages.id, messages.text, messages.created_at, users.id AS user_id, users.username
    FROM messages
    JOIN users ON users.id = messages.user_id
    WHERE messages.room_id = ?
    ORDER BY messages.created_at ASC
    LIMIT 100
  `),
  createVideo: db.prepare(
    "INSERT INTO videos (id, room_id, user_id, url, original_name, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
};

app.use(
  cors({
    origin: true,
    credentials: true
  })
);
app.use(express.json({ limit: "1mb" }));
app.use("/videos", express.static(videosDir));

function now() {
  return Date.now();
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(18).toString("hex")}`;
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username
  };
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index === -1) return [part, ""];
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function setSessionCookie(res, sessionId) {
  res.cookie("lovyou_session", sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure,
    maxAge: sessionMaxAgeMs,
    path: "/"
  });
}

function clearSessionCookie(res) {
  res.clearCookie("lovyou_session", {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure,
    path: "/"
  });
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, user) {
  const { hash } = hashPassword(password, user.password_salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.password_hash, "hex"));
}

function sanitizeUsername(username) {
  return String(username || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 32);
}

function sanitizeRoomName(room) {
  return String(room || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 80);
}

function getUserFromSessionId(sessionId) {
  if (!sessionId) return null;

  const session = statements.getSession.get(sessionId);
  if (!session) return null;

  if (session.expires_at < now()) {
    statements.deleteSession.run(sessionId);
    return null;
  }

  return {
    id: session.id,
    username: session.username,
    created_at: session.created_at,
    sessionId: session.session_id
  };
}

function getUserFromRequest(req) {
  return getUserFromSessionId(parseCookies(req.headers.cookie).lovyou_session);
}

function requireAuth(req, res, next) {
  const user = getUserFromRequest(req);

  if (!user) {
    return res.status(401).json({ error: "Connexion requise" });
  }

  req.user = user;
  next();
}

function createSession(res, userId) {
  const sessionId = randomId("sess");
  statements.createSession.run(sessionId, userId, now() + sessionMaxAgeMs, now());
  setSessionCookie(res, sessionId);
}

function ensureRoom(name, userId) {
  const roomName = sanitizeRoomName(name);
  if (!roomName) return null;

  const roomId = `room_${roomName.toLowerCase()}`;
  statements.ensureRoom.run(roomId, roomName, userId || null, now());
  return statements.getRoomByName.get(roomName);
}

function formatMessage(message, hostUserId) {
  return {
    id: message.id,
    text: message.text,
    at: message.created_at,
    author: {
      id: message.user_id,
      name: message.username
    },
    fromHost: hostUserId === message.user_id
  };
}

app.get("/api/me", (req, res) => {
  res.json({ user: publicUser(getUserFromRequest(req)) });
});

app.post("/api/register", (req, res) => {
  const username = sanitizeUsername(req.body.username);
  const password = String(req.body.password || "");

  if (username.length < 2) {
    return res.status(400).json({ error: "Pseudo trop court" });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: "Mot de passe trop court" });
  }

  if (statements.getUserByUsername.get(username)) {
    return res.status(409).json({ error: "Ce pseudo existe deja" });
  }

  const userId = randomId("user");
  const passwordData = hashPassword(password);
  statements.createUser.run(userId, username, passwordData.hash, passwordData.salt, now());
  createSession(res, userId);

  res.status(201).json({ user: publicUser(statements.getUserById.get(userId)) });
});

app.post("/api/login", (req, res) => {
  const username = sanitizeUsername(req.body.username);
  const password = String(req.body.password || "");
  const user = statements.getUserByUsername.get(username);

  if (!user || !verifyPassword(password, user)) {
    return res.status(401).json({ error: "Identifiants invalides" });
  }

  createSession(res, user.id);
  res.json({ user: publicUser(user) });
});

app.post("/api/logout", requireAuth, (req, res) => {
  if (req.user.sessionId) {
    statements.deleteSession.run(req.user.sessionId);
  }

  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/rooms/:room/messages", requireAuth, (req, res) => {
  const room = ensureRoom(req.params.room, req.user.id);
  if (!room) return res.status(400).json({ error: "Room invalide" });

  const hostUserId = rooms[room.name]?.hostUserId;
  const messages = statements.listMessages.all(room.id).map((message) => formatMessage(message, hostUserId));
  res.json({ messages });
});

const storage = multer.diskStorage({
  destination: videosDir,
  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname);
    const basename = path
      .basename(file.originalname, extension)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9-_]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);

    cb(null, `${Date.now()}-${basename || "video"}${extension}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    cb(null, file.mimetype.startsWith("video/"));
  },
  limits: {
    fileSize: 1024 * 1024 * 1024
  }
});

app.post("/upload", requireAuth, (req, res) => {
  upload.single("video")(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: "Upload impossible" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "Aucune video recue" });
    }

    const room = ensureRoom(req.body.room, req.user.id);
    const videoUrl = `/videos/${req.file.filename}`;

    if (room) {
      statements.createVideo.run(
        randomId("video"),
        room.id,
        req.user.id,
        videoUrl,
        req.file.originalname,
        now()
      );
    }

    res.json({ url: videoUrl });
  });
});

const rooms = {};

function createRoom(hostSocketId, hostUserId) {
  return {
    host: hostSocketId,
    hostUserId,
    time: 0,
    playing: false,
    video: null,
    users: {}
  };
}

function emitParticipants(room) {
  const state = rooms[room];
  if (!state) return;

  const participants = Object.entries(state.users).map(([socketId, user]) => ({
    socketId,
    id: user.id,
    name: user.username,
    isHost: state.host === socketId
  }));

  io.to(room).emit("participants", participants);
}

function emitRole(room) {
  const state = rooms[room];
  if (!state) return;

  io.to(room).emit("host changed", state.host);
  io.to(state.host).emit("role", { isHost: true });
  emitParticipants(room);
}

io.use((socket, next) => {
  const user = getUserFromSessionId(parseCookies(socket.handshake.headers.cookie).lovyou_session);

  if (!user) {
    return next(new Error("Connexion requise"));
  }

  socket.data.user = user;
  next();
});

io.on("connection", (socket) => {
  console.log("User connected:", socket.data.user.username, socket.id);

  socket.on("join room", (payload) => {
    const roomName = sanitizeRoomName(typeof payload === "object" ? payload.room : payload);
    if (!roomName) return;

    const room = ensureRoom(roomName, socket.data.user.id);
    socket.join(room.name);
    socket.data.room = room.name;
    console.log("Joined room:", room.name);

    if (!rooms[room.name]) {
      rooms[room.name] = createRoom(socket.id, socket.data.user.id);
    }

    rooms[room.name].users[socket.id] = socket.data.user;

    socket.emit("role", {
      isHost: rooms[room.name].host === socket.id
    });

    socket.emit("sync state", rooms[room.name]);
    emitParticipants(room.name);
  });

  socket.on("chat message", ({ room, msg }) => {
    const roomName = sanitizeRoomName(room);
    const text = String(msg || "").trim().slice(0, 1000);
    const state = rooms[roomName];

    if (!roomName || !text || !state?.users[socket.id]) return;

    const persistedRoom = ensureRoom(roomName, socket.data.user.id);
    const message = {
      id: randomId("msg"),
      room_id: persistedRoom.id,
      user_id: socket.data.user.id,
      username: socket.data.user.username,
      text,
      created_at: now()
    };

    statements.createMessage.run(message.id, message.room_id, message.user_id, message.text, message.created_at);
    io.to(roomName).emit("chat message", formatMessage(message, state.hostUserId));
  });

  socket.on("update state", ({ room, time, playing }) => {
    const roomName = sanitizeRoomName(room);
    const state = rooms[roomName];

    if (!state || state.host !== socket.id) return;

    state.time = Number.isFinite(time) ? time : state.time;
    state.playing = Boolean(playing);

    socket.to(roomName).emit("sync state", state);
  });

  socket.on("change video", ({ room, url }) => {
    const roomName = sanitizeRoomName(room);
    const state = rooms[roomName];

    if (!state || state.host !== socket.id || typeof url !== "string") return;

    state.video = url;
    state.time = 0;
    state.playing = false;

    io.to(roomName).emit("change video", url);
    io.to(roomName).emit("sync state", state);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.data.user?.username, socket.id);

    for (const room of Object.keys(rooms)) {
      const state = rooms[room];
      delete state.users[socket.id];

      if (state.host !== socket.id) {
        emitParticipants(room);
        continue;
      }

      const clients = io.sockets.adapter.rooms.get(room);

      if (clients && clients.size > 0) {
        const newHost = [...clients][0];
        state.host = newHost;
        state.hostUserId = state.users[newHost]?.id;
        console.log("New host:", newHost);
        emitRole(room);
      } else {
        delete rooms[room];
      }
    }
  });
});

if (fs.existsSync(frontendDistDir)) {
  app.use(express.static(frontendDistDir));
}

app.use(express.static(publicDir));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
