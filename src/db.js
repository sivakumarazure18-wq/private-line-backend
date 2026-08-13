import Database from "better-sqlite3";

const db = new Database("private_line.db");
db.pragma("journal_mode = WAL");

// IMPORTANT: the server NEVER stores plaintext message content.
// `ciphertext` and `iv` are opaque base64 blobs produced by the client's
// AES-GCM encryption — the server cannot decrypt them.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    identity_public_key TEXT NOT NULL,   -- X25519 public key, base64
    signed_prekey TEXT NOT NULL,         -- rotating prekey, base64
    signed_prekey_sig TEXT NOT NULL,     -- signature over the prekey
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS one_time_prekeys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    public_key TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    ciphertext TEXT NOT NULL,   -- base64 AES-GCM ciphertext, opaque to server
    iv TEXT NOT NULL,           -- base64 nonce
    ephemeral_key TEXT,         -- sender's ephemeral X25519 pub key for this message (ratchet)
    sent_at INTEGER NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id, delivered);
`);

export default db;
