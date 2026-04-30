// iPhone-side controller page. Requests DeviceMotion permission on iOS 13+,
// opens a WebSocket back to the server, streams motion + button events,
// and drives the calibration wizard.

const conn = document.getElementById("conn");
const startBtn = document.getElementById("start-btn");
const gate = document.getElementById("permission-gate");
const ui = document.getElementById("play-ui");
const magEl = document.getElementById("mag");
const lastEl = document.getElementById("ctrl-last");
const calibStatusEl = document.getElementById("calib-status");

const params = new URLSearchParams(location.search);
const room = params.get("room") || "default";

let ws = null;
let connected = false;
let sensorsActive = false;

const TEMPLATE_KEY = `sword-templates:${room}`;

function setConn(state, cls) {
  conn.textContent = state;
  conn.className = "pill" + (cls ? " " + cls : "");
}

function loadTemplates() {
  try {
    const raw = localStorage.getItem(TEMPLATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {}
  return null;
}

function saveTemplates(t) {
  try { localStorage.setItem(TEMPLATE_KEY, JSON.stringify(t)); } catch {}
}

function updateCalibStatus() {
  const t = loadTemplates();
  if (!t) {
    calibStatusEl.textContent = "Using default axis-based detection. Calibrate for better recognition of your swings.";
    return;
  }
  const dirs = Object.keys(t);
  calibStatusEl.textContent = dirs.length >= 3
    ? `Calibrated: ${dirs.join(", ")}. Tap again to re-calibrate.`
    : `Partial calibration (${dirs.join(", ")}). Finish all 5 for best results.`;
}

function connectWs() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/?role=controller&room=${encodeURIComponent(room)}`;
  ws = new WebSocket(url);
  ws.addEventListener("open", () => {
    connected = true;
    setConn("connected", "on");
    // Sync stored templates to the server.
    const t = loadTemplates();
    if (t) send({ type: "calibrate:templates", templates: t });
  });
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
      } else if (m.type === "calibrate:started") {
        calib.onStartedAck(m.direction, m.ok);
      } else if (m.type === "calibrate:recorded") {
        calib.onRecorded(m.captured);
      } else if (m.type === "calibrate:templates-ack") {
        // no-op for now; could reconcile
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
  if (calib.active) calib.onMag(mag);
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

function activateSensors() {
  if (sensorsActive) return;
  sensorsActive = true;
  window.addEventListener("devicemotion", onMotion, { passive: true });
  window.addEventListener("deviceorientation", onOrientation, { passive: true });
}

startBtn.addEventListener("click", async () => {
  const ok = await requestSensorPermissions();
  if (!ok) return;
  gate.hidden = true;
  ui.hidden = false;
  connectWs();
  activateSensors();
  updateCalibStatus();
});

// Touch buttons (block / calibrate).
document.querySelectorAll("#touch-pad .big[data-btn]").forEach((btn) => {
  const name = btn.dataset.btn;
  const down = (e) => { e.preventDefault(); send({ type: "button", name, pressed: true }); };
  const up   = (e) => { e.preventDefault(); send({ type: "button", name, pressed: false }); };
  btn.addEventListener("touchstart", down, { passive: false });
  btn.addEventListener("touchend", up,   { passive: false });
  btn.addEventListener("mousedown", down);
  btn.addEventListener("mouseup", up);
  btn.addEventListener("mouseleave", up);
});

// If browser is not iOS (e.g., desktop testing), show UI right away.
if (typeof DeviceMotionEvent === "undefined" ||
    typeof DeviceMotionEvent.requestPermission !== "function") {
  startBtn.textContent = "Connect";
}

if (!isSecure && typeof DeviceMotionEvent !== "undefined"
    && typeof DeviceMotionEvent.requestPermission === "function") {
  showError(
    "This page needs HTTPS",
    "<p>iOS Safari will reject motion access on plain HTTP.</p>" +
    "<p>On the Mac run:</p><pre>cloudflared tunnel --url http://localhost:8080</pre>" +
    "<p>Open the printed <code>https://…trycloudflare.com/controller.html</code> on this phone instead.</p>",
  );
}

// --- Calibration wizard ---------------------------------------------------

const CALIB_STEPS = [
  { dir: "right",  arrow: "→", hint: "Swing your phone from LEFT to RIGHT, like a horizontal slash." },
  { dir: "left",   arrow: "←", hint: "Swing your phone from RIGHT to LEFT." },
  { dir: "up",     arrow: "↑", hint: "Swing UPWARD, like an uppercut from your waist to your head." },
  { dir: "down",   arrow: "↓", hint: "Swing DOWNWARD, a chop from high to low." },
  { dir: "thrust", arrow: "•→", hint: "Push the phone FORWARD, like stabbing toward a target." },
];

const calib = {
  active: false,
  stepIdx: 0,
  recording: false,
  peakMag: 0,
  overlay:     document.getElementById("calib-overlay"),
  title:       document.getElementById("calib-title"),
  instruction: document.getElementById("calib-instruction"),
  arrow:       document.getElementById("calib-arrow"),
  countdown:   document.getElementById("calib-countdown"),
  feedback:    document.getElementById("calib-feedback"),
  nextBtn:     document.getElementById("calib-next"),
  cancelBtn:   document.getElementById("calib-cancel"),
  captured: {},

  open() {
    this.active = true;
    this.stepIdx = 0;
    this.captured = {};
    this.overlay.hidden = false;
    this._renderStep();
    this.feedback.textContent = "";
    this.nextBtn.textContent = "Start";
  },

  cancel() {
    this.active = false;
    this.recording = false;
    this.overlay.hidden = true;
    send({ type: "calibrate:end" }); // in case a recording was in flight
  },

  _renderStep() {
    const step = CALIB_STEPS[this.stepIdx];
    this.title.textContent = `Step ${this.stepIdx + 1} / ${CALIB_STEPS.length}: ${step.dir}`;
    this.instruction.textContent = step.hint;
    this.arrow.textContent = step.arrow;
    this.countdown.textContent = "";
    // Update progress pills.
    document.querySelectorAll(".calib-progress [data-step]").forEach((el) => {
      const d = el.dataset.step;
      el.classList.toggle("done",    !!this.captured[d]);
      el.classList.toggle("current", d === step.dir);
    });
  },

  _startRecording() {
    const step = CALIB_STEPS[this.stepIdx];
    this.recording = true;
    this.peakMag = 0;
    this.nextBtn.disabled = true;
    this.nextBtn.textContent = "Recording…";
    this.feedback.textContent = "";
    send({ type: "calibrate:start", direction: step.dir });

    // Small countdown so the user has a beat to ready the phone before the
    // server starts looking at samples.
    let t = 2;
    this.countdown.textContent = `Swing in ${t}…`;
    const tick = () => {
      t -= 1;
      if (t > 0) {
        this.countdown.textContent = `Swing in ${t}…`;
        setTimeout(tick, 700);
      } else {
        this.countdown.textContent = "SWING NOW!";
        // Give the user 1.8s to perform the gesture, then end.
        setTimeout(() => {
          this.countdown.textContent = "Analyzing…";
          send({ type: "calibrate:end" });
        }, 1800);
      }
    };
    setTimeout(tick, 700);
  },

  onStartedAck(direction, ok) {
    if (!ok) {
      this.feedback.textContent = `Server rejected ${direction}. Try again.`;
      this.recording = false;
      this.nextBtn.disabled = false;
      this.nextBtn.textContent = "Retry";
    }
  },

  onRecorded(captured) {
    if (!this.active) return;
    this.recording = false;
    this.nextBtn.disabled = false;

    if (!captured) {
      this.feedback.textContent = "Swing was too weak or not detected. Try again, a bit stronger.";
      this.nextBtn.textContent = "Retry";
      return;
    }
    const step = CALIB_STEPS[this.stepIdx];
    if (captured.direction !== step.dir) {
      // Shouldn't happen, but defensive.
      this.feedback.textContent = `Got ${captured.direction} instead of ${step.dir}; try again.`;
      this.nextBtn.textContent = "Retry";
      return;
    }
    this.captured[step.dir] = { v: captured.v, mag: captured.mag };
    this.feedback.textContent = `Captured peak ${captured.mag.toFixed(1)} m/s² — looks good.`;
    this.stepIdx += 1;
    if (this.stepIdx >= CALIB_STEPS.length) {
      this._finish();
    } else {
      this._renderStep();
      this.nextBtn.textContent = "Next";
    }
  },

  _finish() {
    this.title.textContent = "All done!";
    this.instruction.textContent = "Your swings are calibrated and stored on this phone.";
    this.arrow.textContent = "✓";
    this.countdown.textContent = "";
    this.nextBtn.textContent = "Close";
    saveTemplates(this.captured);
    send({ type: "calibrate:templates", templates: this.captured });
    updateCalibStatus();
  },

  onNext() {
    if (this.recording) return;
    if (this.stepIdx >= CALIB_STEPS.length) {
      this.cancel();
      return;
    }
    this._startRecording();
  },

  onMag(mag) {
    if (mag > this.peakMag) this.peakMag = mag;
  },
};

document.getElementById("open-calib").addEventListener("click", () => calib.open());
calib.nextBtn.addEventListener("click", () => calib.onNext());
calib.cancelBtn.addEventListener("click", () => calib.cancel());

updateCalibStatus();
