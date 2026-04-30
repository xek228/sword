// Game client: minimal three.js scene with a first-person sword and a training
// dummy. Listens for attack events from the server and animates the sword in
// the matching direction, à la Mount & Blade's 4-directional combat.

import * as THREE from "three";

const canvas = document.getElementById("canvas");
const statusControllerEl = document.getElementById("controller-status");
const lastAttackEl = document.getElementById("last-attack");
const dummyHpEl = document.getElementById("dummy-hp-value");
const ctrlUrlEl = document.getElementById("ctrl-url");

ctrlUrlEl.textContent = `${location.protocol}//${location.hostname}:${location.port || (location.protocol === "https:" ? 443 : 80)}/controller.html`;

// --- scene setup ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e14);
scene.fog = new THREE.Fog(0x0b0e14, 12, 40);

const camera = new THREE.PerspectiveCamera(68, window.innerWidth / window.innerHeight, 0.05, 200);
camera.position.set(0, 1.65, 0);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;

function resize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener("resize", resize);

// Ground
{
  const g = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshStandardMaterial({ color: 0x1a2130, roughness: 0.95 }),
  );
  g.rotation.x = -Math.PI / 2;
  g.receiveShadow = true;
  scene.add(g);

  const grid = new THREE.GridHelper(200, 80, 0x2a3345, 0x1c2231);
  grid.position.y = 0.001;
  scene.add(grid);
}

// Lights
{
  const hemi = new THREE.HemisphereLight(0x8899aa, 0x2a3345, 0.6);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffe2a8, 1.1);
  dir.position.set(4, 8, 3);
  dir.castShadow = true;
  dir.shadow.mapSize.set(1024, 1024);
  scene.add(dir);
}

// Training dummy
const dummy = new THREE.Group();
{
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.35, 1.0, 8, 16),
    new THREE.MeshStandardMaterial({ color: 0x8b6a3f, roughness: 0.9 }),
  );
  body.position.y = 1.0;
  body.castShadow = true;
  dummy.add(body);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 16, 16),
    new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 0.9 }),
  );
  head.position.y = 1.85;
  head.castShadow = true;
  dummy.add(head);

  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.05, 1.2),
    new THREE.MeshStandardMaterial({ color: 0x3a2a1a }),
  );
  pole.position.y = 0.6;
  dummy.add(pole);
}
dummy.position.set(0, 0, -3.2);
scene.add(dummy);

// First-person sword
const sword = new THREE.Group();
{
  const blade = new THREE.Mesh(
    new THREE.BoxGeometry(0.045, 0.9, 0.005),
    new THREE.MeshStandardMaterial({ color: 0xd0d6df, metalness: 0.85, roughness: 0.25 }),
  );
  blade.position.y = 0.52;
  sword.add(blade);
  const guard = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 0.03, 0.04),
    new THREE.MeshStandardMaterial({ color: 0x6a5a35, metalness: 0.6, roughness: 0.5 }),
  );
  guard.position.y = 0.08;
  sword.add(guard);
  const grip = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02, 0.02, 0.16),
    new THREE.MeshStandardMaterial({ color: 0x2a1a0a, roughness: 0.9 }),
  );
  grip.position.y = -0.02;
  sword.add(grip);
  const pommel = new THREE.Mesh(
    new THREE.SphereGeometry(0.03, 12, 12),
    new THREE.MeshStandardMaterial({ color: 0x6a5a35, metalness: 0.6, roughness: 0.5 }),
  );
  pommel.position.y = -0.12;
  sword.add(pommel);
}
// Attach sword to camera (first-person-ish).
sword.position.set(0.35, -0.3, -0.6);
sword.rotation.set(-0.2, -0.15, -0.15);
camera.add(sword);
scene.add(camera);

// --- attack animation ---
// Base pose of the sword at rest.
const basePos = sword.position.clone();
const baseRot = sword.rotation.clone();

let anim = null; // { dir, start, duration, onHit }
const DURATION = 380; // ms

function directionOffsets(dir) {
  // Returns an animation curve: arrays of [time, pos{x,y,z}, rot{x,y,z}]
  // as offsets from the base pose. 't' ranges 0..1.
  const k = 1;
  switch (dir) {
    case "up":
      return [
        { pos: new THREE.Vector3(0,  0.15,  0.10), rot: new THREE.Euler(-1.2 * k, 0, 0) },
        { pos: new THREE.Vector3(0, -0.25, -0.20), rot: new THREE.Euler( 0.8 * k, 0, 0) },
      ];
    case "down":
      return [
        { pos: new THREE.Vector3(0, -0.15,  0.05), rot: new THREE.Euler( 0.6 * k, 0, 0) },
        { pos: new THREE.Vector3(0,  0.25, -0.20), rot: new THREE.Euler(-1.0 * k, 0, 0) },
      ];
    case "left":
      return [
        { pos: new THREE.Vector3( 0.25, 0.10,  0.05), rot: new THREE.Euler(0, 0,  1.0 * k) },
        { pos: new THREE.Vector3(-0.35, 0.00, -0.20), rot: new THREE.Euler(0, 0, -1.0 * k) },
      ];
    case "right":
      return [
        { pos: new THREE.Vector3(-0.25, 0.10,  0.05), rot: new THREE.Euler(0, 0, -1.0 * k) },
        { pos: new THREE.Vector3( 0.35, 0.00, -0.20), rot: new THREE.Euler(0, 0,  1.0 * k) },
      ];
    case "thrust":
    default:
      return [
        { pos: new THREE.Vector3(0, 0,  0.10), rot: new THREE.Euler(0, 0, 0) },
        { pos: new THREE.Vector3(0, 0, -0.55), rot: new THREE.Euler(0, 0, 0) },
      ];
  }
}

function triggerAttack(dir) {
  anim = {
    dir,
    start: performance.now(),
    duration: DURATION,
    offsets: directionOffsets(dir),
    hitFired: false,
  };
  flashIndicator(dir);
  lastAttackEl.textContent = dir;
}

function flashIndicator(dir) {
  const cell = document.querySelector(`.indicator-cell[data-dir="${dir}"]`);
  if (!cell) return;
  cell.classList.add("flash");
  setTimeout(() => cell.classList.remove("flash"), 160);
}

let dummyHp = 100;
function damageDummy(amount) {
  dummyHp = Math.max(0, dummyHp - amount);
  dummyHpEl.textContent = dummyHp;
  // Knockback visual
  dummy.userData.knockback = performance.now();
  if (dummyHp === 0) {
    setTimeout(() => { dummyHp = 100; dummyHpEl.textContent = 100; }, 800);
  }
}

// --- input / networking ---
function openWs() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/?role=game&room=default`;
  const ws = new WebSocket(url);
  ws.addEventListener("open", () => statusControllerEl.textContent = "waiting");
  ws.addEventListener("close", () => {
    statusControllerEl.textContent = "disconnected";
    setTimeout(openWs, 1000);
  });
  ws.addEventListener("message", (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === "presence") {
      statusControllerEl.textContent = m.controllers > 0 ? "connected" : "waiting";
    } else if (m.type === "attack") {
      triggerAttack(m.direction);
    }
  });
}
openWs();

// Keyboard fallback for testing without an iPhone.
window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  const map = { KeyW: "up", KeyS: "down", KeyA: "left", KeyD: "right", Space: "thrust" };
  const dir = map[e.code];
  if (dir) { e.preventDefault(); triggerAttack(dir); }
});

// --- main loop ---
const tmpVec = new THREE.Vector3();
const tmpEu  = new THREE.Euler();

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

function lerpEuler(a, b, t, out) {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}

function animate(now) {
  requestAnimationFrame(animate);

  if (anim) {
    const t = Math.min(1, (now - anim.start) / anim.duration);
    const ease = easeOutCubic(t);
    const [wind, strike] = anim.offsets;

    // Phase 1: 0..0.35 windup to 'wind'. Phase 2: 0.35..0.75 strike to 'strike'. Phase 3: recovery to base.
    let off, rot;
    if (t < 0.35) {
      const tt = t / 0.35;
      off = tmpVec.copy(wind.pos).multiplyScalar(tt);
      rot = lerpEuler(baseRot, { x: baseRot.x + wind.rot.x, y: baseRot.y + wind.rot.y, z: baseRot.z + wind.rot.z }, tt, tmpEu);
    } else if (t < 0.75) {
      const tt = (t - 0.35) / 0.40;
      off = tmpVec.copy(wind.pos).lerp(strike.pos, tt);
      const from = { x: baseRot.x + wind.rot.x,   y: baseRot.y + wind.rot.y,   z: baseRot.z + wind.rot.z };
      const to   = { x: baseRot.x + strike.rot.x, y: baseRot.y + strike.rot.y, z: baseRot.z + strike.rot.z };
      rot = lerpEuler(from, to, tt, tmpEu);
      if (!anim.hitFired && tt > 0.5) {
        anim.hitFired = true;
        // Simple hit check: if dummy is within ~1.2m and roughly centered.
        const dist = dummy.position.distanceTo(new THREE.Vector3(0, 0, 0));
        if (dist < 4.0) damageDummy(anim.dir === "thrust" ? 18 : 12);
      }
    } else {
      const tt = (t - 0.75) / 0.25;
      off = tmpVec.copy(strike.pos).multiplyScalar(1 - tt);
      const from = { x: baseRot.x + strike.rot.x, y: baseRot.y + strike.rot.y, z: baseRot.z + strike.rot.z };
      rot = lerpEuler(from, baseRot, tt, tmpEu);
    }

    sword.position.copy(basePos).add(off);
    sword.rotation.set(rot.x, rot.y, rot.z);

    if (t >= 1) {
      anim = null;
      sword.position.copy(basePos);
      sword.rotation.copy(baseRot);
    }
  }

  // Dummy knockback animation
  if (dummy.userData.knockback) {
    const dt = now - dummy.userData.knockback;
    if (dt < 260) {
      const k = Math.sin((dt / 260) * Math.PI);
      dummy.rotation.z = -0.25 * k;
      dummy.position.z = -3.2 + 0.15 * k;
    } else {
      dummy.rotation.z = 0;
      dummy.position.z = -3.2;
      dummy.userData.knockback = 0;
    }
  }

  // Gentle camera sway so the scene feels alive.
  camera.rotation.y = Math.sin(now * 0.0004) * 0.01;

  renderer.render(scene, camera);
}
requestAnimationFrame(animate);
