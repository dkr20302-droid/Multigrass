# Multiplayer 2D Sandbox (Canvas + WebSockets)

Simple visuals, solid real-time networking: an authoritative Node.js WebSocket server + an HTML5 Canvas client.

## Features
- Real-time multiplayer over WebSockets (no polling)
- Authoritative server simulation (fixed tick) + client interpolation
- Procedural grass field (12-tone palette + Simplex noise; subtle animation)
- Join UI: username (max 16, filtered) + color picker
- Smooth movement (WASD / arrows), camera centered on player
- Basic sanity checks: message rate limiting + speed limits + clean disconnect handling
- Bonus: name collision avoidance, zoom in/out (mouse wheel)

## Folder structure
- `client/` static website (served by the server)
- `server/` Node.js WebSocket + HTTP static server

---

## Run locally
1) Install Node.js 18+.
2) In a terminal:
   - `cd C:\Users\Elija\OneDrive\文档\GAMING\server`
   - `npm.cmd install`
   - `npm run dev`
3) Open `http://localhost:6969` in two different browsers (or a phone + PC) to test multiplayer.

Note (Windows PowerShell): if `npm` is blocked by execution policy, use `npm.cmd` as shown above.
Note: open the site via `http://localhost:6969` (not `client/index.html` via `file://`), so the browser can connect to the WebSocket.

## Configure
Server env vars:
- `PORT` (default `6969`)
- `HOST` (default `0.0.0.0`)

---

## Deploy globally (Render example)
This repo is deployable as a single public web service (the server also serves the client).

1) Push this folder to GitHub.
2) In Render: **New → Web Service** → connect the repo.
3) Settings:
   - Runtime: **Node**
   - Root directory: `server`
   - Build command: `npm install`
   - Start command: `npm start`
4) Render will automatically expose a public HTTPS URL like `https://YOUR-SERVICE.onrender.com`.

WebSocket URL will be the same host:
- `wss://YOUR-SERVICE.onrender.com/ws`

Because the client is served by the same server, it auto-connects to the correct `ws://`/`wss://` URL.

Important: if you host the website on HTTPS, browsers require `wss://` (secure WebSockets).

### Ports / firewall
- Render/Railway handle port exposure automatically; the server listens on `0.0.0.0:$PORT`.
- VPS: open your chosen port (typically `80/443` via a reverse proxy, or `3000` directly for testing).

---

## Deploy globally (Railway example)
1) Create a new Railway project from this repo.
2) Set the root/start to `server` (or use a monorepo setting).
3) Railway provides a public domain; WebSocket is `wss://<domain>/ws`.

---

## Host client separately (optional)
If you host `client/` on another domain (GitHub Pages, Cloudflare Pages, etc.), open it with a query param:
- `https://your-client-site.example/?ws=wss://YOUR-SERVER.example/ws`

The client will use `?ws=` when present; otherwise it uses the current page host.
