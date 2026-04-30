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
import { GestureDetector } from "./gestureDetector.js";

const PORT = Number(process.env.PORT || 8080);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);
const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "public");

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

function serveStatic(req, res) {
  const parsed = url.parse(req.url);
  let pathname = decodeURIComponent(parsed.pathname || "/");

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
    r = { controllers: new Set(), games: new Set(), detector: new GestureDetector() };
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
        const event = room.detector.ingest(msg);
        if (event) broadcast(room.games, { type: "attack", ...event });
      } else if (msg.type === "button") {
        // Pass-through for discrete buttons (block, attack trigger, etc.)
        broadcast(room.games, { type: "button", ...msg });
      } else if (msg.type === "orientation") {
        // Continuous orientation for aiming / on-screen sword preview.
        broadcast(room.games, { type: "orientation", ...msg });
      } else if (msg.type === "calibrate") {
        room.detector.calibrate();
        broadcast(room.games, { type: "calibrated" });
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
