// Converts a stream of DeviceMotion samples (acceleration + rotation rate)
// into discrete 4-directional "swings" + thrusts, Mount & Blade-style.
//
// Design rationale (after testing the original axis-based classifier):
//
// A sword-style swing is fundamentally a *rotation*. When the user holds the
// phone at the grip, linear acceleration at the grip can be small (all the
// speed is at the "blade tip"), but the angular velocity is very clear and
// uniquely-directed per swing type. So: fuse linear accel + angular velocity
// into a single 6D peak vector and classify by cosine similarity to
// user-recorded templates. This is grip-invariant as long as the user always
// holds the phone the same way when playing.
//
// Signals:
//   a = acceleration (m/s^2, gravity removed if possible) in phone frame
//   ω = rotationRate (deg/s) in phone frame; converted to rad/s internally
// Peak fires when  max(|a| / ACC_SCALE, |ω| / GYRO_SCALE) > sensitivity.
//
// Two classification modes:
//   1. Axis-based (default): pick the dominant signed-axis peak in the
//      assumed "phone held in portrait" frame. Robust first-use but
//      assumes the user holds the phone the way the defaults expect.
//   2. Template-based (after calibration): cosine similarity of the peak
//      6D vector against recorded templates; largest wins. Handles any
//      grip and per-user swing style.
//
// Calibration flow: startCalibration(direction) → server ingests swing →
// endCalibration() returns { direction, accel, gyro, score } or null.

// --- Tunables -------------------------------------------------------------

// Normalisation so accel (m/s^2) and gyro (rad/s) contribute similarly to
// peak magnitude. A typical "brisk swing" is ~15 m/s^2 OR ~5 rad/s.
const ACC_SCALE  = 15;
const GYRO_SCALE = 5;

// Peak thresholds in the normalised units. `SENSITIVITY` scales these: the
// controller can adjust it (0.5 = very sensitive, 2.0 = needs a hard swing).
const BASE_PEAK = 1.0;

const REFRACTORY_MS       = 350;  // don't fire again for this long after a swing
const WINDOW_MS           = 250;  // look-back window to find the dominant peak
const CALIB_MIN_PEAK      = 0.6;  // reject very weak calibration swings
const TEMPLATE_MIN_COSINE = 0.45; // reject low-confidence template matches

const DIRECTIONS = ["up", "down", "left", "right", "thrust"];

// --- Math helpers ---------------------------------------------------------

const DEG2RAD = Math.PI / 180;

function dot6(a, b) {
  return a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3] + a[4]*b[4] + a[5]*b[5];
}
function norm6(v) {
  return Math.hypot(v[0], v[1], v[2], v[3], v[4], v[5]);
}
function cosSim6(a, b) {
  const na = norm6(a), nb = norm6(b);
  if (na === 0 || nb === 0) return 0;
  return dot6(a, b) / (na * nb);
}

function norm3(x, y, z) { return Math.hypot(x, y, z); }

// Normalise a raw [ax,ay,az,ωx,ωy,ωz] (SI units) into the unitless 6D space
// used for peak + template comparisons.
function toFeature(ax, ay, az, wx, wy, wz) {
  return [
    ax / ACC_SCALE, ay / ACC_SCALE, az / ACC_SCALE,
    wx / GYRO_SCALE, wy / GYRO_SCALE, wz / GYRO_SCALE,
  ];
}

// --- Detector -------------------------------------------------------------

export class GestureDetector {
  constructor() {
    this.samples = [];        // recent samples: {t, a:{x,y,z}, w:{x,y,z}, feat, mag}
    this.lastFireAt = 0;
    this.inBurst = false;
    this.sensitivity = 1.0;   // multiplier on peak threshold (low = sensitive)

    this.templates = {};      // { direction: { feat: number[6], mag } }
    this.calibDirection = null;
    this.calibSamples = [];

    // Last classification, for the controller's debug overlay.
    this.lastDebug = null;
  }

  // Allows the UI to persist a sensitivity tweak.
  setSensitivity(s) {
    if (typeof s === "number" && Number.isFinite(s) && s > 0) {
      this.sensitivity = Math.max(0.2, Math.min(3.0, s));
    }
  }

  calibrate() {
    this.samples = [];
    this.lastFireAt = 0;
    this.inBurst = false;
    this.calibDirection = null;
    this.calibSamples = [];
  }

  setTemplates(templates) {
    const cleaned = {};
    for (const d of DIRECTIONS) {
      const t = templates && templates[d];
      if (!t || !Array.isArray(t.feat) || t.feat.length !== 6) continue;
      if (!t.feat.every(Number.isFinite)) continue;
      if (!Number.isFinite(t.mag) || t.mag < CALIB_MIN_PEAK) continue;
      cleaned[d] = { feat: t.feat.slice(), mag: t.mag };
    }
    this.templates = cleaned;
  }

  clearTemplates() { this.templates = {}; }
  getTemplates()   { return this.templates; }

  startCalibration(direction) {
    if (!DIRECTIONS.includes(direction)) return false;
    this.calibDirection = direction;
    this.calibSamples = [];
    this.samples = [];
    this.inBurst = false;
    return true;
  }

  endCalibration() {
    const d = this.calibDirection;
    this.calibDirection = null;
    if (!d) return null;
    // Find peak sample by magnitude.
    if (this.calibSamples.length === 0) { this.calibSamples = []; return null; }
    let peak = this.calibSamples[0];
    for (const s of this.calibSamples) if (s.mag > peak.mag) peak = s;
    const captured = peak.mag;
    this.calibSamples = [];
    if (captured < CALIB_MIN_PEAK) return null;
    const template = { feat: peak.feat.slice(), mag: captured };
    this.templates[d] = template;
    return {
      direction: d,
      mag: Number(captured.toFixed(3)),
      accel: { x: peak.a.x, y: peak.a.y, z: peak.a.z },
      gyro:  { x: peak.w.x, y: peak.w.y, z: peak.w.z },
    };
  }

  // Main entry — accepts a motion sample message from the controller.
  // msg.acceleration: {x,y,z} (gravity-removed if the phone provides it)
  // msg.accelerationIncludingGravity: fallback
  // msg.rotationRate: {alpha, beta, gamma}   (deg/s, phone frame)
  ingest(msg) {
    const now = msg.t ?? Date.now();
    const ag  = msg.acceleration || msg.accelerationIncludingGravity || {};
    const rr  = msg.rotationRate || {};

    const ax = Number(ag.x) || 0;
    const ay = Number(ag.y) || 0;
    const az = Number(ag.z) || 0;
    // rotationRate: alpha = around x, beta = around y, gamma = around z
    // (see MDN "Orientation and motion data explained").
    const wx = (Number(rr.alpha) || 0) * DEG2RAD;
    const wy = (Number(rr.beta)  || 0) * DEG2RAD;
    const wz = (Number(rr.gamma) || 0) * DEG2RAD;

    const feat = toFeature(ax, ay, az, wx, wy, wz);
    const mag = norm6(feat);

    const sample = {
      t: now,
      a: { x: ax, y: ay, z: az },
      w: { x: wx, y: wy, z: wz },
      feat, mag,
    };

    // While calibrating: just collect samples, don't emit.
    if (this.calibDirection) {
      this.calibSamples.push(sample);
      if (this.calibSamples.length > 200) this.calibSamples.shift();
      return null;
    }

    // Rolling window.
    this.samples.push(sample);
    while (this.samples.length && now - this.samples[0].t > WINDOW_MS) {
      this.samples.shift();
    }

    const threshold = BASE_PEAK * this.sensitivity;
    if (now - this.lastFireAt < REFRACTORY_MS) return null;

    if (!this.inBurst && mag > threshold) {
      this.inBurst = true;
    } else if (this.inBurst && mag < threshold * 0.5) {
      // Burst ended: find peak in window and classify.
      this.inBurst = false;
      let peak = this.samples[0];
      for (const s of this.samples) if (s.mag > peak.mag) peak = s;
      if (peak.mag < threshold) return null;

      this.lastFireAt = now;
      const result = this._classify(peak);
      this.lastDebug = {
        peakMag: Number(peak.mag.toFixed(3)),
        peakFeat: peak.feat.map((v) => Number(v.toFixed(3))),
        ...result,
      };
      return {
        direction: result.direction,
        peakMag: Number(peak.mag.toFixed(3)),
        score: Number(result.score.toFixed(3)),
        mode: result.mode,
      };
    }
    return null;
  }

  _classify(peak) {
    const templateKeys = Object.keys(this.templates);
    if (templateKeys.length >= 3) {
      // Template-based.
      let best = null, bestScore = -Infinity;
      const scores = {};
      for (const d of templateKeys) {
        const s = cosSim6(peak.feat, this.templates[d].feat);
        scores[d] = Number(s.toFixed(3));
        if (s > bestScore) { bestScore = s; best = d; }
      }
      if (best && bestScore >= TEMPLATE_MIN_COSINE) {
        return { direction: best, score: bestScore, mode: "template", scores };
      }
      // Fall through to axis-based if no template is confident enough.
    }

    // Axis-based fallback. Look at which signed dimension dominates.
    // Index mapping: 0=ax, 1=ay, 2=az, 3=ωx, 4=ωy, 5=ωz.
    // For a right-swing (phone swung left→right in portrait): +ax OR +ωy.
    // For up-swing: +ay.  For thrust: -az dominant.
    // We pick the axis (of the 6) with greatest |value|.
    let bestIdx = 0, bestAbs = 0;
    for (let i = 0; i < 6; i++) {
      const v = Math.abs(peak.feat[i]);
      if (v > bestAbs) { bestAbs = v; bestIdx = i; }
    }
    const sign = Math.sign(peak.feat[bestIdx]);
    let direction;
    switch (bestIdx) {
      case 0: direction = sign > 0 ? "right" : "left";   break;
      case 1: direction = sign > 0 ? "up"    : "down";   break;
      case 2: direction = sign < 0 ? "thrust" : "thrust"; break;
      // Angular axes use right-hand rule about the corresponding phone axis;
      // map them to the same intuitive directions.
      case 3: direction = sign > 0 ? "up"    : "down";   break; // ωx
      case 4: direction = sign > 0 ? "right" : "left";   break; // ωy
      case 5: direction = sign > 0 ? "right" : "left";   break; // ωz
      default: direction = "thrust";
    }
    return { direction, score: bestAbs, mode: "axis", scores: null };
  }
}
