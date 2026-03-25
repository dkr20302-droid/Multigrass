/**
 * Authoritative game server state + simulation.
 *
 * Anti-spam / sanity checks:
 * - Movement is computed server-side from input flags (no client positions accepted).
 * - Input messages are rate limited per-connection.
 * - Speed is fixed and capped; diagonal movement is normalized.
 */

const { randomUUID } = require("crypto");

const TICK_HZ = 30; // authoritative simulation tick
const SNAPSHOT_HZ = 20; // outgoing state update rate
const WORLD_SPAWN_RADIUS = 900;
const PLAYER_SPEED = 220; // world units / second
const PLAYER_RADIUS = 12;
// Optional: close connections that never send "hello".
// Uses a game-specific env var name to avoid collisions with global/host env vars.
// 0 or unset = disabled.
const GAME_HELLO_TIMEOUT_MS = Number(process.env.GAME_HELLO_TIMEOUT_MS || "0");

function clamp01(v) {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function sanitizeUsername(raw) {
  const str = String(raw ?? "")
    .trim()
    .replace(/\s+/g, " ");
  // Keep it readable; avoid weird control chars.
  const cleaned = str.replace(/[^a-zA-Z0-9_\- ]/g, "");
  return cleaned.slice(0, 16);
}

function sanitizeColor(raw) {
  const str = String(raw ?? "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(str)) return str.toLowerCase();
  return "#ffffff";
}

function uniqueUsername(baseName, takenSet) {
  const base = baseName.length ? baseName : "Player";
  if (!takenSet.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}#${i}`;
    if (!takenSet.has(candidate) && candidate.length <= 16) return candidate;
  }
  // Last resort: hard trim
  let i = 2;
  while (true) {
    const suffix = `#${i++}`;
    const trimmed = base.slice(0, Math.max(1, 16 - suffix.length));
    const candidate = `${trimmed}${suffix}`;
    if (!takenSet.has(candidate)) return candidate;
  }
}

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

function length2(x, y) {
  return Math.sqrt(x * x + y * y);
}

function encode(msg) {
  return JSON.stringify(msg);
}

class GameServer {
  constructor() {
    /** @type {Map<string, Player>} */
    this.players = new Map();
    /** @type {Map<import('ws').WebSocket, string>} */
    this.wsToId = new Map();

    this._tickInterval = setInterval(() => this._tick(), Math.floor(1000 / TICK_HZ));
    this._snapshotInterval = setInterval(() => this._sendSnapshots(), Math.floor(1000 / SNAPSHOT_HZ));
  }

  /**
   * @param {import('ws').WebSocket} ws
   * @param {import('http').IncomingMessage} req
   */
  handleConnection(ws, req) {
    const id = randomUUID();
    const now = Date.now();
    const player = {
      id,
      username: "",
      color: "#ffffff",
      x: randRange(-WORLD_SPAWN_RADIUS, WORLD_SPAWN_RADIUS),
      y: randRange(-WORLD_SPAWN_RADIUS, WORLD_SPAWN_RADIUS),
      input: { up: false, down: false, left: false, right: false },
      lastInputSeq: 0,
      lastHeardAt: now,
      msgCount: 0,
      msgWindowStart: now,
      ready: false
    };

    this.players.set(id, player);
    this.wsToId.set(ws, id);

    ws.on("message", (data) => this._onMessage(ws, data));
    ws.on("close", () => this._onClose(ws));
    ws.on("error", () => this._onClose(ws));

    // Optional: close connections that never send "hello".
    // Disabled by default because some browsers/extensions/proxies can delay user interaction
    // and we prefer stability over aggressive cleanup.
    if (Number.isFinite(GAME_HELLO_TIMEOUT_MS) && GAME_HELLO_TIMEOUT_MS > 0) {
      const helloTimeout = setTimeout(() => {
        const pid = this.wsToId.get(ws);
        const p = pid ? this.players.get(pid) : null;
        if (p && !p.ready) ws.close(1008, "hello timeout");
      }, GAME_HELLO_TIMEOUT_MS);
      ws.once("close", () => clearTimeout(helloTimeout));
    }

    // Minimal info for debugging (avoid logging IPs by default).
    void req;
  }

  _onClose(ws) {
    const id = this.wsToId.get(ws);
    if (!id) return;
    this.wsToId.delete(ws);
    const player = this.players.get(id);
    if (!player) return;
    this.players.delete(id);
    if (player.ready) this._broadcast({ type: "leave", id });
  }

  _rateLimitOrClose(ws) {
    const id = this.wsToId.get(ws);
    if (!id) return true;
    const player = this.players.get(id);
    if (!player) return true;
    const now = Date.now();
    if (now - player.msgWindowStart > 1000) {
      player.msgWindowStart = now;
      player.msgCount = 0;
    }
    player.msgCount++;
    // Allow generous input (e.g. 60 Hz), but stop obvious spam.
    if (player.msgCount > 160) {
      ws.close(1008, "rate limit");
      return true;
    }
    return false;
  }

  _onMessage(ws, data) {
    if (this._rateLimitOrClose(ws)) return;
    const id = this.wsToId.get(ws);
    if (!id) return;
    const player = this.players.get(id);
    if (!player) return;

    player.lastHeardAt = Date.now();

    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "hello") {
      if (player.ready) return;
      const taken = new Set();
      for (const p of this.players.values()) {
        if (p.ready && p.username) taken.add(p.username);
      }
      const requested = sanitizeUsername(msg.username);
      const username = uniqueUsername(requested, taken);
      player.username = username;
      player.color = sanitizeColor(msg.color);
      player.ready = true;

      // Send init to this player
      ws.send(
        encode({
          type: "init",
          id: player.id,
          username: player.username,
          color: player.color,
          x: player.x,
          y: player.y,
          tickHz: TICK_HZ,
          snapshotHz: SNAPSHOT_HZ,
          playerRadius: PLAYER_RADIUS
        })
      );

      // Send existing players to the new player
      const existing = [];
      for (const p of this.players.values()) {
        if (!p.ready || p.id === player.id) continue;
        existing.push({ id: p.id, username: p.username, color: p.color, x: p.x, y: p.y });
      }
      if (existing.length) ws.send(encode({ type: "presence", players: existing }));

      // Broadcast join to others
      this._broadcast(
        { type: "join", id: player.id, username: player.username, color: player.color, x: player.x, y: player.y },
        ws
      );
      return;
    }

    if (!player.ready) return;

    if (msg.type === "input") {
      // Only accept booleans and a monotonically increasing sequence number.
      const seq = Number(msg.seq);
      if (!Number.isFinite(seq)) return;
      if (seq <= player.lastInputSeq) return;
      if (seq > player.lastInputSeq + 5000) return; // absurd jump

      player.lastInputSeq = seq;
      player.input = {
        up: !!msg.up,
        down: !!msg.down,
        left: !!msg.left,
        right: !!msg.right
      };
      return;
    }
  }

  _tick() {
    const dt = 1 / TICK_HZ;
    for (const player of this.players.values()) {
      if (!player.ready) continue;
      const xAxis = (player.input.right ? 1 : 0) - (player.input.left ? 1 : 0);
      const yAxis = (player.input.down ? 1 : 0) - (player.input.up ? 1 : 0);
      let vx = xAxis;
      let vy = yAxis;
      const len = length2(vx, vy);
      if (len > 0) {
        vx /= len;
        vy /= len;
      }

      // Fixed speed; prevents teleporting even if clients send faster inputs.
      const speed = PLAYER_SPEED * clamp01(len);
      player.x += vx * speed * dt;
      player.y += vy * speed * dt;
    }
  }

  _sendSnapshots() {
    const now = Date.now();
    const playersPacked = [];
    for (const p of this.players.values()) {
      if (!p.ready) continue;
      playersPacked.push({ id: p.id, x: p.x, y: p.y, username: p.username, color: p.color });
    }

    // Per-client ack helps client-side prediction reconcile.
    for (const [ws, id] of this.wsToId.entries()) {
      if (ws.readyState !== ws.OPEN) continue;
      const p = this.players.get(id);
      if (!p || !p.ready) continue;
      ws.send(encode({ type: "snapshot", t: now, ack: p.lastInputSeq, players: playersPacked }));
    }
  }

  _broadcast(msg, exceptWs = null) {
    const encoded = encode(msg);
    for (const ws of this.wsToId.keys()) {
      if (ws === exceptWs) continue;
      if (ws.readyState !== ws.OPEN) continue;
      ws.send(encoded);
    }
  }
}

module.exports = { GameServer };

/**
 * @typedef Player
 * @property {string} id
 * @property {string} username
 * @property {string} color
 * @property {number} x
 * @property {number} y
 * @property {{up:boolean,down:boolean,left:boolean,right:boolean}} input
 * @property {number} lastInputSeq
 * @property {number} lastHeardAt
 * @property {number} msgCount
 * @property {number} msgWindowStart
 * @property {boolean} ready
 */
