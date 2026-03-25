/**
 * Server entrypoint
 * - HTTP server: serves the static client from ../client
 * - WebSocket server: real-time multiplayer networking at /ws
 *
 * Networking flow (high level):
 * - Client connects to WS and sends {type:"hello", username, color}
 * - Server assigns id + spawn position, broadcasts join
 * - Client sends {type:"input", seq, up, down, left, right} at a steady rate
 * - Server simulates authoritative positions on a fixed tick
 * - Server sends periodic snapshots; clients interpolate remote players and reconcile local prediction
 */

const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");
const { createStaticHandler } = require("./static");
const { GameServer } = require("./world");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || "6969");

const clientRoot = path.join(__dirname, "..", "client");
const handleStatic = createStaticHandler(clientRoot);

const httpServer = http.createServer((req, res) => {
  // Simple healthcheck endpoint for cloud platforms
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }
  handleStatic(req, res);
});

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
const game = new GameServer();

// Heartbeat: keep connections alive and drop dead peers (helps with NAT/proxy weirdness).
// Browsers automatically respond to ping frames with pong frames.
function heartbeat() {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      ws.terminate();
    }
  }
}
const heartbeatInterval = setInterval(heartbeat, 30000);

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  game.handleConnection(ws, req);
});

wss.on("close", () => clearInterval(heartbeatInterval));

httpServer.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`HTTP listening on http://${HOST}:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`WS listening on ws://${HOST}:${PORT}/ws`);
});
