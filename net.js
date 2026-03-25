/**
 * WebSocket networking wrapper.
 */

export function resolveWsUrl() {
  const qs = new URLSearchParams(location.search);
  const override = qs.get("ws");
  if (override) return override;
  // If you open the HTML via file://, there is no host/port for auto-discovery.
  // In that case, default to localhost:6969 (matches server default).
  if (location.protocol === "file:" || !location.host) {
    return "ws://localhost:6969/ws";
  }
  // 0.0.0.0 is a bind address, not a connect address.
  // Also, some environments resolve localhost to IPv6 only; 127.0.0.1 avoids that.
  const hostName = location.hostname === "0.0.0.0" || location.hostname === "localhost" ? "127.0.0.1" : location.hostname;
  const portPart = location.port ? `:${location.port}` : "";
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${hostName}${portPart}/ws`;
}

export function createNetClient({ onInit, onJoin, onLeave, onPresence, onSnapshot, onStatus, onDisconnect }) {
  const wsUrl = resolveWsUrl();
  let ws = null;
  let open = false;
  let reconnectAttempt = 0;

  function connect() {
    onStatus?.(`Connecting to ${wsUrl} ...`);
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      onStatus?.(`WebSocket URL invalid: ${wsUrl}`);
      return;
    }
    ws.addEventListener("open", () => {
      open = true;
      reconnectAttempt = 0;
      onStatus?.("Connected.");
    });
    ws.addEventListener("close", (ev) => {
      open = false;
      const reason = ev?.reason ? ` (${ev.reason})` : "";
      onStatus?.(`Disconnected (code ${ev.code})${reason}. Reconnecting...`);
      onDisconnect?.(ev);
      scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      onStatus?.("WebSocket error.");
    });
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      switch (msg.type) {
        case "init":
          onInit?.(msg);
          break;
        case "presence":
          onPresence?.(msg.players || []);
          break;
        case "join":
          onJoin?.(msg);
          break;
        case "leave":
          onLeave?.(msg);
          break;
        case "snapshot":
          onSnapshot?.(msg);
          break;
      }
    });
  }

  function scheduleReconnect() {
    // Basic exponential backoff (client stays globally usable even if server restarts).
    reconnectAttempt++;
    const delay = Math.min(8000, 250 * Math.pow(2, Math.min(5, reconnectAttempt)));
    setTimeout(() => {
      if (open) return;
      connect();
    }, delay);
  }

  function sendHello({ username, color }) {
    if (!open) return;
    ws.send(JSON.stringify({ type: "hello", username, color }));
  }

  function sendInput(inputMsg) {
    if (!open) return;
    ws.send(JSON.stringify(inputMsg));
  }

  return {
    connect,
    sendHello,
    sendInput,
    get url() {
      return wsUrl;
    },
    get isOpen() {
      return open;
    }
  };
}
