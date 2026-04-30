// Sanity tests for GestureDetector. Feeds synthetic motion samples with
// accelerometer + gyroscope readings (the real iPhone provides both).
// Run: `node test/gesture.test.mjs`
import { GestureDetector } from "../server/gestureDetector.js";

// Build a synthetic swing: half-sine pulse over 150 ms on the chosen
// accel+gyro axes. `accel` is in m/s^2, `gyro` in deg/s (to match iOS units).
function swing(opts, t0 = 1000) {
  const { accel = {}, gyro = {} } = opts;
  const out = [];
  for (let i = 0; i <= 15; i++) {
    const t = t0 + i * 10;
    const k = Math.sin((i / 15) * Math.PI);
    out.push({
      t,
      acceleration: {
        x: (accel.x || 0) * k,
        y: (accel.y || 0) * k,
        z: (accel.z || 0) * k,
      },
      rotationRate: {
        alpha: (gyro.x || 0) * k,
        beta:  (gyro.y || 0) * k,
        gamma: (gyro.z || 0) * k,
      },
    });
  }
  // Trailing stillness so the burst ends and classification fires.
  for (let i = 1; i <= 8; i++) {
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
function expect(name, got, want) {
  if (got === want) { pass++; console.log(`ok  ${name}: ${got}`); }
  else { fail++; console.error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

// --- Axis-based fallback (no calibration) ---------------------------------
// Uncalibrated behaviour: a pure-accel right-swing still classifies as right.
{
  const d = new GestureDetector();
  const evt = feed(d, swing({ accel: { x: 30 } }));
  expect("uncalibrated right (accel-only)", evt?.direction, "right");
}
{
  const d = new GestureDetector();
  const evt = feed(d, swing({ accel: { y: -30 } }));
  expect("uncalibrated down (accel-only)", evt?.direction, "down");
}
// A pure-gyro swing (typical for a grip-held phone) also registers.
{
  const d = new GestureDetector();
  const evt = feed(d, swing({ gyro: { y: 400 } })); // 400 deg/s ≈ 7 rad/s
  expect("uncalibrated gyro-only swing fires", !!evt, true);
}
// Too weak: no event.
{
  const d = new GestureDetector();
  const evt = feed(d, swing({ accel: { x: 3 }, gyro: { y: 30 } }));
  expect("below threshold stays silent", evt, null);
}
// Refractory: two back-to-back swings collapse to one event.
{
  const d = new GestureDetector();
  let fired = 0;
  for (const s of [...swing({ accel: { x: 30 } }, 1000),
                   ...swing({ accel: { x: 30 } }, 1180)]) {
    if (d.ingest(s)) fired++;
  }
  expect("refractory collapses to 1", fired, 1);
}
// Sensitivity: lowering it lets weaker swings fire.
{
  const d = new GestureDetector();
  d.setSensitivity(0.3);
  const evt = feed(d, swing({ accel: { x: 8 }, gyro: { y: 60 } }));
  expect("low sensitivity catches weak swing", evt?.direction, "right");
}

// --- Template-based classification ---------------------------------------
{
  const d = new GestureDetector();
  // Simulate a user holding the phone sideways: their "right swing" is
  // dominated by +z acceleration and +x gyro (not the portrait defaults).
  const register = (dir, opts, t0) => {
    d.startCalibration(dir);
    for (const s of swing(opts, t0)) d.ingest(s);
    return d.endCalibration();
  };
  const r1 = register("right",  { accel: { z: +25 }, gyro: { x: +350 } },  500);
  const r2 = register("left",   { accel: { z: -25 }, gyro: { x: -350 } }, 1500);
  const r3 = register("up",     { accel: { y: +25 }, gyro: { z: +350 } }, 2500);
  const r4 = register("down",   { accel: { y: -25 }, gyro: { z: -350 } }, 3500);
  const r5 = register("thrust", { accel: { x: +25 }                    }, 4500);

  expect("calibration captured right",  r1?.direction, "right");
  expect("calibration captured thrust", r5?.direction, "thrust");

  // Now fire a new swing that matches the user's "right" template.
  const e1 = feed(d, swing({ accel: { z: +30 }, gyro: { x: +400 } }, 6000));
  expect("template classifies right under sideways grip", e1?.direction, "right");
  expect("classification mode is template", e1?.mode, "template");

  // A gyro-dominant right-swing still classifies as right.
  const e2 = feed(d, swing({ gyro: { x: +500 } }, 7000));
  expect("template classifies right (gyro-dominant)", e2?.direction, "right");
}

// --- setTemplates validates entries --------------------------------------
{
  const d = new GestureDetector();
  d.setTemplates({
    right:  { feat: [1, 0, 0, 0, 1, 0], mag: 1.4 },
    left:   { feat: [-1, 0, 0, 0, -1, 0], mag: 1.4 },
    up:     { feat: [0, 1, 0, 1, 0, 0], mag: 1.4 },
    garbage:{ feat: [NaN, 0, 0, 0, 0, 0], mag: 1.0 },
    weak:   { feat: [0.1, 0, 0, 0, 0, 0], mag: 0.1 },
    wrongShape: { feat: [1, 2, 3], mag: 1 },
  });
  const t = d.getTemplates();
  expect("templates kept: right",          !!t.right,     true);
  expect("templates dropped: garbage",     !!t.garbage,   false);
  expect("templates dropped: weak",        !!t.weak,      false);
  expect("templates dropped: wrongShape",  !!t.wrongShape,false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
