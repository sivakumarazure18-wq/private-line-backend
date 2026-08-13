import "dotenv/config";
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { v4 as uuid } from "uuid";
import { WebSocketServer } from "ws";
import http from "http";
import db from "./db.js";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("FATAL: JWT_SECRET env var is not set. Refusing to start.");
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());

// ---- basic rate limiting (per-IP, in-memory) ----
const attempts = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = req.ip + req.path;
    const now = Date.now();
    const record = attempts.get(key) || { count: 0, reset: now + windowMs };
    if (now > record.reset) {
      record.count = 0;
      record.reset = now + windowMs;
    }
    record.count++;
    attempts.set(key, record);
    if (record.count > max) {
      return res.status(429).json({ error: "Too many requests, slow down." });
    }
    next();
  };
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ---- registration: client generates its own keypairs locally, uploads only public keys ----
app.post("/register", rateLimit(5, 60_000), async (req, res) => {
  const { username, password, identityPublicKey, signedPrekey, signedPrekeySig, oneTimePrekeys } = req.body;
  if (!username || !password || !identityPublicKey || !signedPrekey || !signedPrekeySig) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  if (password.length < 10) {
    return res.status(400).json({ error: "Password must be at least 10 characters" });
  }
  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
  if (existing) return res.status(409).json({ error: "Username taken" });

  const id = uuid();
  const passwordHash = await bcrypt.hash(password, 12);
  db.prepare(
    `INSERT INTO users (id, username, password_hash, identity_public_key, signed_prekey, signed_prekey_sig, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, username, passwordHash, identityPublicKey, signedPrekey, signedPrekeySig, Date.now());

  if (Array.isArray(oneTimePrekeys)) {
    const insert = db.prepare("INSERT INTO one_time_prekeys (id, user_id, public_key) VALUES (?, ?, ?)");
    const tx = db.transaction((keys) => {
      for (const k of keys) insert.run(uuid(), id, k);
    });
    tx(oneTimePrekeys.slice(0, 100));
  }

  const token = jwt.sign({ sub: id, username }, JWT_SECRET, { expiresIn: "30d" });
  res.status(201).json({ token, userId: id });
});

app.post("/login", rateLimit(10, 60_000), async (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user) return res.status(401).json({ error: "Invalid credentials" });
  const ok = await bcrypt.compare(password || "", user.password_hash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });
  const token = jwt.sign({ sub: user.id, username }, JWT_SECRET, { expiresIn: "30d" });
  res.json({ token, userId: user.id });
});

// ---- key bundle fetch: what the Android client uses to start a new encrypted session (X3DH) ----
app.get("/users/:username/keybundle", authMiddleware, (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(req.params.username);
  if (!user) return res.status(404).json({ error: "User not found" });

  const otk = db.prepare("SELECT * FROM one_time_prekeys WHERE user_id = ? AND used = 0 LIMIT 1").get(user.id);
  if (otk) db.prepare("UPDATE one_time_prekeys SET used = 1 WHERE id = ?").run(otk.id);

  res.json({
    userId: user.id,
    identityPublicKey: user.identity_public_key,
    signedPrekey: user.signed_prekey,
    signedPrekeySig: user.signed_prekey_sig,
    oneTimePrekey: otk ? otk.public_key : null,
  });
});

// ---- pull undelivered messages (still just ciphertext) ----
app.get("/messages/inbox", authMiddleware, (req, res) => {
  const rows = db
    .prepare("SELECT * FROM messages WHERE recipient_id = ? AND delivered = 0 ORDER BY sent_at ASC")
    .all(req.user.sub);
  res.json(rows);
});

app.post("/messages/ack", authMiddleware, (req, res) => {
  const { messageIds } = req.body;
  if (!Array.isArray(messageIds)) return res.status(400).json({ error: "messageIds must be an array" });
  const stmt = db.prepare("UPDATE messages SET delivered = 1 WHERE id = ? AND recipient_id = ?");
  const tx = db.transaction((ids) => { for (const id of ids) stmt.run(id, req.user.sub); });
  tx(messageIds);
  res.json({ ok: true });
});

const server = http.createServer(app);

// ---- WebSocket relay for live delivery; falls back to inbox polling above ----
const wss = new WebSocketServer({ server, path: "/ws" });
const liveConnections = new Map(); // userId -> ws

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const token = url.searchParams.get("token");
  let userId;
  try {
    userId = jwt.verify(token, JWT_SECRET).sub;
  } catch {
    ws.close(4001, "Unauthorized");
    return;
  }
  liveConnections.set(userId, ws);

  ws.on("message", (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      return;
    }
    // Expected shape: { recipientId, ciphertext, iv, ephemeralKey }
    const { recipientId, ciphertext, iv, ephemeralKey } = payload;
    if (!recipientId || !ciphertext || !iv) return;

    const id = uuid();
    const sentAt = Date.now();
    db.prepare(
      `INSERT INTO messages (id, sender_id, recipient_id, ciphertext, iv, ephemeral_key, sent_at, delivered)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(id, userId, recipientId, ciphertext, iv, ephemeralKey || null, sentAt);

    const recipientWs = liveConnections.get(recipientId);
    const outbound = JSON.stringify({ id, senderId: userId, ciphertext, iv, ephemeralKey, sentAt });
    if (recipientWs && recipientWs.readyState === recipientWs.OPEN) {
      recipientWs.send(outbound);
      db.prepare("UPDATE messages SET delivered = 1 WHERE id = ?").run(id);
    }
    ws.send(JSON.stringify({ type: "ack", id })); // confirm receipt to sender
  });

  ws.on("close", () => {
    if (liveConnections.get(userId) === ws) liveConnections.delete(userId);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Private Line backend listening on :${PORT}`));
