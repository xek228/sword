// Dead-simple motion detector for a FIXED phone pose.
//
// This is intentionally stupid. After the complex 6D-template classifier
// randomly confused the user's swings, we pivoted to: "pick one pose, one
// axis per swing type, large thresholds, no calibration." Nothing fancy,
// no shaped recognisers, no cosine similarity. If a single rotation axis
// exceeds a threshold for ~50ms, we fire an event. End of algorithm.
//
// Assumed pose (the controller UI will show this as a diagram):
//   Phone held vertically (portrait), screen facing the player,
//   top edge pointing up (= imaginary sword tip).
//
// Axis mapping in that pose (iOS rotationRate is deg/s, phone frame):
//   rotationRate.beta  (spin around phone long axis / world vertical):
//     + = right swing, - = left swing
//   rotationRate.alpha (tip top forward/back):
//     + = down chop, - = up swing
//   linear acceleration z (out the back of the screen):
//     strongly negative AND no rotation = thrust
//
// The four *sign* defaults can be flipped per-axis via config so that
// players who hold the phone with screen facing away or upside-down
// don't need a code change — they just tap a toggle in the UI.

const REFRACTORY_MS = 300;
const BURST_COOLDOWN_MS = 120; // min quiet time to end a swing burst

// Default thresholds. `sensitivity` scales them: 1.0 = defaults,
// 0.5 = twice as sensitive, 2.0 = needs a very hard swing.
const ROT_THRESHOLD_DPS  = 250; // deg/s on the dominant axis
const ACC_THRESHOLD_MPS2 = 22;  // m/s^2 forward for thrust
const ROT_QUIET_DPS      = 120; // below this on all axes = "rest"

export class GestureDetector {
  constructor() {
    this.lastFireAt = 0;
    this.inBurst = false;
    this.burstStart = 0;
    this.burstQuietStart = 0;
    this.burstPeak = null; // {alpha, beta, gamma, ax, ay, az, magRot}
    this.sensitivity = 1.0;

    // Per-axis sign flips, so players can adjust if they hold the phone
    // with screen away / upside-down without recalibrating.
    this.invertH = false; // flips right <-> left
    this.invertV = false; // flips up    <-> down

    this.lastDebug = null;

    // Legacy no-ops kept so the WS protocol doesn't break.
    this.templates = {};
    this.calibDirection = null;
  }

  setSensitivity(s) {
    if (typeof s === "number" && Number.isFinite(s) && s > 0) {
      this.sensitivity = Math.max(0.3, Math.min(3.0, s));
    }
  }

  setConfig(cfg = {}) {
    if (typeof cfg.sensitivity === "number") this.setSensitivity(cfg.sensitivity);
    if (typeof cfg.invertH === "boolean") this.invertH = cfg.invertH;
    if (typeof cfg.invertV === "boolean") this.invertV = cfg.invertV;
  }

  getConfig() {
    return {
      sensitivity: this.sensitivity,
      invertH: this.invertH,
      invertV: this.invertV,
    };
  }

  // Legacy API kept as no-ops so the older UI doesn't explode.
  startCalibration() { return false; }
  endCalibration()   { return null; }
  setTemplates()     {}
  getTemplates()     { return {}; }
  clearTemplates()   {}
  calibrate()        {}

  ingest(msg) {
    const now = msg.t ?? Date.now();
    const a  = msg.acceleration || msg.accelerationIncludingGravity || {};
    const rr = msg.rotationRate || {};
    const alpha = Number(rr.alpha) || 0;
    const beta  = Number(rr.beta)  || 0;
    const gamma = Number(rr.gamma) || 0;
    const ax = Number(a.x) || 0;
    const ay = Number(a.y) || 0;
    const az = Number(a.z) || 0;

    const magRot = Math.max(Math.abs(alpha), Math.abs(beta), Math.abs(gamma));
    const magAcc = Math.hypot(ax, ay, az);

    if (now - this.lastFireAt < REFRACTORY_MS) return null;

    const rotThresh = ROT_THRESHOLD_DPS * this.sensitivity;
    const accThresh = ACC_THRESHOLD_MPS2 * this.sensitivity;
    const quietThresh = ROT_QUIET_DPS * this.sensitivity;

    const isActive = magRot > rotThresh || magAcc > accThresh;

    if (!this.inBurst && isActive) {
      // Start a new burst, begin tracking peak.
      this.inBurst = true;
      this.burstStart = now;
      this.burstQuietStart = 0;
      this.burstPeak = { alpha, beta, gamma, ax, ay, az, magRot, magAcc };
      return null;
    }

    if (this.inBurst) {
      // Update peak — pick sample with the largest rotation magnitude,
      // or if rotation stayed low the whole time, the largest accel.
      const p = this.burstPeak;
      const betterRot = magRot > p.magRot;
      const betterAcc = magRot < quietThresh && p.magRot < quietThresh && magAcc > p.magAcc;
      if (betterRot || betterAcc) {
        this.burstPeak = { alpha, beta, gamma, ax, ay, az, magRot, magAcc };
      }

      if (magRot < quietThresh && magAcc < accThresh * 0.6) {
        if (this.burstQuietStart === 0) this.burstQuietStart = now;
        if (now - this.burstQuietStart >= BURST_COOLDOWN_MS) {
          // Burst ended: classify peak.
          const result = this._classify(this.burstPeak);
          this.inBurst = false;
          this.burstPeak = null;
          this.burstQuietStart = 0;
          if (!result) return null;
          this.lastFireAt = now;
          this.lastDebug = result;
          return {
            direction: result.direction,
            peakMag: Number(result.peakMag.toFixed(1)),
            axis: result.axis,
          };
        }
      } else {
        this.burstQuietStart = 0;
      }
    }
    return null;
  }

  _classify(peak) {
    if (!peak) return null;
    const { alpha, beta, gamma, magRot, magAcc } = peak;
    const rotThresh = ROT_THRESHOLD_DPS * this.sensitivity;
    const accThresh = ACC_THRESHOLD_MPS2 * this.sensitivity;

    // Any sharp linear translation of the phone with little rotation
    // = overhead chop. We deliberately do NOT constrain which phone
    // axis the acceleration is on: the player may hold the phone
    // vertically (screen toward them, jab along -Z) or sideways like
    // a blade (top edge forward, jab along +Y) — both should produce
    // a chop. Thrust is bound to Spacebar in the game.
    if (magRot < rotThresh * 0.7 && magAcc > accThresh) {
      const down = !this.invertV;
      return { direction: down ? "down" : "up", peakMag: magAcc, axis: "accel" };
    }

    // Rotation: pick dominant of the three gyro axes.
    const absA = Math.abs(alpha), absB = Math.abs(beta), absG = Math.abs(gamma);
    if (magRot < rotThresh) return null;

    if (absB >= absA && absB >= absG) {
      const positive = beta > 0;
      const swing = positive !== this.invertH ? "right" : "left";
      return { direction: swing, peakMag: absB, axis: "beta" };
    }
    if (absA >= absB && absA >= absG) {
      const positive = alpha > 0;
      const swing = positive !== this.invertV ? "down" : "up";
      return { direction: swing, peakMag: absA, axis: "alpha" };
    }
    // Pure roll around the through-screen axis doesn't map to a named
    // direction; fall back to the horizontal slash sign, since a wrist
    // roll is closest to a quick side swipe.
    const positive = gamma > 0;
    const swing = positive !== this.invertH ? "right" : "left";
    return { direction: swing, peakMag: absG, axis: "gamma" };
  }
}
