// iPhone-side controller page. Requests DeviceMotion permission on iOS 13+,
// opens a WebSocket back to the server, and streams motion + button events.

const conn = document.getElementById("conn");
const startBtn = document.getElementById("start-btn");
const gate = document.getElementById("permission-gate");
const ui = document.getElementById("play-ui");
const magEl = document.getElementById("mag");
const lastEl = document.getElementById("ctrl-last");

const params = new URLSearchParams(location.search);
const room = params.get("room") || "default";

let ws = null;
let connected = false;

function setConn(state, cls) {
  conn.textContent = state;
  conn.className = "pill" + (cls ? " " + cls : "");
}

function connectWs() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/?role=controller&room=${encodeURIComponent(room)}`;
  ws = new WebSocket(url);
  ws.addEventListener("open", () => { connected = true; setConn("connected", "on"); });
  ws.addEventListener("close", () => {
    connected = false;
    setConn("reconnecting...", "err");
    setTimeout(connectWs, 1000);
  });
  ws.addEventListener("error", () => setConn("error", "err"));
  ws.addEventListener("message", (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m.type === "presence" && typeof m.games === "number") {
        setConn(m.games > 0 ? "paired" : "connected", m.games > 0 ? "on" : "");
      }
    } catch {}
  });
}

function send(obj) {
  if (connected && ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

let lastMotionAt = 0;
function onMotion(ev) {
  const now = performance.now();
  // Throttle to ~60 Hz
  if (now - lastMotionAt < 15) return;
  lastMotionAt = now;
  const ag = ev.accelerationIncludingGravity || {};
  const a = ev.acceleration || {};
  const r = ev.rotationRate || {};
  const payload = {
    type: "motion",
    t: Date.now(),
    accelerationIncludingGravity: { x: ag.x ?? 0, y: ag.y ?? 0, z: ag.z ?? 0 },
    acceleration: a && a.x != null ? { x: a.x, y: a.y, z: a.z } : null,
    rotationRate: { alpha: r.alpha ?? 0, beta: r.beta ?? 0, gamma: r.gamma ?? 0 },
  };
  send(payload);
  const mag = Math.hypot(
    payload.acceleration?.x ?? payload.accelerationIncludingGravity.x,
    payload.acceleration?.y ?? payload.accelerationIncludingGravity.y,
    payload.acceleration?.z ?? payload.accelerationIncludingGravity.z,
  );
  magEl.textContent = mag.toFixed(1);
}

function onOrientation(ev) {
  send({
    type: "orientation",
    t: Date.now(),
    alpha: ev.alpha ?? 0,
    beta: ev.beta ?? 0,
    gamma: ev.gamma ?? 0,
  });
}

async function requestSensorPermissions() {
  // iOS 13+ requires this gate; other browsers resolve immediately.
  const asks = [];
  if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
    asks.push(DeviceMotionEvent.requestPermission());
  }
  if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
    asks.push(DeviceOrientationEvent.requestPermission());
  }
  if (asks.length) {
    const results = await Promise.all(asks);
    if (results.some((r) => r !== "granted")) {
      alert("Motion permission denied. Reload the page and try again.");
      return false;
    }
  }
  return true;
}

startBtn.addEventListener("click", async () => {
  const ok = await requestSensorPermissions();
  if (!ok) return;
  gate.hidden = true;
  ui.hidden = false;
  connectWs();
  window.addEventListener("devicemotion", onMotion, { passive: true });
  window.addEventListener("deviceorientation", onOrientation, { passive: true });
});

// Touch buttons (block / calibrate).
document.querySelectorAll("#touch-pad .big").forEach((btn) => {
  const name = btn.dataset.btn;
  const down = (e) => { e.preventDefault(); send({ type: "button", name, pressed: true }); };
  const up   = (e) => { e.preventDefault(); send({ type: "button", name, pressed: false });
    if (name === "calibrate") send({ type: "calibrate" });
  };
  btn.addEventListener("touchstart", down, { passive: false });
  btn.addEventListener("touchend", up,   { passive: false });
  btn.addEventListener("mousedown", down);
  btn.addEventListener("mouseup", up);
  btn.addEventListener("mouseleave", up);
});

// If browser is not iOS (e.g., desktop testing), show UI right away.
if (typeof DeviceMotionEvent === "undefined" ||
    typeof DeviceMotionEvent.requestPermission !== "function") {
  // Desktop / Android path: auto-connect, no gesture required.
  startBtn.textContent = "Connect";
}
