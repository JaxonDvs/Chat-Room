# Chat Room

A small, persistent chat room. Share the link, anyone can make an account, and
everyone talks in the same room. Messages and accounts are stored in SQLite, so
nothing is lost when the server restarts.

![The chat room](docs/screenshot.png)

## What it does

- **Accounts** — username + password, hashed with bcrypt. Sign in once and stay
  signed in for a month.
- **One shared room** — everyone who signs up lands in the same conversation.
- **Persistent history** — every message is written to SQLite and reloaded when
  you come back. Scroll up to page through older messages.
- **Live** — messages arrive over a WebSocket, with a list of who's online.
- **Minimalist white theme** — no dark mode, no clutter, works on phones.

## Run it locally

```bash
npm install
npm start
```

Open <http://localhost:3000>, create an account, and start typing. Open a second
browser (or a private window) to talk to yourself and watch it sync.

For auto-reload while editing: `npm run dev`.

## Deploy it so you can share the link

The only real requirement is **persistent disk** — the SQLite database lives in
one directory (`DATA_DIR`, default `./data`). Point that at a mounted volume and
the room survives redeploys.

### Render

The included `render.yaml` sets everything up, disk included:

1. Push this repo to GitHub.
2. In Render, choose **New → Blueprint** and pick the repo.
3. Deploy. Render gives you a `https://your-app.onrender.com` URL — that's the
   link you send people.

A paid plan is needed for the persistent disk. On the free plan the app still
runs, but the database resets whenever the instance is recycled.

### Docker

```bash
docker build -t chat-room .
docker run -p 3000:3000 -v chat-data:/data chat-room
```

The named volume `chat-data` is what keeps the history.

### Fly.io / Railway / a VPS

Anywhere that runs Node 18+ works. Set `DATA_DIR` to a path on a persistent
volume, set `NODE_ENV=production`, and put the app behind HTTPS.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on. |
| `DATA_DIR` | `./data` | Where `chat.db` is written. Mount a volume here. |
| `NODE_ENV` | — | Set to `production` to mark cookies `Secure` (requires HTTPS). |
| `SESSION_SECRET` | auto-generated | Signs session cookies. Generated once and stored in the database if unset, so sessions survive restarts either way. Set it explicitly if you ever run more than one instance. |

## Notes on how it works

- `server.js` — HTTP routes, auth, and the Socket.IO handlers.
- `db.js` — schema and every SQL statement, prepared once at startup.
- `session-store.js` — an `express-session` store on the same SQLite file, so
  there's only one thing to back up.
- `public/` — the whole frontend: one HTML file, one stylesheet, one script. No
  build step.

Sockets reuse the HTTP session, so a connection is authenticated exactly when
the browser is — there are no separate tokens to manage.

### Security

- Passwords are bcrypt-hashed (cost 12) and never returned by the API.
- Login timing is constant-ish whether or not the username exists, so the form
  doesn't leak which accounts are real.
- Session cookies are `httpOnly`, `SameSite=Lax`, and `Secure` in production.
- State-changing requests must be `application/json`, which blocks simple
  cross-site form posts.
- Message text is rendered with `textContent` and links are built as DOM nodes,
  so posted HTML shows up as literal text instead of executing.
- Registration and login are rate-limited per IP; sending is rate-limited per
  user.

Anyone with the link can register — that's the point, but it does mean the room
is public. If you want it private, put it behind a VPN or add an invite code to
the register route.

## License

MIT
