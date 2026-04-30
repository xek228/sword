// Converts a stream of DeviceMotion samples (acceleration + rotation rate)
// into discrete 4-directional "swings" + thrusts, Mount & Blade-style.
//
// Two classification modes:
//   1. Axis-based (default): pick the dominant signed-axis peak in the
//      assumed "phone held in portrait" frame. Robust but assumes the
//      user holds the phone the way the defaults expect.
//   2. Template-based (after calibration): store one recorded peak
//      acceleration vector per direction, classify new swings by
//      max cosine similarity to those templates. Handles arbitrary
//      phone orientation and per-user swing style.
//
// Calibration: setCalibrationMode(direction) tells the detector to
// record the peak vector of the next motion burst into templates[direction].
// The calibrator is responsible for driving this sequence from the client.

const SWING_PEAK_G = 18;          // m/s^2, typical hard shake is ~20-40
const THRUST_PEAK_G = 14;         // thrust is usually softer but more axial
const REFRACTORY_MS = 350;        // don't fire again for this long after a swing
const WINDOW_MS = 200;            // look back this far to find the dominant axis
const CALIB_MIN_PEAK = 8;         // below this, a calibration swing is rejected
const TEMPLATE_MIN_COSINE = 0.35; // below this, template classification bails out

const DIRECTIONS = ["up", "down", "left", "right", "thrust"];

function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function norm(v)   { return Math.hypot(v.x, v.y, v.z); }
function cosSim(a, b) {
  const na = norm(a), nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

export class GestureDetector {
  constructor() {
    this.samples = [];             // recent samples in window
    this.lastFireAt = 0;
    this.inSwing = false;
    this.gravity = { x: 0, y: 0, z: -9.81 }; // slow-tracked gravity estimate

    this.templates = {};           // { direction: { v: {x,y,z}, mag } }
    this.calibDirection = null;    // if set, next peak is stored under this dir
  }

  calibrate() {
    this.samples = [];
    this.lastFireAt = 0;
    this.inSwing = false;
    this.calibDirection = null;
  }

  setTemplates(templates) {
    const cleaned = {};
    for (const d of DIRECTIONS) {
      const t = templates && templates[d];
      if (t && t.v && Number.isFinite(t.v.x) && Number.isFinite(t.v.y) && Number.isFinite(t.v.z)
          && Number.isFinite(t.mag) && t.mag >= CALIB_MIN_PEAK) {
        cleaned[d] = { v: { x: t.v.x, y: t.v.y, z: t.v.z }, mag: t.mag };
      }
    }
    this.templates = cleaned;
  }

  clearTemplates() {
    this.templates = {};
  }

  getTemplates() {
    return this.templates;
  }

  startCalibration(direction) {
    if (!DIRECTIONS.includes(direction)) return false;
    this.calibDirection = direction;
    this.samples = [];
    this.inSwing = false;
    return true;
  }

  // Call after the user performs the calibration swing. Returns the captured
  // peak vector + magnitude (or null if the swing was too weak).
  endCalibration() {
    const d = this.calibDirection;
    this.calibDirection = null;
    if (!d) return null;
    if (this.samples.length === 0) return null;

    // Peak is the sample with max magnitude.
    let peak = this.samples[0];
    for (const s of this.samples) if (s.mag > peak.mag) peak = s;
    if (peak.mag < CALIB_MIN_PEAK) return null;

    const v = { x: peak.ax, y: peak.ay, z: peak.az };
    this.templates[d] = { v, mag: peak.mag };
    this.samples = [];
    return { direction: d, v, mag: Number(peak.mag.toFixed(2)) };
  }

  ingest(msg) {
    const now = msg.t || Date.now();
    const ag = msg.accelerationIncludingGravity || { x: 0, y: 0, z: 0 };
    const a = msg.acceleration || null;

    let ax, ay, az;
    if (a && (a.x != null) && (a.y != null) && (a.z != null)) {
      ax = a.x; ay = a.y; az = a.z;
    } else {
      const alpha = 0.9;
      this.gravity.x = alpha * this.gravity.x + (1 - alpha) * ag.x;
      this.gravity.y = alpha * this.gravity.y + (1 - alpha) * ag.y;
      this.gravity.z = alpha * this.gravity.z + (1 - alpha) * ag.z;
      ax = ag.x - this.gravity.x;
      ay = ag.y - this.gravity.y;
      az = ag.z - this.gravity.z;
    }

    const mag = Math.hypot(ax, ay, az);
    this.samples.push({ t: now, ax, ay, az, mag });

    const cutoff = now - WINDOW_MS;
    while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();

    // During calibration we just accumulate samples; endCalibration() extracts
    // the peak. Don't fire attack events.
    if (this.calibDirection) return null;

    if (now - this.lastFireAt < REFRACTORY_MS) return null;

    if (!this.inSwing) {
      if (mag > Math.min(SWING_PEAK_G, THRUST_PEAK_G)) this.inSwing = true;
      return null;
    }

    // Wait for falling edge.
    const n = this.samples.length;
    if (n < 3) return null;
    const last3 = this.samples.slice(-3);
    const falling = last3[2].mag < last3[1].mag && last3[1].mag < last3[0].mag * 1.02;
    if (!falling && mag > SWING_PEAK_G * 0.4) return null;

    // Find peak vector + magnitude.
    let peak = this.samples[0];
    for (const s of this.samples) if (s.mag > peak.mag) peak = s;
    if (peak.mag < THRUST_PEAK_G) {
      this.inSwing = false;
      return null;
    }

    const direction = this._classify(peak);
    if (!direction) { this.inSwing = false; return null; }

    this.lastFireAt = now;
    this.inSwing = false;
    return { direction, peakMag: Number(peak.mag.toFixed(2)), t: now };
  }

  _classify(peak) {
    const calibrated = Object.keys(this.templates);
    if (calibrated.length >= 3) {
      // Template-based: pick the direction whose recorded peak vector is most
      // similar (cosine) to this swing. Requires at least 3 templates to be
      // reasonably disambiguating.
      let best = null, bestScore = -Infinity;
      const pv = { x: peak.ax, y: peak.ay, z: peak.az };
      for (const d of calibrated) {
        const score = cosSim(pv, this.templates[d].v);
        if (score > bestScore) { bestScore = score; best = d; }
      }
      if (bestScore < TEMPLATE_MIN_COSINE) return null;
      return best;
    }

    // Fallback: axis-based classifier in the phone's native frame.
    // Use the signed peak of each axis over the window.
    let sx = 0, sy = 0, sz = 0;
    for (const s of this.samples) {
      if (Math.abs(s.ax) > Math.abs(sx)) sx = s.ax;
      if (Math.abs(s.ay) > Math.abs(sy)) sy = s.ay;
      if (Math.abs(s.az) > Math.abs(sz)) sz = s.az;
    }
    const absX = Math.abs(sx), absY = Math.abs(sy), absZ = Math.abs(sz);
    if (absZ > absX && absZ > absY && peak.mag < SWING_PEAK_G * 1.4) return "thrust";
    if (absX > absY) return sx > 0 ? "right" : "left";
    return sy > 0 ? "up" : "down";
  }
}
