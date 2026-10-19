/**
 * Quickshoot — Multi-User Signaling Server
 * -------------------------------------------
 * Supports unlimited users per room in a full-mesh WebRTC topology.
 * Each pair of users negotiates a direct P2P connection via this server.
 *
 * What this server DOES:
 *   - Serves the static frontend (public/).
 *   - Generates short-lived room codes.
 *   - Assigns each socket a unique peerId on connection.
 *   - Relays WebRTC SDP/ICE signals between specific peer pairs using
 *     { to, from } targeting so every user can connect to every other user.
 *   - Notifies all room members when someone joins or leaves.
 *
 * What this server NEVER does:
 *   - Never sees chat messages or file bytes (P2P DataChannels only).
 *   - Never writes to disk or a database.
 */

const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const compression = require("compression");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const ROOM_CODE_LENGTH = 8;
const ROOM_JOIN_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const HEARTBEAT_INTERVAL_MS = 25 * 1000;

const METERED_SUBDOMAIN = process.env.METERED_SUBDOMAIN || "";
const METERED_API_KEY = process.env.METERED_API_KEY || "";

/** @type {Map<string, Room>} */
const rooms = new Map();

function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: ROOM_CODE_LENGTH }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function generatePeerId() {
  return crypto.randomBytes(6).toString("hex");
}

class Room {
  constructor(code, passphrase = null) {
    this.code = code;
    this.passphrase = passphrase;
    /** @type {Map<string, WebSocket>} peerId -> socket */
    this.peers = new Map();
    /** @type {Map<string, string>} peerId -> display name (Host / U1 / U2 / ...) */
    this.names = new Map();
    /** Ascending counter used to assign U1, U2, U3... to joiners in order. */
    this.joinCounter = 0;
    this.createdAt = Date.now();
    this.joinTimer = setTimeout(() => {
      if (this.peers.size === 0) this.destroy("expired_unjoined");
    }, ROOM_JOIN_TIMEOUT_MS);
  }

  checkPassphrase(passphrase) {
    return this.passphrase === passphrase;
  }

  addPeer(peerId, socket) {
    this.peers.set(peerId, socket);
    clearTimeout(this.joinTimer);
  }

  removePeer(peerId) {
    this.peers.delete(peerId);
    if (this.peers.size === 0) this.destroy("empty");
  }

  /** Send a message to all peers except the sender. */
  broadcast(senderPeerId, msg) {
    const raw = JSON.stringify(msg);
    for (const [pid, sock] of this.peers) {
      if (pid !== senderPeerId && sock.readyState === sock.OPEN) {
        try { sock.send(raw); } catch { /* closing */ }
      }
    }
  }

  /** Send to a specific peer. */
  sendTo(peerId, msg) {
    const sock = this.peers.get(peerId);
    if (sock && sock.readyState === sock.OPEN) {
      try { sock.send(JSON.stringify(msg)); } catch { /* closing */ }
    }
  }

  destroy(reason) {
    clearTimeout(this.joinTimer);
    rooms.delete(this.code);
    for (const [, sock] of this.peers) {
      if (sock.readyState === sock.OPEN) {
        try { sock.send(JSON.stringify({ type: "room-closed", reason })); } catch {}
        sock.roomCode = null;
        sock.peerId = null;
      }
    }
    this.peers.clear();
    this.names.clear();
  }

  peerList() {
    return [...this.peers.keys()];
  }
}

function send(socket, message) {
  try { socket.send(JSON.stringify(message)); } catch {}
}

// ---------------------------------------------------------------------------
// HTTP + static frontend
// ---------------------------------------------------------------------------
const app = express();
const PUBLIC_DIR = path.join(__dirname, "public");

// CSP header for security
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", 
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; " +
    "font-src 'self' data:; " +
    "connect-src 'self' wss: https:; " +
    "media-src 'self' blob:; " +
    "worker-src 'self' blob:; " +
    "frame-ancestors 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self';"
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

// Simple in-memory rate limiting
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 100; // max requests per window

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const record = rateLimitMap.get(ip) || { count: 0, resetTime: now + RATE_LIMIT_WINDOW };
  
  if (now > record.resetTime) {
    record.count = 0;
    record.resetTime = now + RATE_LIMIT_WINDOW;
  }
  
  record.count++;
  rateLimitMap.set(ip, record);
  
  res.setHeader("X-RateLimit-Limit", RATE_LIMIT_MAX);
  res.setHeader("X-RateLimit-Remaining", Math.max(0, RATE_LIMIT_MAX - record.count));
  res.setHeader("X-RateLimit-Reset", Math.ceil(record.resetTime / 1000));
  
  if (record.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: "Too many requests" });
  }
  
  next();
}

app.use(rateLimit);

app.use(compression());
app.use(express.static(PUBLIC_DIR, {
  etag: true,
  setHeaders(res, filePath) {
    if (/\.(png|jpe?g|webp|avif|woff2?|mp4|ico)$/i.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=604800, immutable");
    } else {
      res.setHeader("Cache-Control", "no-cache");
    }
  },
}));

// Clean up old rate limit entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitMap.entries()) {
    if (now > record.resetTime) rateLimitMap.delete(ip);
  }
  for (const [ip, record] of wsConnectionMap.entries()) {
    if (now > record.resetTime) wsConnectionMap.delete(ip);
  }
}, 300000); // every 5 minutes

app.get("/healthz", (req, res) => {
  res.json({ ok: true, activeRooms: rooms.size });
});

app.get("/turn-credentials", async (req, res) => {
  if (!METERED_SUBDOMAIN || !METERED_API_KEY) {
    return res.status(503).json({ error: "Metered TURN not configured" });
  }
  try {
    const url = `https://${METERED_SUBDOMAIN}.metered.live/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`;
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text();
      console.error("[TURN] Metered API error:", response.status, text);
      return res.status(502).json({ error: "Failed to fetch TURN credentials from Metered" });
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("[TURN] Failed to fetch Metered credentials:", err.message);
    res.status(502).json({ error: "Failed to fetch TURN credentials" });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// WebSocket connection rate limiting
const wsConnectionMap = new Map();
const WS_RATE_LIMIT_WINDOW = 60000; // 1 minute
const WS_RATE_LIMIT_MAX = 10; // max WS connections per IP per minute

function checkWsRateLimit(ip) {
  const now = Date.now();
  const record = wsConnectionMap.get(ip) || { count: 0, resetTime: now + WS_RATE_LIMIT_WINDOW };
  
  if (now > record.resetTime) {
    record.count = 0;
    record.resetTime = now + WS_RATE_LIMIT_WINDOW;
  }
  
  record.count++;
  wsConnectionMap.set(ip, record);
  
  return record.count <= WS_RATE_LIMIT_MAX;
}

wss.on("connection", (socket, req) => {
  const clientIp = req.socket.remoteAddress;
  
  if (!checkWsRateLimit(clientIp)) {
    socket.close(1008, "Connection rate limit exceeded");
    return;
  }
  
  socket.isAlive = true;
  socket.roomCode = null;
  socket.peerId = generatePeerId(); // unique ID for this connection

  socket.on("pong", () => { socket.isAlive = true; });

  socket.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch {
      return send(socket, { type: "error", message: "Malformed message." });
    }

    switch (msg.type) {

      case "host": {
        const code = generateRoomCode();
        const passphrase = msg.passphrase || null;
        const room = new Room(code, passphrase);
        rooms.set(code, room);
        room.addPeer(socket.peerId, socket);
        room.names.set(socket.peerId, "Host");
        socket.roomCode = code;
        send(socket, { type: "hosted", code, peerId: socket.peerId, name: "Host", hasPassphrase: !!passphrase });
        break;
      }

      case "join": {
      const code = String(msg.code || "").toUpperCase().trim();
      const passphrase = msg.passphrase || null;
      const room = rooms.get(code);

      if (!room) return send(socket, { type: "error", message: "Room code not found or expired." });

      if (room.passphrase && !room.checkPassphrase(passphrase)) {
        return send(socket, { type: "error", message: "Incorrect passphrase." });
      }

      // Enforce a maximum of 2 participants per room (host + one joiner)
      if (room.peers.size >= 2) {
        return send(socket, { type: "error", message: "This room is full. The chat is already in use." });
      }

      // Snapshot existing peers + their display names BEFORE adding the new one
      const existingPeers = room.peerList().map((pid) => ({
        peerId: pid,
        name: room.names.get(pid) || pid.slice(0, 4).toUpperCase(),
      }));

      // Ascending name: U1, U2, U3... assigned in join order, never reused
      room.joinCounter += 1;
      const name = `U${room.joinCounter}`;
      room.names.set(socket.peerId, name);

      room.addPeer(socket.peerId, socket);
      socket.roomCode = code;

        // Tell the joiner: your peerId/name + all existing peers (with names) in the room
        send(socket, { type: "joined", code, peerId: socket.peerId, name, peers: existingPeers });

        // Tell all existing peers that a new user arrived (with their assigned name)
        room.broadcast(socket.peerId, { type: "peer-joined", peerId: socket.peerId, name });
        break;
      }

      // Targeted signal: { type:"signal", to, payload }
      // from is always the sender's peerId (set server-side for security)
      case "signal": {
        const room = rooms.get(socket.roomCode);
        if (!room) return send(socket, { type: "error", message: "No active room." });
        const target = msg.to;
        if (!target) return;
        room.sendTo(target, { type: "signal", from: socket.peerId, payload: msg.payload });
        break;
      }

      case "leave": {
        const room = rooms.get(socket.roomCode);
        if (room) {
          const name = room.names.get(socket.peerId);
          room.broadcast(socket.peerId, { type: "peer-left", peerId: socket.peerId, name });
          room.removePeer(socket.peerId);
          room.names.delete(socket.peerId);
        }
        socket.roomCode = null;
        break;
      }

      case "ping":
        send(socket, { type: "pong" });
        break;

      default:
        send(socket, { type: "error", message: `Unknown message type: ${msg.type}` });
    }
  });

  socket.on("close", () => {
    const room = rooms.get(socket.roomCode);
    if (room) {
      const name = room.names.get(socket.peerId);
      room.broadcast(socket.peerId, { type: "peer-left", peerId: socket.peerId, name });
      room.removePeer(socket.peerId);
      room.names.delete(socket.peerId);
    }
  });
});

// Heartbeat — drop dead sockets
setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) { socket.terminate(); continue; }
    socket.isAlive = false;
    socket.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Quickshoot multi-user signaling server listening on :${PORT}`);
});
