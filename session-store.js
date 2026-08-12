'use strict';

const session = require('express-session');
const { db } = require('./db');

const PRUNE_INTERVAL_MS = 15 * 60 * 1000;

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid     TEXT PRIMARY KEY,
    expires INTEGER NOT NULL,
    data    TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires);
`);

const statements = {
  get: db.prepare('SELECT data, expires FROM sessions WHERE sid = ?'),
  set: db.prepare(`
    INSERT INTO sessions (sid, expires, data) VALUES (@sid, @expires, @data)
    ON CONFLICT(sid) DO UPDATE SET expires = @expires, data = @data
  `),
  touch: db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?'),
  destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
  prune: db.prepare('DELETE FROM sessions WHERE expires <= ?'),
  all: db.prepare('SELECT sid, data FROM sessions WHERE expires > ?'),
  count: db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires > ?'),
  clear: db.prepare('DELETE FROM sessions'),
};

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function expiryOf(sess) {
  if (sess && sess.cookie && sess.cookie.expires) {
    return new Date(sess.cookie.expires).getTime();
  }
  return Date.now() + DEFAULT_TTL_MS;
}

/**
 * Sessions in the same SQLite file as everything else, so a deploy only has to
 * persist one directory and people stay signed in across restarts.
 */
class SqliteSessionStore extends session.Store {
  constructor() {
    super();

    const timer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    timer.unref();
    this.prune();
  }

  prune() {
    statements.prune.run(Date.now());
  }

  get(sid, callback) {
    try {
      const row = statements.get.get(sid);
      if (!row) return callback(null, null);

      if (row.expires <= Date.now()) {
        statements.destroy.run(sid);
        return callback(null, null);
      }
      return callback(null, JSON.parse(row.data));
    } catch (err) {
      return callback(err);
    }
  }

  set(sid, sess, callback = () => {}) {
    try {
      statements.set.run({ sid, expires: expiryOf(sess), data: JSON.stringify(sess) });
      return callback(null);
    } catch (err) {
      return callback(err);
    }
  }

  touch(sid, sess, callback = () => {}) {
    try {
      statements.touch.run(expiryOf(sess), sid);
      return callback(null);
    } catch (err) {
      return callback(err);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      statements.destroy.run(sid);
      return callback(null);
    } catch (err) {
      return callback(err);
    }
  }

  length(callback) {
    try {
      return callback(null, statements.count.get(Date.now()).n);
    } catch (err) {
      return callback(err);
    }
  }

  all(callback) {
    try {
      const rows = statements.all.all(Date.now());
      return callback(null, rows.map((row) => JSON.parse(row.data)));
    } catch (err) {
      return callback(err);
    }
  }

  clear(callback = () => {}) {
    try {
      statements.clear.run();
      return callback(null);
    } catch (err) {
      return callback(err);
    }
  }
}

module.exports = SqliteSessionStore;
