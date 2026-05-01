// iPhone-side controller. Requests DeviceMotion permission, opens a
// WebSocket, streams motion + button events, and renders a live view
// of the raw gyro axes + last detected swing. No calibration step —
// detection is now pose-fixed and deterministic.

const $ = (id) => document.getElementById(id);

const conn = $("conn");
const startBtn = $("start-btn");
const gate = $("permission-gate");
const ui = $("play-ui");

const barBeta  = $("bar-beta");
const barAlpha = $("bar-alpha");
const barGamma = $("bar-gamma");
const barAcc   = $("bar-acc");
const vBeta  = $("v-beta");
const vAlpha = $("v-alpha");
const vGamma = $("v-gamma");
const vAcc   = $("v-acc");
const lastSwing = $("last-swing");

const sensSlider = $("sens-slider");
const sensVal = $("sens-val");
const invertH = $("invert-h");
const invertV = $("invert-v");

const params = new URLSearchParams(location.search);
const room = params.get("room") || "default";

const CFG_KEY = `sword-cfg:${room}`;

let ws = null;
let connected = false;
let sensorsActive = false;

// --- Config persistence ---------------------------------------------------

function loadCfg() {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (raw) return { sensitivity: 1.0, invertH: false, invertV: false, ...JSON.parse(raw) };
  } catch {}
  return { sensitivity: 1.0, invertH: false, invertV: false };
}
function saveCfg(cfg) {
  try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch {}
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
    send({ type: "config", value: loadCfg() });
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
      } else if (m.type === "attack-debug") {
        flashLastSwing(m);
      } else if (m.type === "record:started") {
        recStatus.textContent = `Recording "${m.label}"…`;
      } else if (m.type === "record:saved") {
        if (m.ok) {
          recStatus.innerHTML = `Saved <b>${m.filename}</b> · ${m.sampleCount} samples · ${(m.durationMs/1000).toFixed(2)}s`;
        } else {
          recStatus.textContent = `save failed: ${m.error || "?"}`;
        }
      }
    } catch {}
  });
}

function send(obj) {
  if (connected && ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

// --- Motion streaming -----------------------------------------------------

let lastMotionAt = 0;

function onMotion(ev) {
  const now = performance.now();
  if (now - lastMotionAt < 16) return; // cap stream at ~60 Hz
  lastMotionAt = now;

  const ag = ev.accelerationIncludingGravity || {};
  const a  = ev.acceleration || {};
  const r  = ev.rotationRate || {};
  const accel = (a && a.x != null) ? { x: a.x, y: a.y, z: a.z }
                                   : { x: ag.x || 0, y: ag.y || 0, z: ag.z || 0 };
  const rotationRate = {
    alpha: r.alpha ?? 0, beta: r.beta ?? 0, gamma: r.gamma ?? 0,
  };

  send({
    type: "motion",
    t: Date.now(),
    acceleration: accel,
    accelerationIncludingGravity: { x: ag.x ?? 0, y: ag.y ?? 0, z: ag.z ?? 0 },
    rotationRate,
  });

  // Live bars.
  const aMag = Math.hypot(accel.x, accel.y, accel.z);
  renderBar(barBeta,  vBeta,  rotationRate.beta,  600);
  renderBar(barAlpha, vAlpha, rotationRate.alpha, 600);
  renderBar(barGamma, vGamma, rotationRate.gamma, 600);
  renderBar(barAcc,   vAcc,   aMag,               40);
}

function renderBar(el, valEl, v, scale) {
  const abs = Math.abs(v);
  el.style.width = Math.min(100, (abs / scale) * 100).toFixed(0) + "%";
  valEl.textContent = v >= 0 ? `+${abs.toFixed(0)}` : `-${abs.toFixed(0)}`;
}

function onOrientation(ev) {
  send({
    type: "orientation",
    t: Date.now(),
    alpha: ev.alpha ?? 0, beta: ev.beta ?? 0, gamma: ev.gamma ?? 0,
  });
}

function flashLastSwing(m) {
  lastSwing.innerHTML = `last swing: <b class="hit-${m.direction}">${m.direction}</b> (${m.axis || "—"}, ${m.peakMag}°/s)`;
  lastSwing.classList.remove("flash");
  void lastSwing.offsetWidth;
  lastSwing.classList.add("flash");
}

// --- iOS permission gate --------------------------------------------------

const isSecure = location.protocol === "https:"
              || location.hostname === "localhost"
              || location.hostname === "127.0.0.1";

function showError(title, body) {
  const box = $("error-box");
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
  try { [motion, orient] = await Promise.all([motionAsk, orientAsk]); }
  catch (err) {
    if (!isSecure) {
      showError("This page needs HTTPS",
        "<p>iOS only prompts for motion access on a secure context.</p>");
    } else {
      showError("Permission call failed", `<p><code>${err?.name || err}</code></p>`);
    }
    return false;
  }
  if (motion !== "granted" || orient !== "granted") {
    showError("Motion permission denied",
      "<p>iOS reported <b>denied</b>. Check <b>Settings → Safari → Motion &amp; Orientation Access</b>.</p>");
    return false;
  }
  return true;
}

function activateSensors() {
  if (sensorsActive) return;
  sensorsActive = true;
  window.addEventListener("devicemotion",   onMotion,      { passive: true });
  window.addEventListener("deviceorientation", onOrientation, { passive: true });
}

startBtn.addEventListener("click", async () => {
  const ok = await requestSensorPermissions();
  if (!ok) return;
  gate.hidden = true;
  ui.hidden = false;

  const cfg = loadCfg();
  sensSlider.value = cfg.sensitivity;
  sensVal.textContent = cfg.sensitivity.toFixed(2);
  invertH.checked = !!cfg.invertH;
  invertV.checked = !!cfg.invertV;

  connectWs();
  activateSensors();
});

if (typeof DeviceMotionEvent === "undefined"
    || typeof DeviceMotionEvent.requestPermission !== "function") {
  startBtn.textContent = "Connect";
}
if (!isSecure && typeof DeviceMotionEvent !== "undefined"
    && typeof DeviceMotionEvent.requestPermission === "function") {
  showError("This page needs HTTPS",
    "<p>iOS Safari will reject motion access on plain HTTP.</p>" +
    "<p>On the Mac run:</p><pre>cloudflared tunnel --url http://localhost:8080</pre>");
}

// --- Config controls ------------------------------------------------------

function pushCfg() {
  const cfg = {
    sensitivity: parseFloat(sensSlider.value),
    invertH: invertH.checked,
    invertV: invertV.checked,
  };
  saveCfg(cfg);
  send({ type: "config", value: cfg });
}

sensSlider.addEventListener("input", () => {
  sensVal.textContent = parseFloat(sensSlider.value).toFixed(2);
  pushCfg();
});
invertH.addEventListener("change", pushCfg);
invertV.addEventListener("change", pushCfg);

// --- Recording wizard ------------------------------------------------------

const recLabel  = $("rec-label");
const recBtn    = $("rec-btn");
const recStatus = $("rec-status");

let recState = "idle"; // idle | recording
let recStartedAt = 0;
let recTimer = null;

let audioCtx = null;
function beep(freq, durMs) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + durMs / 1000);
    osc.start();
    osc.stop(audioCtx.currentTime + durMs / 1000);
  } catch {}
}

function setRecState(state) {
  recState = state;
  if (state === "recording") {
    recBtn.textContent = "Stop recording";
    recBtn.classList.add("recording");
    recStartedAt = performance.now();
    recTimer = setInterval(() => {
      const s = ((performance.now() - recStartedAt) / 1000).toFixed(1);
      recStatus.textContent = `Recording ${s}s…`;
    }, 100);
  } else {
    recBtn.textContent = "Start recording";
    recBtn.classList.remove("recording");
    if (recTimer) { clearInterval(recTimer); recTimer = null; }
  }
}

recBtn.addEventListener("click", () => {
  if (recState === "idle") {
    const label = (recLabel.value || "swing").trim();
    send({ type: "record:start", label });
    beep(880, 120);
    setRecState("recording");
  } else {
    send({ type: "record:stop" });
    beep(440, 180);
    setRecState("idle");
    recStatus.textContent = "saving…";
  }
});

// --- ML training data recorder --------------------------------------------
//
// Three modes:
//  (1) Quick isolated-swing buttons  → 1.8s auto-record per tap
//  (2) Combo: record a longer take with an announced sequence
//  (3) Background noise: 30s of "no swing" baseline

const QUICK_REC_DURATION_MS = 1800;
const BG_REC_DURATION_MS = 30000;
const COUNTS_KEY = `sword-rec-counts:${room}`;
let recCounts = loadCounts();
renderCounts();

function loadCounts() {
  try {
    const raw = localStorage.getItem(COUNTS_KEY);
    if (raw) return { right: 0, left: 0, down: 0, combo: 0, bg: 0, ...JSON.parse(raw) };
  } catch {}
  return { right: 0, left: 0, down: 0, combo: 0, bg: 0 };
}
function saveCounts() {
  try { localStorage.setItem(COUNTS_KEY, JSON.stringify(recCounts)); } catch {}
}
function renderCounts() {
  for (const k of ["right", "left", "down", "combo", "bg"]) {
    const el = $("cnt-" + k);
    if (el) el.textContent = recCounts[k] || 0;
  }
}

// State machine: only one recording at a time. UI disables ALL recorders
// while one is active so we can't double-trigger record:start.
let recBusy = false;
const allRecBtns = () =>
  Array.from(document.querySelectorAll(".quick-rec, #combo-btn, #bg-btn, #rec-btn"));

function lockUI() { recBusy = true;  allRecBtns().forEach((b) => (b.disabled = true)); }
function unlockUI() { recBusy = false; allRecBtns().forEach((b) => (b.disabled = false)); }

// (1) Quick isolated-swing buttons -----------------------------------------
const quickButtons = document.querySelectorAll(".quick-rec");
quickButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    if (recBusy || recState !== "idle") return;
    const label = btn.dataset.rec; // "right" | "left" | "down"
    lockUI();
    btn.classList.add("recording");
    send({ type: "record:start", label });
    beep(880, 120);
    setRecState("recording");
    recStatus.textContent = `Recording ${label}…`;
    setTimeout(() => {
      send({ type: "record:stop" });
      beep(440, 180);
      setRecState("idle");
      recCounts[label] = (recCounts[label] || 0) + 1;
      saveCounts(); renderCounts();
      btn.classList.remove("recording");
      unlockUI();
    }, QUICK_REC_DURATION_MS);
  });
});

// (2) Combo: manual start/stop with announced sequence ---------------------
const comboBtn = $("combo-btn");
const comboSeq = $("combo-seq");
let comboState = "idle"; // idle | recording
let comboTimer = null;
let comboStartedAt = 0;

comboBtn?.addEventListener("click", () => {
  if (comboState === "idle") {
    if (recBusy || recState !== "idle") return;
    const seq = comboSeq.value; // e.g. "right-left-down"
    const label = "combo_" + seq;
    lockUI();
    comboBtn.disabled = false; // keep stop button enabled
    comboBtn.classList.add("recording");
    comboBtn.firstChild.nodeValue = "Stop combo ";
    send({ type: "record:start", label });
    beep(660, 120); setTimeout(() => beep(990, 120), 180);
    setRecState("recording");
    comboStartedAt = performance.now();
    comboState = "recording";
    comboTimer = setInterval(() => {
      const s = ((performance.now() - comboStartedAt) / 1000).toFixed(1);
      recStatus.textContent = `Recording combo (${seq}) ${s}s…`;
    }, 100);
  } else {
    send({ type: "record:stop" });
    beep(440, 180);
    setRecState("idle");
    if (comboTimer) { clearInterval(comboTimer); comboTimer = null; }
    recCounts.combo = (recCounts.combo || 0) + 1;
    saveCounts(); renderCounts();
    comboBtn.classList.remove("recording");
    comboBtn.firstChild.nodeValue = "Start combo ";
    comboState = "idle";
    unlockUI();
  }
});

// (3) Background noise: 30s auto-record ------------------------------------
const bgBtn = $("bg-btn");
bgBtn?.addEventListener("click", () => {
  if (recBusy || recState !== "idle") return;
  lockUI();
  bgBtn.classList.add("recording");
  send({ type: "record:start", label: "bg" });
  beep(330, 200);
  setRecState("recording");
  const startedAt = performance.now();
  const tick = setInterval(() => {
    const s = ((performance.now() - startedAt) / 1000).toFixed(1);
    recStatus.textContent = `Recording background ${s}s / 30s…`;
  }, 100);
  setTimeout(() => {
    clearInterval(tick);
    send({ type: "record:stop" });
    beep(220, 250);
    setRecState("idle");
    recCounts.bg = (recCounts.bg || 0) + 1;
    saveCounts(); renderCounts();
    bgBtn.classList.remove("recording");
    unlockUI();
  }, BG_REC_DURATION_MS);
});



// --- Touch buttons --------------------------------------------------------

document.querySelectorAll("#touch-pad .big[data-btn]").forEach((btn) => {
  const name = btn.dataset.btn;
  const down = (e) => { e.preventDefault(); send({ type: "button", name, pressed: true }); };
  const up   = (e) => { e.preventDefault(); send({ type: "button", name, pressed: false }); };
  btn.addEventListener("touchstart", down, { passive: false });
  btn.addEventListener("touchend",   up,   { passive: false });
  btn.addEventListener("mousedown", down);
  btn.addEventListener("mouseup",   up);
  btn.addEventListener("mouseleave", up);
});
