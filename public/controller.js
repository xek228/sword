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

// iOS only offers the permission prompt on a secure context.
const isSecure = location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1";

function showError(title, body) {
  const box = document.getElementById("error-box");
  box.innerHTML = `<h3>${title}</h3>${body}`;
  box.hidden = false;
}

async function requestSensorPermissions() {
  // iOS 13+ requires this gate; other browsers resolve immediately.
  const motionAsk = typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function"
    ? DeviceMotionEvent.requestPermission()
    : Promise.resolve("granted");
  const orientAsk = typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function"
    ? DeviceOrientationEvent.requestPermission()
    : Promise.resolve("granted");

  let motion, orient;
  try {
    [motion, orient] = await Promise.all([motionAsk, orientAsk]);
  } catch (err) {
    // iOS throws NotAllowedError when the call isn't in a secure context or user-gesture.
    if (!isSecure) {
      showError(
        "This page needs HTTPS",
        "<p>iOS Safari only prompts for motion access on a secure context.</p>" +
        "<p>Run <code>cloudflared tunnel --url http://localhost:8080</code> on the Mac, then open the printed <code>https://…</code> URL on this phone.</p>",
      );
    } else {
      showError("Permission call failed", `<p><code>${err?.name || err}</code></p><p>Try closing this tab and opening the page fresh.</p>`);
    }
    return false;
  }

  if (motion !== "granted" || orient !== "granted") {
    showError(
      "Motion permission denied",
      "<p>iOS reported <b>denied</b> without showing a system prompt. That usually means one of:</p>" +
      "<ol>" +
      "<li><b>Settings → Safari → Motion &amp; Orientation Access</b> is OFF. Turn it on, then fully close this tab and reopen.</li>" +
      (!isSecure ? "<li>This page is served over <b>HTTP</b>. iOS needs HTTPS — use <code>cloudflared tunnel --url http://localhost:8080</code> and open the HTTPS URL.</li>" : "") +
      "<li>You previously tapped <b>Don't Allow</b> for this domain. Clear it via <b>Settings → Safari → Advanced → Website Data</b>, then reopen.</li>" +
      "</ol>" +
      `<p class="hint">Protocol: <code>${location.protocol}</code> · Host: <code>${location.host}</code></p>`,
    );
    return false;
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

// Pre-flight hint: if we're on iOS and NOT in a secure context, the permission
// call will silently fail, so warn up front.
if (!isSecure && typeof DeviceMotionEvent !== "undefined"
    && typeof DeviceMotionEvent.requestPermission === "function") {
  showError(
    "This page needs HTTPS",
    "<p>iOS Safari will reject motion access on plain HTTP.</p>" +
    "<p>On the Mac run:</p><pre>cloudflared tunnel --url http://localhost:8080</pre>" +
    "<p>Open the printed <code>https://…trycloudflare.com/controller.html</code> on this phone instead.</p>",
  );
}
