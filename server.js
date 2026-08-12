'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');

const store = require('./db');
const SqliteSessionStore = require('./session-store');

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,20}$/;
const MIN_PASSWORD = 8;
const MAX_MESSAGE = 2000;
const HISTORY_PAGE = 50;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Behind a platform proxy (Render, Railway, Fly, nginx) this is what lets
// express know the original request was HTTPS, so secure cookies still work.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json({ limit: '32kb' }));

const sessionMiddleware = session({
  store: new SqliteSessionStore(),
  secret: store.getSessionSecret(),
  resave: false,
  saveUninitialized: false,
  name: 'chatroom.sid',
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: 30 * 24 * 60 * 60 * 1000, // stay signed in for a month
  },
});

app.use(sessionMiddleware);

/**
 * Same-origin guard for state-changing requests. A cross-site form post cannot
 * set Content-Type: application/json, so requiring it blocks the simple CSRF
 * cases that the SameSite cookie doesn't already cover.
 */
app.use((req, res, next) => {
  if (req.method === 'POST' && !req.is('application/json')) {
    return res.status(415).json({ error: 'Expected application/json.' });
  }
  next();
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/** Simple fixed-window counter, enough to keep a public link from being trivially abused. */
function createLimiter({ windowMs, max }) {
  const hits = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, windowMs).unref();

  return function take(key) {
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfterMs: 0 };
    }

    entry.count += 1;
    if (entry.count > max) {
      return { allowed: false, retryAfterMs: entry.resetAt - now };
    }
    return { allowed: true, retryAfterMs: 0 };
  };
}

const authLimiter = createLimiter({ windowMs: 15 * 60 * 1000, max: 20 });
const messageLimiter = createLimiter({ windowMs: 10 * 1000, max: 10 });

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------

function publicUser(user) {
  return { id: user.id, username: user.username };
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not signed in.' });
  next();
}

app.post('/api/register', async (req, res) => {
  if (!authLimiter(req.ip).allowed) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }

  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({
      error: 'Username must be 3-20 characters: letters, numbers, hyphens or underscores.',
    });
  }
  if (password.length < MIN_PASSWORD) {
    return res
      .status(400)
      .json({ error: `Password must be at least ${MIN_PASSWORD} characters.` });
  }
  if (store.findUserByUsername(username)) {
    return res.status(409).json({ error: 'That username is taken.' });
  }

  const passwordHash = await bcrypt.hash(password, 12);

  let user;
  try {
    user = store.createUser(username, passwordHash);
  } catch (err) {
    // The UNIQUE index is the real arbiter if two people register at once.
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'That username is taken.' });
    }
    throw err;
  }

  req.session.userId = user.id;
  res.status(201).json({ user: publicUser(user) });
});

app.post('/api/login', async (req, res) => {
  if (!authLimiter(req.ip).allowed) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }

  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  const user = store.findUserByUsername(username);
  // Hash against a dummy value when the user is missing so both branches take
  // about the same time and don't leak which usernames exist.
  const hash = user ? user.password_hash : '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const ok = await bcrypt.compare(password, hash);

  if (!user || !ok) {
    return res.status(401).json({ error: 'Wrong username or password.' });
  }

  req.session.userId = user.id;
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('chatroom.sid');
    res.json({ ok: true });
  });
});

app.get('/api/me', (req, res) => {
  const user = req.session.userId ? store.findUserById(req.session.userId) : null;
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  res.json({ user: publicUser(user) });
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

app.get('/api/messages', requireAuth, (req, res) => {
  const before = req.query.before ? Number(req.query.before) : null;
  const after = req.query.after ? Number(req.query.after) : null;

  if ((before !== null && !Number.isInteger(before)) || (after !== null && !Number.isInteger(after))) {
    return res.status(400).json({ error: 'Invalid cursor.' });
  }

  // `after` walks forward to fill a reconnect gap, so cap it higher.
  const limit = after !== null ? 200 : HISTORY_PAGE;
  const messages = store.getMessages({ before, after, limit });

  res.json({
    messages,
    // If we filled the page there is probably more history behind it.
    hasMore: after !== null ? false : messages.length === HISTORY_PAGE,
  });
});

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

// Sockets reuse the HTTP session, so a socket is authenticated exactly when the
// browser is.
io.engine.use(sessionMiddleware);

/** userId -> { username, sockets } so multiple tabs count as one person online. */
const presence = new Map();

function onlineUsernames() {
  return [...presence.values()].map((entry) => entry.username).sort((a, b) => a.localeCompare(b));
}

function broadcastPresence() {
  io.emit('presence', { users: onlineUsernames() });
}

io.use((socket, next) => {
  const userId = socket.request.session && socket.request.session.userId;
  const user = userId ? store.findUserById(userId) : null;

  if (!user) return next(new Error('unauthorized'));

  socket.data.user = user;
  next();
});

io.on('connection', (socket) => {
  const user = socket.data.user;

  const entry = presence.get(user.id) || { username: user.username, sockets: 0 };
  entry.sockets += 1;
  presence.set(user.id, entry);

  if (entry.sockets === 1) {
    socket.broadcast.emit('system', { text: `${user.username} joined`, at: Date.now() });
  }
  broadcastPresence();

  socket.on('message', (payload, ack) => {
    const body = typeof payload === 'string' ? payload : payload && payload.body;

    if (typeof body !== 'string' || !body.trim()) {
      if (typeof ack === 'function') ack({ error: 'Message is empty.' });
      return;
    }

    const trimmed = body.trim().slice(0, MAX_MESSAGE);

    if (!messageLimiter(`u:${user.id}`).allowed) {
      if (typeof ack === 'function') ack({ error: 'Slow down a moment.' });
      return;
    }

    const saved = store.addMessage(user.id, trimmed);
    const message = {
      id: saved.id,
      body: saved.body,
      createdAt: saved.createdAt,
      userId: user.id,
      username: user.username,
    };

    io.emit('message', message);
    if (typeof ack === 'function') ack({ ok: true, id: message.id });
  });

  socket.on('disconnect', () => {
    const current = presence.get(user.id);
    if (!current) return;

    current.sockets -= 1;
    if (current.sockets <= 0) {
      presence.delete(user.id);
      socket.broadcast.emit('system', { text: `${user.username} left`, at: Date.now() });
    }
    broadcastPresence();
  });
});

server.listen(PORT, () => {
  console.log(`Chat room listening on http://localhost:${PORT}`);
});
