// Converts a stream of DeviceMotion samples (acceleration + rotation rate)
// into discrete 4-directional "swings" + thrusts, Mount & Blade-style.
//
// Axes (iOS Safari, phone held in portrait, screen facing user):
//   accelerationIncludingGravity.x  -> left/right (positive = right)
//   accelerationIncludingGravity.y  -> up/down    (positive = up toward top edge)
//   accelerationIncludingGravity.z  -> toward/away from user (positive = toward)
//   rotationRate {alpha, beta, gamma}  -> deg/sec
//
// We use peak-detection on acceleration magnitude. When the magnitude crosses
// a threshold and then starts falling, we classify the swing by the axis with
// the largest signed peak during the rising window.
//
// Thrust: dominated by z-axis (phone pushed forward), with comparatively
// small rotation rate.
//
// The detector has a refractory period to avoid double-triggers from the
// follow-through motion.

const SWING_PEAK_G = 18;          // m/s^2, typical hard shake is ~20-40
const THRUST_PEAK_G = 14;         // thrust is usually softer but more axial
const REFRACTORY_MS = 350;        // don't fire again for this long after a swing
const WINDOW_MS = 200;            // look back this far to find the dominant axis

export class GestureDetector {
  constructor() {
    this.samples = [];            // recent samples in window
    this.lastFireAt = 0;
    this.inSwing = false;
    this.gravity = { x: 0, y: 0, z: -9.81 }; // slow-tracked gravity estimate
  }

  calibrate() {
    this.samples = [];
    this.lastFireAt = 0;
    this.inSwing = false;
  }

  ingest(msg) {
    const now = msg.t || Date.now();
    const ag = msg.accelerationIncludingGravity || { x: 0, y: 0, z: 0 };
    const a = msg.acceleration || null; // linear accel if available

    // Prefer linear accel (gravity-removed). Fallback: high-pass ag ourselves.
    let ax, ay, az;
    if (a && (a.x != null) && (a.y != null) && (a.z != null)) {
      ax = a.x; ay = a.y; az = a.z;
    } else {
      // Low-pass gravity estimate, subtract.
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

    // Drop samples older than window.
    const cutoff = now - WINDOW_MS;
    while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();

    if (now - this.lastFireAt < REFRACTORY_MS) return null;

    if (!this.inSwing) {
      if (mag > Math.min(SWING_PEAK_G, THRUST_PEAK_G)) {
        this.inSwing = true;
      }
      return null;
    }

    // Currently in a swing; wait for magnitude to start falling fast.
    const n = this.samples.length;
    if (n < 3) return null;
    const last3 = this.samples.slice(-3);
    const falling = last3[2].mag < last3[1].mag && last3[1].mag < last3[0].mag * 1.02;
    if (!falling && mag > SWING_PEAK_G * 0.4) return null;

    // Find dominant axis over the window.
    let sx = 0, sy = 0, sz = 0, peakMag = 0;
    for (const s of this.samples) {
      if (Math.abs(s.ax) > Math.abs(sx)) sx = s.ax;
      if (Math.abs(s.ay) > Math.abs(sy)) sy = s.ay;
      if (Math.abs(s.az) > Math.abs(sz)) sz = s.az;
      if (s.mag > peakMag) peakMag = s.mag;
    }

    // Require the peak to have actually exceeded the swing threshold.
    if (peakMag < THRUST_PEAK_G) {
      this.inSwing = false;
      return null;
    }

    const absX = Math.abs(sx), absY = Math.abs(sy), absZ = Math.abs(sz);
    let direction;
    if (absZ > absX && absZ > absY && peakMag < SWING_PEAK_G * 1.4) {
      direction = "thrust";
    } else if (absX > absY) {
      direction = sx > 0 ? "right" : "left";
    } else {
      direction = sy > 0 ? "up" : "down";
    }

    this.lastFireAt = now;
    this.inSwing = false;
    return {
      direction,
      peakMag: Number(peakMag.toFixed(2)),
      t: now,
    };
  }
}
