// Dead-simple motion detector for a FIXED phone pose, reworked around
// real sword-swing motions (not wrist-only twists).
//
// We only recognise three gestures: LEFT slash, RIGHT slash, CHOP
// (overhead down). Thrust is bound to the spacebar on the game side.
// Up-swings are intentionally unsupported.
//
// Assumed pose (shown as a diagram on the controller):
//   Phone held vertically (portrait), screen facing the player,
//   top edge = imaginary sword tip.
//
// Each swing is scored by fusing rotation (deg/s) with a scaled linear
// acceleration (m/s^2), so that either a wrist-only flick OR a full arm
// swing trigger the same event:
//
//   lateralScore  = beta   + ACCEL_TO_DPS * ax      // right/left
//   verticalScore = alpha  + ACCEL_TO_DPS * (-ay - az)  // chop down/forward
//
// (In phone frame: ax = lateral, ay = along the phone's long axis,
// az = out the back of the screen. A chop sends the phone forward and
// down, so both -ay and -az are positive contributions to chop.)
//
// The two sign defaults (invertH, invertV) can be flipped via config in
// case the player holds the phone screen-away / upside-down, without
// touching any code.

const REFRACTORY_MS = 300;
const BURST_COOLDOWN_MS = 120; // min quiet time to end a swing burst

// Default thresholds. `sensitivity` scales them: 1.0 = defaults,
// 0.5 = twice as sensitive, 2.0 = needs a very hard swing.
const SWING_THRESHOLD = 250; // on the fused score (deg/s equivalent)
const ACC_THRESHOLD_MPS2 = 12;  // any m/s^2 exceeding this also starts a burst
const QUIET_THRESHOLD = 120; // below this on fused score = "rest"
// 1 m/s^2 of linear accel contributes as much as this many deg/s of rotation.
const ACCEL_TO_DPS = 22;

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

    // Fused swing scores (deg/s equivalent). Either wrist rotation OR
    // body translation contributes; largest absolute score wins.
    const lateral  = beta  + ACCEL_TO_DPS * ax;               // right/left
    const vertical = alpha + ACCEL_TO_DPS * (-ay - az);        // chop down

    const sample = { alpha, beta, gamma, ax, ay, az, lateral, vertical };
    const magAcc = Math.hypot(ax, ay, az);
    const fused  = Math.max(Math.abs(lateral), Math.abs(vertical));

    if (now - this.lastFireAt < REFRACTORY_MS) return null;

    const startThresh = SWING_THRESHOLD * this.sensitivity;
    const accelStart  = ACC_THRESHOLD_MPS2 * this.sensitivity;
    const quiet       = QUIET_THRESHOLD * this.sensitivity;

    const isActive = fused > startThresh || magAcc > accelStart;

    if (!this.inBurst && isActive) {
      this.inBurst = true;
      this.burstStart = now;
      this.burstQuietStart = 0;
      this.burstPeak = { ...sample, fused, magAcc };
      return null;
    }

    if (this.inBurst) {
      const p = this.burstPeak;
      if (fused > p.fused) this.burstPeak = { ...sample, fused, magAcc };

      if (fused < quiet && magAcc < accelStart * 0.6) {
        if (this.burstQuietStart === 0) this.burstQuietStart = now;
        if (now - this.burstQuietStart >= BURST_COOLDOWN_MS) {
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
    const { lateral, vertical } = peak;
    const absL = Math.abs(lateral), absV = Math.abs(vertical);
    const threshold = SWING_THRESHOLD * this.sensitivity;
    if (Math.max(absL, absV) < threshold) return null;

    if (absV > absL) {
      // Down chop: forward-tip + down/forward translation. Positive
      // verticalScore = chop. Negative (up-swing) is intentionally
      // ignored — the user said up-swing isn't needed.
      const positive = vertical > 0;
      const isChop = positive !== this.invertV;
      if (!isChop) return null;
      return { direction: "down", peakMag: absV, axis: "vertical" };
    }
    const positive = lateral > 0;
    const dir = positive !== this.invertH ? "right" : "left";
    return { direction: dir, peakMag: absL, axis: "lateral" };
  }
}
