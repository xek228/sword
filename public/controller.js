// iPhone-side controller page. Requests DeviceMotion permission on iOS 13+,
// opens a WebSocket back to the server, streams motion + button events,
// drives the calibration wizard, and renders a live debug panel so the
// player can see the raw accelerometer + gyro signals and the detector's
// decision.

const conn = document.getElementById("conn");
const startBtn = document.getElementById("start-btn");
const gate = document.getElementById("permission-gate");
const ui = document.getElementById("play-ui");
const magEl = document.getElementById("mag");
const omegaEl = document.getElementById("omega");
const barA = document.getElementById("bar-a");
const barW = document.getElementById("bar-w");
const lastEl = document.getElementById("ctrl-last");
const modeEl = document.getElementById("ctrl-mode");
const scoreEl = document.getElementById("ctrl-score");
const scoresRow = document.getElementById("scores-row");
const calibStatusEl = document.getElementById("calib-status");
const sensSlider = document.getElementById("sens-slider");
const sensVal = document.getElementById("sens-val");

const params = new URLSearchParams(location.search);
const room = params.get("room") || "default";

let ws = null;
let connected = false;
let sensorsActive = false;

const TEMPLATE_KEY = `sword-templates:${room}`;
const SENS_KEY = `sword-sensitivity:${room}`;

// --- Storage helpers ------------------------------------------------------

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
function clearTemplates() {
  try { localStorage.removeItem(TEMPLATE_KEY); } catch {}
}
function loadSensitivity() {
  const raw = parseFloat(localStorage.getItem(SENS_KEY) || "1.0");
  return Number.isFinite(raw) && raw > 0 ? raw : 1.0;
}
function saveSensitivity(v) {
  try { localStorage.setItem(SENS_KEY, String(v)); } catch {}
}

function updateCalibStatus() {
  const t = loadTemplates();
  if (!t) {
    calibStatusEl.textContent = "Using default detection. Calibrate for per-user swings.";
    return;
  }
  const dirs = Object.keys(t);
  calibStatusEl.textContent = dirs.length >= 3
    ? `Calibrated: ${dirs.join(", ")}. Tap Calibrate to redo.`
    : `Partial calibration (${dirs.join(", ")}). Finish all 5 for best results.`;
}

// --- Connection UI --------------------------------------------------------

function setConn(state, cls) {
  conn.textContent = state;
  conn.className = "pill" + (cls ? " " + cls : "");
}

function connectWs() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/?role=controller&room=${encodeURIComponent(room)}`;
  ws = new WebSocket(url);
  ws.addEventListener("open", () => {
    connected = true;
    setConn("connected", "on");
    // Re-sync persisted state on every reconnect.
    const t = loadTemplates();
    if (t) send({ type: "calibrate:templates", templates: t });
    send({ type: "sensitivity", value: loadSensitivity() });
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
      } else if (m.type === "attack-debug") {
        // Live classification feedback (mirrored from server).
        showAttack(m);
      }
    } catch {}
  });
}

function send(obj) {
  if (connected && ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// --- Motion streaming -----------------------------------------------------

let lastMotionAt = 0;

function onMotion(ev) {
  const now = performance.now();
  if (now - lastMotionAt < 15) return; // cap stream at ~60 Hz
  lastMotionAt = now;

  const ag = ev.accelerationIncludingGravity || {};
  const a = ev.acceleration || {};
  const r = ev.rotationRate || {};
  // Prefer gravity-removed acceleration if the phone provided it.
  const accel = a && a.x != null ? { x: a.x, y: a.y, z: a.z }
                                 : { x: ag.x || 0, y: ag.y || 0, z: ag.z || 0 };
  const rotationRate = {
    alpha: r.alpha ?? 0, beta: r.beta ?? 0, gamma: r.gamma ?? 0,
  };

  const payload = {
    type: "motion",
    t: Date.now(),
    acceleration: accel,
    accelerationIncludingGravity: { x: ag.x ?? 0, y: ag.y ?? 0, z: ag.z ?? 0 },
    rotationRate,
  };
  send(payload);

  // Live debug bars.
  const aMag = Math.hypot(accel.x, accel.y, accel.z);
  const wMag = Math.hypot(rotationRate.alpha, rotationRate.beta, rotationRate.gamma); // deg/s
  magEl.textContent = aMag.toFixed(1);
  omegaEl.textContent = wMag.toFixed(0);
  // Bars: scale so a brisk swing fills them.
  barA.style.width = Math.min(100, (aMag / 40) * 100).toFixed(0) + "%";
  barW.style.width = Math.min(100, (wMag / 600) * 100).toFixed(0) + "%";

  if (calib.active && calib.recording) calib.onLive(aMag, wMag);
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

function showAttack(m) {
  lastEl.textContent = m.direction || "—";
  modeEl.textContent = m.mode || "—";
  scoreEl.textContent = m.score != null ? m.score.toFixed(2) : "—";
  if (m.scores) {
    const sorted = Object.entries(m.scores).sort((a, b) => b[1] - a[1]);
    scoresRow.hidden = false;
    scoresRow.innerHTML = sorted
      .map(([d, s]) => `<span class="${d === m.direction ? "win" : ""}">${d}:${s.toFixed(2)}</span>`)
      .join(" ");
  } else {
    scoresRow.hidden = true;
  }
}

// --- iOS permission gate --------------------------------------------------

const isSecure = location.protocol === "https:"
              || location.hostname === "localhost"
              || location.hostname === "127.0.0.1";

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
      showError("Permission call failed", `<p><code>${err?.name || err}</code></p>`);
    }
    return false;
  }

  if (motion !== "granted" || orient !== "granted") {
    showError(
      "Motion permission denied",
      "<p>iOS reported <b>denied</b>. Usually:</p><ol>" +
      "<li><b>Settings → Safari → Motion &amp; Orientation Access</b> is OFF.</li>" +
      (!isSecure ? "<li>This page is on <b>HTTP</b>; iOS needs HTTPS.</li>" : "") +
      "<li>You previously tapped <b>Don't Allow</b>. Clear <b>Settings → Safari → Advanced → Website Data</b>.</li>" +
      "</ol>",
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
  // Init slider from storage.
  sensSlider.value = loadSensitivity();
  sensVal.textContent = Number(sensSlider.value).toFixed(2);
});

if (typeof DeviceMotionEvent === "undefined"
    || typeof DeviceMotionEvent.requestPermission !== "function") {
  startBtn.textContent = "Connect";
}
if (!isSecure && typeof DeviceMotionEvent !== "undefined"
    && typeof DeviceMotionEvent.requestPermission === "function") {
  showError(
    "This page needs HTTPS",
    "<p>iOS Safari will reject motion access on plain HTTP.</p>" +
    "<p>On the Mac run:</p><pre>cloudflared tunnel --url http://localhost:8080</pre>",
  );
}

// --- Sensitivity slider ---------------------------------------------------

sensSlider.addEventListener("input", () => {
  const v = parseFloat(sensSlider.value);
  sensVal.textContent = v.toFixed(2);
  saveSensitivity(v);
  send({ type: "sensitivity", value: v });
});

// --- Touch buttons --------------------------------------------------------

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

document.getElementById("reset-calib").addEventListener("click", () => {
  if (!confirm("Forget calibration on this phone?")) return;
  clearTemplates();
  send({ type: "calibrate:reset" });
  updateCalibStatus();
});

// --- Calibration wizard ---------------------------------------------------

const CALIB_STEPS = [
  { dir: "right",  arrow: "→",  hint: "Swing your phone from LEFT to RIGHT like a horizontal slash." },
  { dir: "left",   arrow: "←",  hint: "Swing from RIGHT to LEFT." },
  { dir: "up",     arrow: "↑",  hint: "Swing UP, uppercut from waist to head." },
  { dir: "down",   arrow: "↓",  hint: "Swing DOWN, a chop from high to low." },
  { dir: "thrust", arrow: "•→", hint: "Push the phone FORWARD, like stabbing at a target." },
];

const calib = {
  active: false,
  stepIdx: 0,
  recording: false,
  overlay:     document.getElementById("calib-overlay"),
  title:       document.getElementById("calib-title"),
  instruction: document.getElementById("calib-instruction"),
  arrow:       document.getElementById("calib-arrow"),
  countdown:   document.getElementById("calib-countdown"),
  feedback:    document.getElementById("calib-feedback"),
  bars:        document.getElementById("calib-bars"),
  barA:        document.getElementById("calib-bar-a"),
  barW:        document.getElementById("calib-bar-w"),
  nextBtn:     document.getElementById("calib-next"),
  cancelBtn:   document.getElementById("calib-cancel"),
  captured: {},
  peakA: 0,
  peakW: 0,

  open() {
    this.active = true;
    this.stepIdx = 0;
    this.captured = loadTemplates() || {};
    this.overlay.hidden = false;
    this._renderStep();
    this.feedback.textContent = "Hold the phone comfortably as your sword grip. You'll do 5 test swings.";
    this.nextBtn.textContent = "Start";
    this.bars.hidden = true;
  },

  cancel() {
    this.active = false;
    if (this.recording) send({ type: "calibrate:end" });
    this.recording = false;
    this.overlay.hidden = true;
  },

  _renderStep() {
    const step = CALIB_STEPS[this.stepIdx];
    this.title.textContent = `Step ${this.stepIdx + 1} / ${CALIB_STEPS.length}: ${step.dir}`;
    this.instruction.textContent = step.hint;
    this.arrow.textContent = step.arrow;
    this.countdown.textContent = "";
    document.querySelectorAll(".calib-progress [data-step]").forEach((el) => {
      const d = el.dataset.step;
      el.classList.toggle("done",    !!this.captured[d]);
      el.classList.toggle("current", d === step.dir);
    });
  },

  _startRecording() {
    const step = CALIB_STEPS[this.stepIdx];
    this.recording = true;
    this.peakA = 0;
    this.peakW = 0;
    this.nextBtn.disabled = true;
    this.nextBtn.textContent = "Recording…";
    this.feedback.textContent = "";
    this.bars.hidden = false;
    send({ type: "calibrate:start", direction: step.dir });

    let t = 2;
    this.countdown.textContent = `Swing in ${t}…`;
    const tick = () => {
      t -= 1;
      if (t > 0) {
        this.countdown.textContent = `Swing in ${t}…`;
        setTimeout(tick, 700);
      } else {
        this.countdown.textContent = "SWING NOW!";
        setTimeout(() => {
          this.countdown.textContent = "Analyzing…";
          send({ type: "calibrate:end" });
        }, 1800);
      }
    };
    setTimeout(tick, 700);
  },

  onLive(aMag, wMag) {
    if (aMag > this.peakA) this.peakA = aMag;
    if (wMag > this.peakW) this.peakW = wMag;
    this.barA.style.width = Math.min(100, (aMag / 40) * 100).toFixed(0) + "%";
    this.barW.style.width = Math.min(100, (wMag / 600) * 100).toFixed(0) + "%";
  },

  onStartedAck(direction, ok) {
    if (!ok) {
      this.feedback.textContent = `Server rejected ${direction}.`;
      this.recording = false;
      this.nextBtn.disabled = false;
      this.nextBtn.textContent = "Retry";
    }
  },

  onRecorded(captured) {
    if (!this.active) return;
    this.recording = false;
    this.nextBtn.disabled = false;
    this.bars.hidden = true;

    if (!captured) {
      const hint = this.peakA < 4 && this.peakW < 60
        ? "No motion detected. Make sure you're actually swinging during the SWING NOW prompt."
        : "Swing was too subtle. Try a bit more distinct / faster.";
      this.feedback.textContent = `${hint} (peak |a|=${this.peakA.toFixed(1)}, |ω|=${this.peakW.toFixed(0)}°/s)`;
      this.nextBtn.textContent = "Retry";
      return;
    }
    const step = CALIB_STEPS[this.stepIdx];
    this.captured[step.dir] = captured;
    saveTemplates(this.captured);
    this.feedback.textContent = `Captured (peak=${captured.mag.toFixed(2)}). Looking good.`;
    this.stepIdx += 1;
    if (this.stepIdx >= CALIB_STEPS.length) {
      this._finish();
    } else {
      this._renderStep();
      this.nextBtn.textContent = "Next";
    }
  },

  _finish() {
    this.title.textContent = "Calibration complete";
    this.instruction.textContent = "Your swings are stored on this phone and sent to the server.";
    this.arrow.textContent = "✓";
    this.countdown.textContent = "";
    this.nextBtn.textContent = "Close";
    send({ type: "calibrate:templates", templates: this.captured });
    updateCalibStatus();
  },

  onNext() {
    if (this.recording) return;
    if (this.stepIdx >= CALIB_STEPS.length) { this.cancel(); return; }
    this._startRecording();
  },
};

document.getElementById("open-calib").addEventListener("click", () => calib.open());
calib.nextBtn.addEventListener("click", () => calib.onNext());
calib.cancelBtn.addEventListener("click", () => calib.cancel());

updateCalibStatus();
