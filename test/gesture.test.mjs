// Lightweight sanity check for GestureDetector. Feeds synthetic motion
// samples that mimic a hard right-swing, a down-swing, and a forward thrust.
// Run with: `node test/gesture.test.mjs`
import { GestureDetector } from "../server/gestureDetector.js";

function feed(det, samples) {
  let evt = null;
  for (const s of samples) {
    const r = det.ingest({ t: s.t, acceleration: { x: s.x, y: s.y, z: s.z } });
    if (r) evt = r;
  }
  return evt;
}

function swing(axis, sign, peak, t0) {
  const out = [];
  // half-sine from 0 -> peak -> 0 over 150 ms
  for (let i = 0; i <= 15; i++) {
    const t = t0 + i * 10;
    const k = Math.sin((i / 15) * Math.PI);
    const v = sign * peak * k;
    const sample = { t, x: 0, y: 0, z: 0 };
    sample[axis] = v;
    out.push(sample);
  }
  // tail of stillness so falling edge registers
  for (let i = 1; i <= 5; i++) out.push({ t: t0 + 150 + i * 10, x: 0, y: 0, z: 0 });
  return out;
}

let pass = 0, fail = 0;
function expect(name, got, want) {
  if (got === want) { pass++; console.log(`ok  ${name}: ${got}`); }
  else { fail++; console.error(`FAIL ${name}: got ${got}, want ${want}`); }
}

{
  const d = new GestureDetector();
  const evt = feed(d, swing("x", +1, 30, 1000));
  expect("right swing", evt?.direction, "right");
}
{
  const d = new GestureDetector();
  const evt = feed(d, swing("x", -1, 30, 1000));
  expect("left swing", evt?.direction, "left");
}
{
  const d = new GestureDetector();
  const evt = feed(d, swing("y", +1, 30, 1000));
  expect("up swing", evt?.direction, "up");
}
{
  const d = new GestureDetector();
  const evt = feed(d, swing("y", -1, 30, 1000));
  expect("down swing", evt?.direction, "down");
}
{
  // Thrust: dominated by z, moderate peak so we pick "thrust" over a slash.
  const d = new GestureDetector();
  const evt = feed(d, swing("z", -1, 16, 1000));
  expect("thrust", evt?.direction, "thrust");
}
{
  // Too weak: should not fire.
  const d = new GestureDetector();
  const evt = feed(d, swing("x", +1, 8, 1000));
  expect("no-fire below threshold", evt, null);
}
{
  // Refractory: two quick swings in a row produce one event.
  const d = new GestureDetector();
  let fired = 0;
  for (const s of [...swing("x", +1, 30, 1000), ...swing("x", +1, 30, 1200)]) {
    if (d.ingest({ t: s.t, acceleration: { x: s.x, y: s.y, z: s.z } })) fired++;
  }
  expect("refractory collapses to 1", fired, 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
