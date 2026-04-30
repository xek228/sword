// Sanity tests for the simple axis-based GestureDetector.
// Run: `node test/gesture.test.mjs`
import { GestureDetector } from "../server/gestureDetector.js";

// Simulate a motion burst: ramp up the rotation rate on the chosen
// axis, hold, ramp down, then stay still. Accel defaults to zero.
// gyro/accel values are raw units the iPhone sends.
function burst(opts, t0 = 1000) {
  const { gyro = {}, accel = {} } = opts;
  const out = [];
  for (let i = 0; i <= 15; i++) {
    const k = Math.sin((i / 15) * Math.PI);
    out.push({
      t: t0 + i * 10,
      acceleration: {
        x: (accel.x || 0) * k,
        y: (accel.y || 0) * k,
        z: (accel.z || 0) * k,
      },
      rotationRate: {
        alpha: (gyro.alpha || 0) * k,
        beta:  (gyro.beta  || 0) * k,
        gamma: (gyro.gamma || 0) * k,
      },
    });
  }
  // Trailing stillness so the detector's quiet timer fires classification.
  for (let i = 1; i <= 20; i++) {
    out.push({
      t: t0 + 150 + i * 10,
      acceleration: { x: 0, y: 0, z: 0 },
      rotationRate: { alpha: 0, beta: 0, gamma: 0 },
    });
  }
  return out;
}

function feed(det, samples) {
  let evt = null;
  for (const s of samples) {
    const r = det.ingest(s);
    if (r) evt = r;
  }
  return evt;
}

let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) { pass++; console.log(`ok  ${name}: ${got}`); }
  else { fail++; console.error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

// --- Basic directions ------------------------------------------------------
{
  const d = new GestureDetector();
  check("right swing (beta +)", feed(d, burst({ gyro: { beta: +400 } }))?.direction, "right");
}
{
  const d = new GestureDetector();
  check("left swing  (beta -)", feed(d, burst({ gyro: { beta: -400 } }))?.direction, "left");
}
{
  const d = new GestureDetector();
  check("down chop   (alpha +)", feed(d, burst({ gyro: { alpha: +400 } }))?.direction, "down");
}
{
  const d = new GestureDetector();
  check("up swing    (alpha -)", feed(d, burst({ gyro: { alpha: -400 } }))?.direction, "up");
}

// --- Thrust: linear accel, little rotation ---------------------------------
{
  const d = new GestureDetector();
  check("thrust (accel -z, no rot)", feed(d, burst({ accel: { z: -35 } }))?.direction, "thrust");
}

// --- Below threshold stays silent ------------------------------------------
{
  const d = new GestureDetector();
  check("weak swing ignored", feed(d, burst({ gyro: { beta: +100 } })), null);
}

// --- Sensitivity lowers threshold ------------------------------------------
{
  const d = new GestureDetector();
  d.setSensitivity(0.4);
  check("sensitive mode catches weak swing",
    feed(d, burst({ gyro: { beta: +150 } }))?.direction, "right");
}

// --- Refractory period collapses rapid pair into one -----------------------
{
  const d = new GestureDetector();
  let fired = 0;
  for (const s of [...burst({ gyro: { beta: +400 } }, 1000),
                   ...burst({ gyro: { beta: +400 } }, 1050)]) {
    if (d.ingest(s)) fired++;
  }
  check("rapid double burst = 1 event", fired, 1);
}

// --- Sign inversion for users holding phone reversed -----------------------
{
  const d = new GestureDetector();
  d.setConfig({ invertH: true });
  check("invertH flips right <-> left",
    feed(d, burst({ gyro: { beta: +400 } }))?.direction, "left");
}
{
  const d = new GestureDetector();
  d.setConfig({ invertV: true });
  check("invertV flips up <-> down",
    feed(d, burst({ gyro: { alpha: +400 } }))?.direction, "up");
}

// --- Dominant axis picking: off-axis noise shouldn't confuse ---------------
{
  const d = new GestureDetector();
  // A right swing with noisy alpha component — beta still dominant.
  check("noisy right swing still classifies as right",
    feed(d, burst({ gyro: { beta: +450, alpha: +100 } }))?.direction, "right");
}

// --- Config persistence ----------------------------------------------------
{
  const d = new GestureDetector();
  d.setConfig({ sensitivity: 0.5, invertH: true, invertV: false });
  const cfg = d.getConfig();
  check("config round-trips sensitivity", cfg.sensitivity, 0.5);
  check("config round-trips invertH",     cfg.invertH,     true);
  check("config round-trips invertV",     cfg.invertV,     false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
