// Sanity tests for the fused rotation+accel GestureDetector.
// Only three directions: left, right, chop (down). Thrust and up are gone.
// Run: `node test/gesture.test.mjs`
import { GestureDetector } from "../server/gestureDetector.js";

// Simulate a half-sine motion burst on the given axes over ~150 ms,
// followed by stillness so the burst-end timer fires classification.
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

// --- Wrist-only variants (rotation-dominated) ------------------------------
check("wrist right (beta+)", feed(new GestureDetector(),
  burst({ gyro: { beta: +400 } }))?.direction, "right");
check("wrist left  (beta-)", feed(new GestureDetector(),
  burst({ gyro: { beta: -400 } }))?.direction, "left");
check("wrist chop  (alpha+)", feed(new GestureDetector(),
  burst({ gyro: { alpha: +400 } }))?.direction, "down");

// --- Full-arm variants (linear-accel-dominated) ----------------------------
// A shoulder swing with locked wrist sends the phone sideways (ax big),
// no rotation. Should still classify as a side slash.
check("shoulder right (ax+)", feed(new GestureDetector(),
  burst({ accel: { x: +20 } }))?.direction, "right");
check("shoulder left  (ax-)", feed(new GestureDetector(),
  burst({ accel: { x: -20 } }))?.direction, "left");
// An overhead chop with locked wrist sends the phone forward-down.
check("shoulder chop (ay-, az-)", feed(new GestureDetector(),
  burst({ accel: { y: -15, z: -15 } }))?.direction, "down");

// --- Mixed: rotation + translation in same direction should reinforce ----
check("mixed right (wrist + arm)", feed(new GestureDetector(),
  burst({ gyro: { beta: +200 }, accel: { x: +10 } }))?.direction, "right");

// --- Upward motion is intentionally ignored --------------------------------
check("up-swing no longer fires", feed(new GestureDetector(),
  burst({ gyro: { alpha: -400 } })), null);

// --- Sub-threshold is ignored ---------------------------------------------
check("weak motion stays silent", feed(new GestureDetector(),
  burst({ gyro: { beta: +80 } })), null);

// --- Sensitivity turns a weak swing into a hit ----------------------------
{
  const d = new GestureDetector();
  d.setSensitivity(0.4);
  check("sensitive catches weak right", feed(d,
    burst({ gyro: { beta: +150 } }))?.direction, "right");
}

// --- Refractory collapses a double-pulse into one event --------------------
{
  const d = new GestureDetector();
  let fired = 0;
  for (const s of [...burst({ gyro: { beta: +400 } }, 1000),
                   ...burst({ gyro: { beta: +400 } }, 1050)]) {
    if (d.ingest(s)) fired++;
  }
  check("rapid double burst = 1 event", fired, 1);
}

// --- Sign inversion for reversed grip --------------------------------------
{
  const d = new GestureDetector();
  d.setConfig({ invertH: true });
  check("invertH flips right<->left", feed(d,
    burst({ gyro: { beta: +400 } }))?.direction, "left");
}
{
  const d = new GestureDetector();
  d.setConfig({ invertV: true });
  // invertV means the *negative* alpha (the physical chop in reversed
  // grip) now triggers "down"; positive alpha triggers nothing.
  check("invertV enables chop on negative alpha", feed(d,
    burst({ gyro: { alpha: -400 } }))?.direction, "down");
  const d2 = new GestureDetector();
  d2.setConfig({ invertV: true });
  check("invertV suppresses chop on positive alpha", feed(d2,
    burst({ gyro: { alpha: +400 } })), null);
}

// --- Off-axis noise doesn't dislodge dominant axis ------------------------
check("noisy right still classifies right", feed(new GestureDetector(),
  burst({ gyro: { beta: +400, alpha: +150 } }))?.direction, "right");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
