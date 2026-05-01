// Minimal static + WebSocket server.
// Accepts motion events from iPhone (role=controller), forwards attack
// events to the game client (role=game).
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import url from "node:url";
import { WebSocketServer } from "ws";
import zlib from "node:zlib";
import { GestureDetector } from "./gestureDetector.js";

// Minimal store-only ZIP writer. Enough to bundle a handful of JSON files
// for the user to ship back. No compression, no fancy metadata.
function makeZip(entries) {
  const bufs = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = zlib.crc32 ? zlib.crc32(data) : crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    bufs.push(localHeader, nameBuf, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...bufs, centralBuf, end]);
}

// Fallback CRC32 if zlib.crc32 is not available on this Node version.
function crc32(buf) {
  let c = ~0 >>> 0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

const PORT = Number(process.env.PORT || 8080);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);
const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "public");
const RECORDINGS = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "recordings");
if (!fs.existsSync(RECORDINGS)) fs.mkdirSync(RECORDINGS, { recursive: true });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// Find the mkcert root CA on disk so we can serve it to an iPhone that needs
// to trust locally-issued certs. iOS Safari auto-triggers the profile install
// flow when it sees application/x-x509-ca-cert.
function findMkcertRootCA() {
  const candidates = [
    process.env.CAROOT && path.join(process.env.CAROOT, "rootCA.pem"),
    path.join(os.homedir(), "Library/Application Support/mkcert/rootCA.pem"), // macOS
    path.join(os.homedir(), ".local/share/mkcert/rootCA.pem"),                  // Linux
    path.join(os.homedir(), "AppData/Local/mkcert/rootCA.pem"),                 // Windows
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const MKCERT_ROOT_CA = findMkcertRootCA();

function listRecordings() {
  try {
    return fs.readdirSync(RECORDINGS)
      .filter((n) => n.endsWith(".json"))
      .sort()
      .reverse();
  } catch { return []; }
}

function serveStatic(req, res) {
  const parsed = url.parse(req.url);
  let pathname = decodeURIComponent(parsed.pathname || "/");

  // Recording index page: list every saved JSON with a download link,
  // plus a zip-everything button.
  if (pathname === "/recordings" || pathname === "/recordings/") {
    const files = listRecordings();
    const rows = files.map((n) => {
      const st = fs.statSync(path.join(RECORDINGS, n));
      const size = (st.size / 1024).toFixed(1) + " KB";
      return `<tr><td><a href="/recordings/${encodeURIComponent(n)}" download>${n}</a></td><td>${size}</td></tr>`;
    }).join("\n");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Recordings</title>
<style>body{font-family:-apple-system,sans-serif;background:#0b0f18;color:#e6e9ef;padding:24px;}
a{color:#f0b429;} table{border-collapse:collapse;width:100%;max-width:720px;}
td,th{padding:8px 12px;border-bottom:1px solid #1c2231;text-align:left;font-size:14px;}
h1{margin:0 0 8px;} .hint{color:#8a93a3;font-size:13px;margin-bottom:16px;}
.bulk{margin:16px 0;display:flex;gap:12px;}
button,a.btn{background:#1c2231;color:#e6e9ef;border:1px solid #2a3345;border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer;text-decoration:none;}
</style></head><body>
<h1>Motion recordings (${files.length})</h1>
<p class="hint">Each .json file is one swing recording from the iPhone controller.</p>
<div class="bulk"><a class="btn" href="/recordings.zip" download>Download all as .zip</a></div>
<table><thead><tr><th>File</th><th>Size</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`);
  }

  if (pathname.startsWith("/recordings/")) {
    const name = path.basename(pathname.slice("/recordings/".length));
    const full = path.join(RECORDINGS, name);
    if (!full.startsWith(RECORDINGS) || !fs.existsSync(full)) {
      res.writeHead(404); return res.end("not found");
    }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(500); return res.end("read error"); }
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename=${JSON.stringify(name)}`,
      });
      res.end(data);
    });
    return;
  }

  if (pathname === "/recordings.zip") {
    // Very small zip writer (store-only, no compression). Good enough for
    // shipping a dozen JSON files.
    const files = listRecordings();
    const payload = makeZip(files.map((name) => ({
      name, data: fs.readFileSync(path.join(RECORDINGS, name)),
    })));
    res.writeHead(200, {
      "content-type": "application/zip",
      "content-disposition": "attachment; filename=\"recordings.zip\"",
    });
    return res.end(payload);
  }

  // Special route: serve mkcert's root CA so the iPhone can install it via
  // Safari (one tap → Profile Downloaded → Install in Settings).
  if (pathname === "/rootCA.pem" || pathname === "/mkcert-rootCA.pem") {
    if (!MKCERT_ROOT_CA) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("mkcert root CA not found. Run `mkcert -install` on this Mac first.");
    }
    fs.readFile(MKCERT_ROOT_CA, (err, data) => {
      if (err) { res.writeHead(500); return res.end("read error"); }
      res.writeHead(200, {
        "content-type": "application/x-x509-ca-cert",
        "content-disposition": "attachment; filename=mkcert-rootCA.pem",
        "cache-control": "no-cache",
      });
      res.end(data);
    });
    return;
  }

  if (pathname === "/") pathname = "/index.html";
  const filePath = path.join(ROOT, pathname);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not found");
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(data);
  });
}

function localIps() {
  const ifaces = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] || []) {
      if (addr.family === "IPv4" && !addr.internal) out.push(addr.address);
    }
  }
  return out;
}

// Rooms: a controller and a game share a room (default "default").
const rooms = new Map();
function getRoom(id) {
  let r = rooms.get(id);
  if (!r) {
    r = {
      controllers: new Set(), games: new Set(),
      detector: new GestureDetector(),
      // One active recording per room. ws is the controller that owns it.
      recording: null,
    };
    rooms.set(id, r);
  }
  return r;
}

function broadcast(set, message) {
  const data = JSON.stringify(message);
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function attachWs(wss) {
  wss.on("connection", (ws, req) => {
    const parsed = url.parse(req.url, true);
    const role = parsed.query.role === "game" ? "game" : "controller";
    const roomId = String(parsed.query.room || "default");
    const room = getRoom(roomId);
    ws.role = role;
    ws.room = roomId;

    if (role === "game") room.games.add(ws);
    else room.controllers.add(ws);

    broadcast(room.games, { type: "presence", controllers: room.controllers.size });
    broadcast(room.controllers, { type: "presence", games: room.games.size });
    ws.send(JSON.stringify({ type: "hello", role, room: roomId }));

    ws.on("message", (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      if (role !== "controller") return; // only controllers drive events

      if (msg.type === "motion") {
        if (room.recording) {
          room.recording.samples.push({
            t: msg.t ?? Date.now(),
            acceleration: msg.acceleration || null,
            accelerationIncludingGravity: msg.accelerationIncludingGravity || null,
            rotationRate: msg.rotationRate || null,
          });
        }
        const event = room.detector.ingest(msg);
        if (event) {
          broadcast(room.games, { type: "attack", ...event });
          ws.send(JSON.stringify({ type: "attack-debug", ...event }));
        }
      } else if (msg.type === "config") {
        room.detector.setConfig(msg.value || {});
      } else if (msg.type === "button") {
        broadcast(room.games, { type: "button", ...msg });
      } else if (msg.type === "orientation") {
        if (room.recording && msg.alpha !== undefined) {
          // Attach the most recent orientation to the last sample, so the
          // recording also carries world-frame heading for offline analysis.
          const last = room.recording.samples[room.recording.samples.length - 1];
          if (last) {
            last.orientation = { alpha: msg.alpha, beta: msg.beta, gamma: msg.gamma };
          }
        }
        broadcast(room.games, { type: "orientation", ...msg });
      } else if (msg.type === "record:start") {
        // Preserve the user label as-is (including non-ASCII) for the
        // JSON `label` field; derive a filename-safe slug separately so
        // the on-disk name stays portable.
        const label = String(msg.label || "swing").slice(0, 60).trim() || "swing";
        const slug = label.replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 40) || "swing";
        room.recording = { label, slug, startedAt: Date.now(), samples: [] };
        ws.send(JSON.stringify({ type: "record:started", label }));
      } else if (msg.type === "record:stop") {
        if (!room.recording) {
          ws.send(JSON.stringify({ type: "record:saved", ok: false, error: "no active recording" }));
        } else {
          const rec = room.recording;
          room.recording = null;
          const ts = new Date(rec.startedAt).toISOString().replace(/[:.]/g, "-");
          const fname = `${ts}_${rec.slug}.json`;
          const body = {
            label: rec.label,
            startedAt: rec.startedAt,
            durationMs: (rec.samples[rec.samples.length - 1]?.t ?? rec.startedAt) - rec.startedAt,
            sampleCount: rec.samples.length,
            samples: rec.samples,
          };
          try {
            fs.writeFileSync(path.join(RECORDINGS, fname), JSON.stringify(body, null, 2));
            ws.send(JSON.stringify({
              type: "record:saved", ok: true,
              filename: fname, sampleCount: rec.samples.length,
              durationMs: body.durationMs,
            }));
          } catch (err) {
            ws.send(JSON.stringify({ type: "record:saved", ok: false, error: String(err) }));
          }
        }
      } else if (msg.type === "record:cancel") {
        room.recording = null;
        ws.send(JSON.stringify({ type: "record:cancelled" }));
      }
    });

    ws.on("close", () => {
      room.games.delete(ws);
      room.controllers.delete(ws);
      broadcast(room.games, { type: "presence", controllers: room.controllers.size });
      broadcast(room.controllers, { type: "presence", games: room.games.size });
    });
  });
}

function start(server, label) {
  const wss = new WebSocketServer({ server });
  attachWs(wss);
  server.on("request", serveStatic);
  server.listen(server.__port, () => {
    const ips = localIps();
    const scheme = label.toLowerCase();
    console.log(`[${label}] listening on :${server.__port}`);
    console.log(`  Game (Mac):  ${scheme}://localhost:${server.__port}/`);
    console.log(`  Recordings:  ${scheme}://localhost:${server.__port}/recordings`);
    for (const ip of ips) {
      console.log(`  Controller:  ${scheme}://${ip}:${server.__port}/controller.html`);
    }
    if (label === "HTTP" && MKCERT_ROOT_CA) {
      console.log(`  iPhone one-time trust step — open on the iPhone in Safari:`);
      for (const ip of ips) {
        console.log(`    http://${ip}:${server.__port}/rootCA.pem`);
      }
      console.log(`  Then: Settings → General → VPN & Device Management → Install,`);
      console.log(`        Settings → General → About → Certificate Trust Settings → enable mkcert.`);
    }
  });
}

const httpServer = http.createServer();
httpServer.__port = PORT;
start(httpServer, "HTTP");

// Optional HTTPS (required by iOS Safari for DeviceMotion permission).
const certPath = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "certs");
const keyFile = path.join(certPath, "key.pem");
const certFile = path.join(certPath, "cert.pem");
if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
  const httpsServer = https.createServer({
    key: fs.readFileSync(keyFile),
    cert: fs.readFileSync(certFile),
  });
  httpsServer.__port = HTTPS_PORT;
  start(httpsServer, "HTTPS");
} else {
  console.log(
    "\n[hint] HTTPS disabled (no certs/key.pem & certs/cert.pem found).\n" +
    "       iOS Safari REQUIRES HTTPS for DeviceMotion.requestPermission.\n" +
    "       See README for mkcert setup or use a tunnel (cloudflared / ngrok).",
  );
}
