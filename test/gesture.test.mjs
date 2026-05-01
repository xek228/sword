// Data-driven tests. The primary validation is replaying the 9 real
// iPhone recordings in test/fixtures/ through the detector and
// verifying each classifies as its label.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GestureDetector } from "../server/gestureDetector.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");

let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) { pass++; console.log(`ok  ${name}: ${got}`); }
  else { fail++; console.error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

function replay(det, samples) {
  // Append a short trailing rest so the burst-quiet timer finalises
  // classification, then the detector returns the event.
  const last = samples[samples.length - 1] || { t: 0 };
  const tail = [];
  for (let i = 1; i <= 20; i++) {
    tail.push({
      t: last.t + i * 15,
      acceleration: { x: 0, y: 0, z: 0 },
      accelerationIncludingGravity: { x: 0, y: 0, z: 0 },
      rotationRate: { alpha: 0, beta: 0, gamma: 0 },
    });
  }
  let evt = null;
  for (const s of [...samples, ...tail]) {
    const r = det.ingest(s);
    if (r) evt = r;
  }
  return evt;
}

// --- Real-recording playback ----------------------------------------------

const files = readdirSync(FIXTURES).filter((n) => n.endsWith(".json")).sort();
for (const name of files) {
  const body = JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
  const label = name.split("_")[0]; // "chop" | "left" | "right"
  const expected = label === "chop" ? "down" : label;
  const det = new GestureDetector();
  const evt = replay(det, body.samples);
  check(`replay ${name.slice(0, 24)}... (expect ${expected})`, evt?.direction, expected);
}

// --- Below threshold stays silent -----------------------------------------
{
  const det = new GestureDetector();
  const tiny = [];
  for (let i = 0; i < 50; i++) {
    tiny.push({
      t: i * 16,
      acceleration: { x: 0, y: 0, z: 0 },
      rotationRate: { alpha: 0, beta: 10, gamma: 0 },
    });
  }
  let fired = null;
  for (const s of tiny) {
    const r = det.ingest(s);
    if (r) fired = r;
  }
  check("idle noise is silent", fired, null);
}

// --- Passive twist (high rotation, ~zero acceleration) is NOT a swing -----
// User complaint: "any small rotation triggers swings". The defence is the
// MIN_ACC_PEAK gate — real swings always carry linear acceleration, but
// a passive wrist twist on a stationary arm doesn't.
{
  const det = new GestureDetector();
  const samples = [];
  // Half-sine ramp of pure rotation up to 800 deg/s with zero accel.
  for (let i = 0; i <= 30; i++) {
    const k = Math.sin((i / 30) * Math.PI);
    samples.push({
      t: i * 16,
      acceleration: { x: 0, y: 0, z: 0 },
      rotationRate: { alpha: 0, beta: 800 * k, gamma: 0 },
    });
  }
  // Trailing rest.
  for (let i = 1; i <= 20; i++) {
    samples.push({
      t: 30 * 16 + i * 16,
      acceleration: { x: 0, y: 0, z: 0 },
      rotationRate: { alpha: 0, beta: 0, gamma: 0 },
    });
  }
  let fired = null;
  for (const s of samples) { const r = det.ingest(s); if (r) fired = r; }
  check("passive rotation without acceleration does not fire", fired, null);
}

// --- Passive shake (some accel but well below swing levels) is NOT a swing
{
  const det = new GestureDetector();
  const samples = [];
  for (let i = 0; i <= 40; i++) {
    const k = Math.sin((i / 5) * Math.PI); // jiggle
    samples.push({
      t: i * 16,
      acceleration: { x: 4 * k, y: 0, z: 0 },     // 4 m/s^2 max
      rotationRate: { alpha: 0, beta: 200 * k, gamma: 100 * k },
    });
  }
  for (let i = 1; i <= 20; i++) {
    samples.push({
      t: 40 * 16 + i * 16,
      acceleration: { x: 0, y: 0, z: 0 },
      rotationRate: { alpha: 0, beta: 0, gamma: 0 },
    });
  }
  let fired = null;
  for (const s of samples) { const r = det.ingest(s); if (r) fired = r; }
  check("low-energy shake does not fire", fired, null);
}

// --- Refractory period suppresses back-to-back classification ------------
{
  // Feed a recording, let it classify, then IMMEDIATELY re-feed the same
  // samples offset by a trivial gap. The second run must not fire a
  // new event because the detector is still within REFRACTORY_MS.
  const body = JSON.parse(readFileSync(join(FIXTURES, files[0]), "utf8"));
  const det = new GestureDetector();
  const first = replay(det, body.samples);
  check("first swing fires", !!first, true);
  // Now feed another round of identical samples directly after, without
  // trailing rest. No more events should appear.
  const last = body.samples[body.samples.length - 1];
  const offset = last.t + 5; // just past first swing's classification moment
  const copy2 = body.samples.map((s) => ({ ...s, t: s.t - body.samples[0].t + offset }));
  let extra = 0;
  for (const s of copy2) if (det.ingest(s)) extra++;
  // The next swing is 1+ seconds later, beyond refractory, so it may
  // fire once — not more.
  check("refractory doesn't multiply fires within same burst", extra <= 1, true);
}

// --- Config round-trip ----------------------------------------------------
{
  const det = new GestureDetector();
  det.setConfig({ sensitivity: 0.5, invertH: true, invertV: false });
  const cfg = det.getConfig();
  check("config round-trips sensitivity", cfg.sensitivity, 0.5);
  check("config round-trips invertH",     cfg.invertH,     true);
  check("config round-trips invertV",     cfg.invertV,     false);
}

// --- Inversion flips direction on real data ------------------------------
{
  const rightRec = JSON.parse(readFileSync(
    join(FIXTURES, files.find((n) => n.startsWith("right_1"))), "utf8"));
  const det = new GestureDetector();
  det.setConfig({ invertH: true });
  const evt = replay(det, rightRec.samples);
  check("invertH flips a right recording to left", evt?.direction, "left");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
