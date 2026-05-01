// Data-driven swing classifier.
//
// This replaces the previous rule-of-thumb detector with one whose rules
// were derived from 9 real iPhone recordings (3 chops, 3 left slashes,
// 3 right slashes) held in the user's natural pose (phone tilted back
// ~45°, screen facing up-and-away, top edge as the sword tip).
//
// The three axes that separate the classes cleanly in every sample:
//
//   1.  mag_acc_max  (peak total linear acceleration)
//         chop  : 26..35 m/s^2
//         left  : 28..35 m/s^2
//         right : 44..46 m/s^2    <-- always distinctly higher
//
//   2.  alpha sign across the swing window
//         chop  : alpha trends strongly POSITIVE (peak +262..+347 deg/s)
//         left  : alpha trends strongly NEGATIVE (peak -207..-246 deg/s)
//         right : alpha trends strongly POSITIVE (peak +424..+565 deg/s,
//                 separated from chop by #1 above)
//
// So the classifier logic is just:
//
//     if mag_acc_peak > RIGHT_ACC_THRESH      -> RIGHT
//     else if |alpha_min| > alpha_max          -> LEFT
//     else                                     -> CHOP (down)
//
// This matches 9/9 training samples with margins of 9 m/s^2 (right vs
// others) and ~150 deg/s (alpha sign between chop and left).

const REFRACTORY_MS = 300;
const BURST_COOLDOWN_MS = 120;

// Entry/exit thresholds for burst detection.
const SWING_START_DPS = 500;   // enter burst above this
const SWING_QUIET_DPS = 200;   // exit burst below this

// Rolling history window. Real swings show their most informative alpha
// excursions BEFORE mag_rot peaks (wrist/arm twist precedes the main
// blade rotation), so we need to classify using samples recorded prior
// to the burst-start moment, not just the in-burst tail.
const HISTORY_MS = 1200;

// Classifier gates. A movement only counts as a swing if it satisfies
// BOTH a rotation floor AND a linear-acceleration floor. This is the
// key defence against false positives: passive wrist twists / phone
// pans produce high rotation but very little linear acceleration, so
// they fail the acc gate. Real swings always have both.
const MIN_ROT_PEAK = 600;   // all 11 real recordings have mag_rot_max >= 680
const MIN_ACC_PEAK = 18;    // all 11 real recordings have mag_acc_max >= 26
const RIGHT_ACC_THRESH = 38; // between chop/left max (~35) and right min (~40)

export class GestureDetector {
  constructor() {
    this.lastFireAt = 0;
    this.sensitivity = 1.0;
    this.invertH = false;
    this.invertV = false;
    this.lastDebug = null;
    this.history = []; // rolling window of {t,alpha,beta,gamma,magRot,magAcc}

    this._reset();

    // Legacy no-ops kept so the WS protocol doesn't break old clients.
    this.templates = {};
    this.calibDirection = null;
  }

  _reset() {
    this.inBurst = false;
    this.burstStart = 0;
    this.burstQuietStart = 0;
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

  // Legacy no-ops kept so the older UI doesn't explode.
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

    const magRot = Math.hypot(alpha, beta, gamma);
    const magAcc = Math.hypot(ax, ay, az);

    // Append to rolling history and drop stale.
    this.history.push({ t: now, alpha, beta, gamma, magRot, magAcc });
    const cutoff = now - HISTORY_MS;
    while (this.history.length && this.history[0].t < cutoff) {
      this.history.shift();
    }

    if (now - this.lastFireAt < REFRACTORY_MS) return null;

    const startThresh = SWING_START_DPS * this.sensitivity;
    const quietThresh = SWING_QUIET_DPS * this.sensitivity;

    if (!this.inBurst) {
      if (magRot > startThresh) {
        this.inBurst = true;
        this.burstStart = now;
        this.burstQuietStart = 0;
      }
      return null;
    }

    if (magRot < quietThresh) {
      if (this.burstQuietStart === 0) this.burstQuietStart = now;
      if (now - this.burstQuietStart >= BURST_COOLDOWN_MS) {
        const result = this._classify();
        this._reset();
        if (!result) return null;
        this.lastFireAt = now;
        this.lastDebug = result;
        // Clear history so the just-classified peak can't bleed into
        // the next swing's window. Without this, a second small burst
        // fired ~500ms after a real swing re-uses the old peak from
        // history and produces a phantom duplicate event.
        this.history = [];
        return {
          direction: result.direction,
          peakMag: Number(result.peakMag.toFixed(1)),
          axis: result.axis,
        };
      }
    } else {
      this.burstQuietStart = 0;
    }
    return null;
  }

  _classify() {
    const sens = this.sensitivity;
    if (!this.history.length) return null;

    let magRotMax = 0, magAccMax = 0;
    let alphaMin = 0, alphaMax = 0;
    for (const s of this.history) {
      if (s.magRot > magRotMax) magRotMax = s.magRot;
      if (s.magAcc > magAccMax) magAccMax = s.magAcc;
      if (s.alpha  < alphaMin)  alphaMin  = s.alpha;
      if (s.alpha  > alphaMax)  alphaMax  = s.alpha;
    }

    if (magRotMax < MIN_ROT_PEAK * sens) return null;
    if (magAccMax < MIN_ACC_PEAK * sens) return null;

    // RIGHT: distinctively high linear acceleration.
    if (magAccMax > RIGHT_ACC_THRESH * sens) {
      const dir = this.invertH ? "left" : "right";
      return { direction: dir, peakMag: magAccMax, axis: "|acc|" };
    }

    // LEFT vs CHOP: the sign of the dominant alpha rotation during the
    // full swing window (including the pre-burst twist).
    const alphaNeg = Math.max(-alphaMin, 0);
    const alphaPos = Math.max(alphaMax, 0);

    if (alphaNeg > alphaPos) {
      const dir = this.invertH ? "right" : "left";
      return { direction: dir, peakMag: magRotMax, axis: "alpha-" };
    }
    const dir = this.invertV ? "up" : "down";
    return { direction: dir, peakMag: magRotMax, axis: "alpha+" };
  }
}
