import { runModel } from "./swingModel.js";

// Swing classifier with two modes:
//
//   * ML mode (preferred): runs a small 1D CNN on a 0.7s sliding window
//     of (rot αβγ, accel xyz) at ~60Hz, outputs probabilities over
//     {none, right, left, down}. Activated automatically when
//     public/model.json is present.
//   * Rule mode (fallback): hand-tuned thresholds on burst features,
//     based on the original 11 recordings. Used until the ML model is
//     trained.
//
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

// ML-mode parameters.
//
// Strategy: instead of streaming the model on every window, we wait for
// a *peak* in rotation magnitude (as a cheap event trigger), then
// classify a window centered on the peak. This matches what the model
// was trained on (windows centered on rotation peaks) and avoids
// out-of-distribution inputs that produce phantom fires during the
// rising / decaying edges of a swing or its recoil.
const ML_BUFFER_MS = 900;           // rolling history we keep
const ML_PEAK_LAG_MS = 100;         // how far back to look for a "peak now"
const ML_PEAK_MIN_MAG = 600;        // min rotation magnitude to count as a peak
const ML_PEAK_NEIGHBOURS = 2;       // local-max test radius (in samples)
const ML_PEAK_OFFSET_FRAMES = 3;    // peak placement: frame (T-1-N) = frame 38
const ML_FIRE_PROB = 0.55;
const ML_FIRE_MARGIN = 0.15;        // winner - none
const ML_REFRACTORY_MS = 600;

export class GestureDetector {
  constructor(opts = {}) {
    this.lastFireAt = 0;
    this.sensitivity = 1.0;
    this.invertH = false;
    this.invertV = false;
    this.lastDebug = null;
    this.history = []; // rolling window of {t,alpha,beta,gamma,magRot,magAcc}

    this.model = opts.model || null;
    this.mlHistory = []; // {t, alpha, beta, gamma, ax, ay, az, magRot}

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

    if (this.model) {
      return this._ingestML(now, alpha, beta, gamma, ax, ay, az);
    }

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

  // ML pipeline: peak-triggered classifier.
  //
  // Maintain a rolling 1.0s buffer. After every new sample, look at the
  // sample ~350ms ago and check if it's a local maximum of rotation
  // magnitude. If yes (and it exceeds a sensitivity-scaled floor), build
  // a window centered on it and run the model. This guarantees the
  // window's distribution matches the training data and avoids spurious
  // fires during the rising/decaying edges of a swing.
  _ingestML(now, alpha, beta, gamma, ax, ay, az) {
    const magRot = Math.hypot(alpha, beta, gamma);
    this.mlHistory.push({ t: now, alpha, beta, gamma, ax, ay, az, magRot });
    const cutoff = now - ML_BUFFER_MS;
    while (this.mlHistory.length && this.mlHistory[0].t < cutoff) {
      this.mlHistory.shift();
    }
    if (now - this.lastFireAt < ML_REFRACTORY_MS) return null;

    const hist = this.mlHistory;
    const targetT = now - ML_PEAK_LAG_MS;
    // Find the candidate index closest to targetT.
    let pIdx = -1, bestDt = Infinity;
    for (let i = 0; i < hist.length; i++) {
      const dt = Math.abs(hist[i].t - targetT);
      if (dt < bestDt) { bestDt = dt; pIdx = i; }
    }
    if (pIdx < 0) return null;
    if (pIdx < ML_PEAK_NEIGHBOURS) return null;
    if (pIdx > hist.length - 1 - ML_PEAK_NEIGHBOURS) return null;

    const peak = hist[pIdx];
    const peakFloor = ML_PEAK_MIN_MAG / Math.max(0.3, this.sensitivity);
    if (peak.magRot < peakFloor) return null;
    for (let k = 1; k <= ML_PEAK_NEIGHBOURS; k++) {
      if (hist[pIdx - k].magRot >= peak.magRot) return null;
      if (hist[pIdx + k].magRot >= peak.magRot) return null;
    }

    const winLen = this.model.input.window_len;
    const window = this._buildWindowAroundPeak(pIdx, winLen);
    if (!window) return null;

    const probs = runModel(this.model, window);
    let best = 0;
    for (let i = 1; i < probs.length; i++) {
      if (probs[i] > probs[best]) best = i;
    }
    if (best === 0) return null;
    if (probs[best] < ML_FIRE_PROB) return null;
    if (probs[best] - probs[0] < ML_FIRE_MARGIN) return null;

    this.lastFireAt = now;
    let direction = this.model.classes[best];
    if (this.invertH && direction === "right") direction = "left";
    else if (this.invertH && direction === "left") direction = "right";
    if (this.invertV && direction === "down") direction = "up";

    // Drop history up to the peak so the next swing starts fresh.
    this.mlHistory = hist.slice(pIdx + 1);

    const result = {
      direction,
      peakMag: Math.round(probs[best] * 100),
      axis: "ml",
    };
    this.lastDebug = result;
    return result;
  }

  _buildWindowAroundPeak(peakIdx, T) {
    // T uniformly-spaced samples spanning (T-1)/INPUT_HZ seconds. We
    // place the peak at frame (T-1 - ML_PEAK_OFFSET_FRAMES) so the
    // window mostly contains pre-peak data plus a short tail of
    // post-peak data — matching the model's training layout.
    const INPUT_HZ = 60;
    const spanMs = ((T - 1) / INPUT_HZ) * 1000;
    const hist = this.mlHistory;
    const tPeak = hist[peakIdx].t;
    const peakFrame = T - 1 - ML_PEAK_OFFSET_FRAMES;
    const dtFrame = spanMs / (T - 1);
    const tStart = tPeak - peakFrame * dtFrame;

    // Sample T uniformly-spaced frames starting at tStart. If tStart is
    // before our buffer's earliest sample, repeat the first sample
    // (effectively zero-padding rotation since the user is at rest before
    // the swing). If tEnd extends past the last sample, repeat the last
    // sample (only happens if buffer is short).
    const out = new Array(T);
    let j = 0;
    for (let i = 0; i < T; i++) {
      const t = tStart + (spanMs * i) / (T - 1);
      if (t <= hist[0].t) {
        const s = hist[0];
        out[i] = [s.alpha, s.beta, s.gamma, s.ax, s.ay, s.az];
        continue;
      }
      while (j < hist.length - 1 && hist[j + 1].t <= t) j++;
      const s = hist[j];
      out[i] = [s.alpha, s.beta, s.gamma, s.ax, s.ay, s.az];
    }
    return out;
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
