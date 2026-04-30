# iPhone Sword Prototype

Use an iPhone as a motion controller for a Mount & Blade-style **4-directional
sword combat** demo that runs in the browser on your Mac.

- **Game** (Mac browser): a first-person view with a sword, a training dummy,
  and an on-screen indicator of the swing direction.
- **Controller** (iPhone browser): streams accelerometer + gyro over WebSocket.
  A simple peak-detector classifies each phone swing as **up / down / left /
  right / thrust** and forwards a single `attack` event to the game.

No native app, no App Store, no Bluetooth pairing — everything runs in Safari.

> ⚠️ **Why not Bluetooth?** Web Bluetooth is not supported on iOS Safari, so a
> browser-based prototype must use Wi-Fi + WebSocket. Latency on a typical home
> network is around 10–30 ms, which is fine for melee.

## Quick start

```bash
npm install
npm start
```

The server prints two URLs:

```
[HTTP] listening on :8080
  Game (Mac):  http://localhost:8080/
  Controller:  http://<your-mac-ip>:8080/controller.html
```

1. Open the **Game** URL in a browser on your Mac.
2. On your iPhone (same Wi-Fi), open the **Controller** URL.
3. Tap **Enable motion & connect**.
4. Swing the phone — the on-screen indicator should light up and the sword
   should strike in the matching direction.

### Keyboard fallback

For testing without an iPhone, focus the game window and use:

- `W` — up swing
- `S` — down swing
- `A` — left swing
- `D` — right swing
- `Space` — thrust

## HTTPS (required for iPhone motion)

iOS Safari only calls `DeviceMotionEvent.requestPermission()` on a **secure
context** (HTTPS or `localhost`). On plain HTTP over your LAN, the permission
button will silently do nothing.

Two easy ways to get HTTPS on your LAN:

### Option A — mkcert (recommended for dev)

```bash
brew install mkcert
mkcert -install
mkdir -p certs
mkcert -key-file certs/key.pem -cert-file certs/cert.pem \
  localhost 127.0.0.1 "$(ipconfig getifaddr en0)"
npm start
```

Then open the **HTTPS** URL printed by the server on the iPhone. You may need
to accept the root CA on the iPhone once (iOS Settings → General → About →
Certificate Trust Settings).

### Option B — cloudflared tunnel (zero-config, public URL)

```bash
brew install cloudflared
# In another terminal, after `npm start`:
cloudflared tunnel --url http://localhost:8080
```

Open the generated `https://<random>.trycloudflare.com` URL on both the Mac
game tab and the iPhone controller tab.

## Per-user calibration (recommended)

Default classification assumes you hold the phone in portrait with a fairly
typical swing style. That's rarely true for everyone, so the controller page
has a **Calibrate swings** button that runs a 5-step wizard:

1. Swing **right** (left-to-right horizontal slash)
2. Swing **left**
3. Swing **up** (uppercut)
4. Swing **down** (overhead chop)
5. **Thrust** (push the phone forward)

For each step the server records the peak acceleration vector. After all
five are captured, the detector classifies new swings by **cosine
similarity** to those vectors — picking whichever direction's template is
most similar.

Templates are persisted in `localStorage` on the phone (scoped by the `room`
query param) and automatically re-synced to the server after every reconnect.

## How the gesture detector works

`server/gestureDetector.js` runs a peak detector on the acceleration
magnitude. When magnitude crosses a threshold and then starts falling, it
finds the peak sample over the last 200 ms and classifies in one of two
modes:

- **Template mode** (after calibration, ≥ 3 templates registered):
  cosine similarity of the peak vector vs each stored template; largest
  wins, below `TEMPLATE_MIN_COSINE` the swing is rejected.
- **Axis mode** (fallback, no / few templates): pick the dominant signed
  axis of the peak — `+x → right`, `-x → left`, `+y → up`, `-y → down`,
  dominant `z` with lower magnitude → `thrust`.

A 350 ms refractory period prevents follow-through double-triggers.

Tuning constants are at the top of `server/gestureDetector.js`
(`SWING_PEAK_G`, `THRUST_PEAK_G`, `REFRACTORY_MS`, `WINDOW_MS`,
`CALIB_MIN_PEAK`, `TEMPLATE_MIN_COSINE`).

## Deploying for friction-free sharing

To let other players try the prototype without mkcert / cloudflared /
same-Wi-Fi dance, deploy the server to any HTTPS host. The repo ships with
a `Dockerfile` and `fly.toml` for [Fly.io](https://fly.io):

```bash
curl -L https://fly.io/install.sh | sh
fly auth login
fly launch --copy-config --name <unique-app-name> --no-deploy
fly deploy
```

Once deployed, anyone opens `https://<app>.fly.dev/` on their Mac and
`https://<app>.fly.dev/controller.html` on their iPhone — iOS prompts for
motion access normally, no profile-trust setup needed.

Use `?room=<code>` on both URLs to pair a specific Mac ↔ iPhone pair so
multiple players on the same host don't collide.

## Architecture

```
iPhone Safari                          Mac
┌──────────────────────┐   ws://LAN   ┌───────────────────────────┐
│ controller.html      │ ───────────▶ │ Node + ws + static        │
│  DeviceMotion @ 60Hz │              │  GestureDetector          │
│  touch buttons       │              │  attack events ─────────▶ │
└──────────────────────┘              │ three.js game in browser  │
                                       └───────────────────────────┘
```

## Project layout

```
server/
  index.js              HTTP/HTTPS + WebSocket server, room routing
  gestureDetector.js    peak-detector: motion samples → discrete attacks
public/
  index.html            game page
  controller.html       iPhone page
  game.js               three.js scene, sword animation, hit detection
  controller.js         DeviceMotion + WS client
  style.css             HUD + controller styling
test/
  gesture.test.mjs      unit tests for the gesture detector
```

## Not yet implemented (ideas)

- Blocks / parries (the controller already sends a `block` button event).
- Per-direction hit VFX, sword trails.
- Aiming a bow with phone orientation (the server already relays
  `orientation` events).
- Per-user rooms via `?room=xyz` query param (already wired in the server).
