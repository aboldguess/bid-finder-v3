// Runtime configuration, read once from environment variables.
// Everything has a working default so a fresh install runs with no setup.
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';

const root = path.resolve(import.meta.dirname, '..');
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });

// A session secret is generated on first run and kept in the data directory,
// so cookies survive restarts without anyone having to set one by hand.
function loadSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(dataDir, 'session-secret');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return fs.readFileSync(file, 'utf8').trim();
}

export const config = {
  root,
  dataDir,
  dbFile: process.env.DB_FILE || path.join(dataDir, 'bidfinder.db'),
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  baseUrl: (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ''),
  sessionSecret: loadSessionSecret(),
  secureCookies: process.env.SECURE_COOKIES === 'true',
  ingestCron: process.env.INGEST_CRON || '30 5 * * *',
  digestCron: process.env.DIGEST_CRON || '0 7 * * *',
  maxPagesPerSource: Number(process.env.MAX_PAGES_PER_SOURCE || 30),
  userAgent: process.env.USER_AGENT || 'BidFinder/3 (opportunity alerts for UK SMEs)',
  smtp: {
    url: process.env.SMTP_URL || '',
    from: process.env.MAIL_FROM || 'Bid Finder <no-reply@localhost>',
  },
};
