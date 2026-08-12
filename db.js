'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

// Everything lives in one directory so a host only has to persist one volume.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'chat.db'));

// WAL keeps reads fast while a write is in flight, which is most of what a
// chat room does.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL,
    username_key  TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_id_desc ON messages (id DESC);

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

/**
 * The session secret has to outlive restarts, otherwise everyone is logged out
 * every deploy. Prefer the env var; fall back to a generated one we keep in the
 * database.
 */
function getSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;

  const existing = db.prepare('SELECT value FROM meta WHERE key = ?').get('session_secret');
  if (existing) return existing.value;

  const generated = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('session_secret', generated);
  return generated;
}

const statements = {
  createUser: db.prepare(
    'INSERT INTO users (username, username_key, password_hash, created_at) VALUES (?, ?, ?, ?)'
  ),
  findUserByKey: db.prepare('SELECT * FROM users WHERE username_key = ?'),
  findUserById: db.prepare('SELECT id, username, created_at FROM users WHERE id = ?'),
  insertMessage: db.prepare(
    'INSERT INTO messages (user_id, body, created_at) VALUES (?, ?, ?)'
  ),
  recentMessages: db.prepare(`
    SELECT m.id, m.body, m.created_at, m.user_id, u.username
    FROM messages m JOIN users u ON u.id = m.user_id
    ORDER BY m.id DESC
    LIMIT ?
  `),
  messagesBefore: db.prepare(`
    SELECT m.id, m.body, m.created_at, m.user_id, u.username
    FROM messages m JOIN users u ON u.id = m.user_id
    WHERE m.id < ?
    ORDER BY m.id DESC
    LIMIT ?
  `),
  messagesAfter: db.prepare(`
    SELECT m.id, m.body, m.created_at, m.user_id, u.username
    FROM messages m JOIN users u ON u.id = m.user_id
    WHERE m.id > ?
    ORDER BY m.id ASC
    LIMIT ?
  `),
};

/** Case-insensitive uniqueness: "Alice" and "alice" are the same account. */
function usernameKey(username) {
  return username.trim().toLowerCase();
}

function createUser(username, passwordHash) {
  const info = statements.createUser.run(
    username.trim(),
    usernameKey(username),
    passwordHash,
    Date.now()
  );
  return statements.findUserById.get(info.lastInsertRowid);
}

function findUserByUsername(username) {
  return statements.findUserByKey.get(usernameKey(username));
}

function findUserById(id) {
  return statements.findUserById.get(id);
}

function addMessage(userId, body) {
  const createdAt = Date.now();
  const info = statements.insertMessage.run(userId, body, createdAt);
  return { id: info.lastInsertRowid, userId, body, createdAt };
}

/**
 * Returns messages oldest-first so the client can append them straight down the
 * page. `before` pages backwards through history; `after` fetches the gap a
 * client missed while it was disconnected.
 */
function getMessages({ before = null, after = null, limit = 50 } = {}) {
  let rows;
  if (after !== null) {
    rows = statements.messagesAfter.all(after, limit);
  } else if (before !== null) {
    rows = statements.messagesBefore.all(before, limit).reverse();
  } else {
    rows = statements.recentMessages.all(limit).reverse();
  }

  return rows.map((row) => ({
    id: row.id,
    body: row.body,
    createdAt: row.created_at,
    userId: row.user_id,
    username: row.username,
  }));
}

module.exports = {
  db,
  getSessionSecret,
  createUser,
  findUserByUsername,
  findUserById,
  addMessage,
  getMessages,
  DATA_DIR,
};
