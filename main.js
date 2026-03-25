import { createSimplexNoise } from "./noise.js";
import { createNetClient } from "./net.js";

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d", { alpha: false });

const overlay = document.getElementById("overlay");
const usernameEl = document.getElementById("username");
const colorEl = document.getElementById("color");
const joinBtn = document.getElementById("join");
const statusEl = document.getElementById("status");

function setStatus(text) {
  statusEl.textContent = text || "";
}

function resize() {
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resize);
resize();

// --- Game state ---
const players = new Map(); // id -> {id, username, color, x, y, renderX, renderY}
let myId = null;
let playerRadius = 12;

// Prediction & reconciliation
let inputSeq = 0;
const pendingInputs = []; // {seq, dt, up,down,left,right}

// Snapshot buffer
const snapshotBuffer = [];
const INTERP_DELAY_MS = 110;
let serverOffsetMs = 0; // serverTime ~= Date.now() + serverOffsetMs

// Zoom (mouse wheel)
let zoom = 1.0;
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const delta = Math.sign(e.deltaY);
    const factor = delta > 0 ? 0.9 : 1.1;
    zoom = Math.max(0.55, Math.min(2.25, zoom * factor));
  },
  { passive: false }
);

// Input state
const keys = new Set();
window.addEventListener("keydown", (e) => keys.add(e.key));
window.addEventListener("keyup", (e) => keys.delete(e.key));
function readInput() {
  const up = keys.has("w") || keys.has("W") || keys.has("ArrowUp");
  const down = keys.has("s") || keys.has("S") || keys.has("ArrowDown");
  const left = keys.has("a") || keys.has("A") || keys.has("ArrowLeft");
  const right = keys.has("d") || keys.has("D") || keys.has("ArrowRight");
  return { up, down, left, right };
}

// --- Grass (procedural, 12-tone palette + noise) ---
const palette = [
  "#1f6f2a",
  "#226c2a",
  "#256a2b",
  "#28682c",
  "#2b662d",
  "#2f6b2f",
  "#2f7031",
  "#2c7432",
  "#2a7833",
  "#307d36",
  "#348338",
  "#2a5f28"
];
const noise = createSimplexNoise(((Math.random() * 1e9) | 0) ^ 0x9e3779b9);
const TILE = 32; // world units
const NOISE_FREQ = 1 / 9;

function hash2i(x, y) {
  let h = x * 374761393 + y * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  return (h ^ (h >> 16)) >>> 0;
}

function grassColor(tileX, tileY, tMs) {
  const anim = tMs * 0.00008;
  const n = noise.noise2D((tileX + anim) * NOISE_FREQ, (tileY - anim) * NOISE_FREQ);
  const u = (n + 1) * 0.5;
  const jitter = (hash2i(tileX, tileY) & 255) / 255;
  const v = Math.min(0.999, Math.max(0, u * 0.9 + jitter * 0.1));
  const idx = Math.floor(v * palette.length);
  return palette[idx];
}

// --- Networking ---
const net = createNetClient({
  onInit: (msg) => {
    myId = msg.id;
    playerRadius = msg.playerRadius || 12;
    players.set(msg.id, {
      id: msg.id,
      username: msg.username,
      color: msg.color,
      x: msg.x,
      y: msg.y,
      renderX: msg.x,
      renderY: msg.y
    });
    overlay.style.display = "none";
    setStatus("");
  },
  onPresence: (list) => {
    for (const p of list) players.set(p.id, { ...p, renderX: p.x, renderY: p.y });
  },
  onJoin: (p) => players.set(p.id, { ...p, renderX: p.x, renderY: p.y }),
  onLeave: ({ id }) => players.delete(id),
  onSnapshot: (msg) => {
    // Estimate server clock offset (handles small clock skew across machines)
    const sampleOffset = Number(msg.t || 0) - Date.now();
    if (Number.isFinite(sampleOffset)) serverOffsetMs = serverOffsetMs * 0.9 + sampleOffset * 0.1;

    const map = new Map();
    for (const p of msg.players || []) map.set(p.id, p);
    snapshotBuffer.push({ t: msg.t, players: map, ack: msg.ack });
    while (snapshotBuffer.length > 40) snapshotBuffer.shift();

    // Reconcile local prediction
    if (myId && map.has(myId)) {
      const meServer = map.get(myId);
      const me = players.get(myId);
      if (me) {
        me.username = meServer.username;
        me.color = meServer.color;
        me.x = meServer.x;
        me.y = meServer.y;

        const ack = Number(msg.ack || 0);
        while (pendingInputs.length && pendingInputs[0].seq <= ack) pendingInputs.shift();
        for (const pi of pendingInputs) applyMove(me, pi, pi.dt);
      }
    }
  },
  onStatus: (text) => setStatus(text),
  onDisconnect: () => {
    // If we were in-game, return to join overlay so the user can re-join cleanly.
    if (myId) {
      myId = null;
      players.clear();
      pendingInputs.length = 0;
      inputSeq = 0;
      snapshotBuffer.length = 0;
      overlay.style.display = "";
    }
  }
});
net.connect();

joinBtn.addEventListener("click", () => {
  if (!net.isOpen) {
    setStatus("Still connecting...");
    return;
  }
  const rawName = usernameEl.value || "Player";
  const username = rawName.trim().replace(/\s+/g, " ").slice(0, 16);
  const color = colorEl.value || "#ffffff";
  net.sendHello({ username, color });
  setStatus("Joining...");
});

usernameEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinBtn.click();
});

// --- Movement ---
const MOVE_SPEED = 220; // keep consistent with server

function applyMove(p, input, dt) {
  const xAxis = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const yAxis = (input.down ? 1 : 0) - (input.up ? 1 : 0);
  let vx = xAxis;
  let vy = yAxis;
  const len = Math.hypot(vx, vy);
  if (len > 0) {
    vx /= len;
    vy /= len;
  }
  p.x += vx * MOVE_SPEED * dt;
  p.y += vy * MOVE_SPEED * dt;
}

let lastInputSentAt = performance.now();
function sendInputs(now) {
  if (!myId) return;
  if (now - lastInputSentAt < 33) return; // ~30 Hz
  const dt = Math.min(0.05, Math.max(0.001, (now - lastInputSentAt) / 1000));
  lastInputSentAt = now;

  const input = readInput();
  inputSeq++;
  net.sendInput({ type: "input", seq: inputSeq, ...input });

  const me = players.get(myId);
  if (me) {
    const pi = { seq: inputSeq, dt, ...input };
    pendingInputs.push(pi);
    applyMove(me, pi, dt);
  }
}

function drawName(name, sx, sy) {
  const size = Math.max(10, Math.min(22, 14 * zoom));
  ctx.font = `600 ${size}px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.lineWidth = Math.max(2, 4 * zoom);
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.strokeText(name, sx, sy);
  ctx.fillText(name, sx, sy);
}

function sampleInterpolatedPlayer(id, renderTimeMs) {
  if (snapshotBuffer.length < 2) return null;
  let older = null;
  let newer = null;
  for (let i = snapshotBuffer.length - 1; i >= 0; i--) {
    const s = snapshotBuffer[i];
    if (s.t <= renderTimeMs) {
      older = s;
      newer = snapshotBuffer[i + 1] || s;
      break;
    }
  }
  if (!older) {
    older = snapshotBuffer[0];
    newer = snapshotBuffer[1];
  }
  const a = older.players.get(id);
  const b = newer.players.get(id);
  if (!a) return null;
  if (!b) return a;
  const span = Math.max(1, newer.t - older.t);
  const t = Math.max(0, Math.min(1, (renderTimeMs - older.t) / span));
  return { ...a, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

// --- Main loop ---
let lastFrame = performance.now();
function frame(now) {
  lastFrame = now;
  sendInputs(now);

  // Background
  ctx.fillStyle = "#0b1a0b";
  ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

  const me = myId ? players.get(myId) : null;
  const camX = me ? me.x : 0;
  const camY = me ? me.y : 0;

  // Grass tiles in view
  const viewW = window.innerWidth / zoom;
  const viewH = window.innerHeight / zoom;
  const left = Math.floor((camX - viewW / 2) / TILE) - 1;
  const right = Math.floor((camX + viewW / 2) / TILE) + 1;
  const top = Math.floor((camY - viewH / 2) / TILE) - 1;
  const bottom = Math.floor((camY + viewH / 2) / TILE) + 1;

  for (let ty = top; ty <= bottom; ty++) {
    for (let tx = left; tx <= right; tx++) {
      const wx = tx * TILE;
      const wy = ty * TILE;
      const sx = (wx - camX) * zoom + window.innerWidth * 0.5;
      const sy = (wy - camY) * zoom + window.innerHeight * 0.5;
      ctx.fillStyle = grassColor(tx, ty, now);
      ctx.fillRect(sx, sy, TILE * zoom + 1, TILE * zoom + 1);
    }
  }

  // Update render positions from interpolation
  const renderTimeMs = Date.now() + serverOffsetMs - INTERP_DELAY_MS;
  for (const [id, p] of players.entries()) {
    if (id === myId) {
      players.set(id, { ...p, renderX: p.x, renderY: p.y });
      continue;
    }
    const interp = sampleInterpolatedPlayer(id, renderTimeMs);
    if (!interp) continue;
    players.set(id, { ...p, username: interp.username, color: interp.color, renderX: interp.x, renderY: interp.y });
  }

  for (const p of players.values()) {
    const sx = (p.renderX - camX) * zoom + window.innerWidth * 0.5;
    const sy = (p.renderY - camY) * zoom + window.innerHeight * 0.5;
    ctx.beginPath();
    ctx.fillStyle = p.color || "#ffffff";
    ctx.arc(sx, sy, playerRadius * zoom, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = Math.max(1, 2 * zoom);
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.stroke();

    if (p.username) drawName(p.username, sx, sy - (playerRadius * zoom + 10));
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
