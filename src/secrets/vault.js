// Encrypts secrets at rest (portal logins, API keys, webhook URLs) with
// AES-256-GCM. The master key comes from BIDFINDER_SECRET_KEY, or a key file
// generated in the data directory. Ciphertext format: v1:<iv>:<tag>:<data>,
// each part base64url. Losing the key makes stored secrets unrecoverable.
import crypto from 'node:crypto';
import { config } from '../config.js';

let cached;
function key() {
  // scrypt lets the key be any passphrase, not only 32 random bytes.
  cached ??= crypto.scryptSync(config.secretKey, 'bidfinder-vault-v1', 32);
  return cached;
}

export function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join(':');
}

export function decrypt(text) {
  const [version, iv, tag, data] = String(text || '').split(':');
  if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('Stored secret is not in a known format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  try {
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8'));
  } catch {
    throw new Error('Could not decrypt a stored secret. Has BIDFINDER_SECRET_KEY changed?');
  }
}

export const decryptOrNull = (text) => {
  if (!text) return null;
  try { return decrypt(text); } catch { return null; }
};

// Credentials are write-only from the UI: listed by name, never shown again.
export function saveCredential(db, { name, kind, secret }) {
  return db.prepare('INSERT INTO credentials (name, kind, secret) VALUES (?, ?, ?)').run(name, kind, encrypt(secret)).lastInsertRowid;
}

export function loadCredential(db, id) {
  const row = id && db.prepare('SELECT * FROM credentials WHERE id = ?').get(id);
  return row ? { id: row.id, name: row.name, kind: row.kind, ...decrypt(row.secret) } : null;
}
