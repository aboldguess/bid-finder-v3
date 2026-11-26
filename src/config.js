// Runtime configuration, read once from environment variables.
// Everything has a working default so a fresh install runs with no setup.
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';

const root = path.resolve(import.meta.dirname, '..');
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });

// Secrets are generated on first run and kept in the data directory, so a
// fresh install works with no setup. Set the environment variables instead to
// keep them out of the data volume (and therefore out of database backups).
function loadSecret(envName, fileName) {
  if (process.env[envName]) return process.env[envName];
  const file = path.join(dataDir, fileName);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return fs.readFileSync(file, 'utf8').trim();
}

const port = Number(process.env.PORT || 3000);
const baseUrl = (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');
const bool = (v, fallback = false) => (v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(v));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

export const config = {
  root,
  dataDir,
  version: pkg.version,
  dbFile: process.env.DB_FILE || path.join(dataDir, 'bidfinder.db'),
  port,
  host: process.env.HOST || '0.0.0.0',
  baseUrl,
  sessionSecret: loadSecret('SESSION_SECRET', 'session-secret'),
  // Master key for the credential vault (portal logins, API keys, webhooks).
  secretKey: loadSecret('BIDFINDER_SECRET_KEY', 'secret-key'),
  secureCookies: bool(process.env.SECURE_COOKIES, baseUrl.startsWith('https://')),
  // Which proxies may set X-Forwarded-For. Docker Compose sets this to cover Caddy.
  trustProxy: process.env.TRUST_PROXY || 'loopback',
  // A header holding the visitor's real address, set by the proxy in front,
  // e.g. CF-Connecting-IP behind a Cloudflare Tunnel. Read only on requests
  // from a trusted proxy (TRUST_PROXY), and used for rate limits and logs.
  clientIpHeader: (process.env.CLIENT_IP_HEADER || '').toLowerCase(),
  // Hosted mode: one server shared by many customer organisations. Anyone can
  // sign up and start an organisation, and must accept the terms to do so.
  // Off by default, so a self-hosted install keeps its closed sign-up.
  hosted: bool(process.env.HOSTED),
  // Sign-up is open for the first account only, unless this is set (or HOSTED is). Others join by invite.
  allowRegistration: bool(process.env.ALLOW_REGISTRATION),
  // Sign-up forms sent sooner than this after they were shown are treated as bots.
  signupMinSeconds: Number(process.env.SIGNUP_MIN_SECONDS ?? 3),
  scheduler: !bool(process.env.DISABLE_SCHEDULER),
  digestCron: process.env.DIGEST_CRON || '0 7 * * *',
  maintenanceCron: process.env.MAINTENANCE_CRON || '15 3 * * *',
  timezone: process.env.TZ || 'Europe/London',
  maxPagesPerSource: Number(process.env.MAX_PAGES_PER_SOURCE || 40),
  retentionDays: Number(process.env.RETENTION_DAYS || 180),
  backupsToKeep: Number(process.env.BACKUPS_TO_KEEP || 7),
  // Sent with every request so portal operators can see who is calling and get in touch.
  userAgent: process.env.USER_AGENT || `BidFinder/${pkg.version} (+${baseUrl}; self-hosted tender monitor)`,
  logFormat: process.env.LOG_FORMAT || (process.env.NODE_ENV === 'production' ? 'json' : 'text'),
  logLevel: process.env.LOG_LEVEL || 'info',
  metricsToken: process.env.METRICS_TOKEN || '',
  // Card payments in hosted mode. Without a secret key the billing page says payments are not set up.
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    // Let Stripe Tax work out and add VAT. Needs Stripe Tax set up in the Stripe dashboard.
    tax: bool(process.env.STRIPE_TAX),
    // Pages our forms redirect to (Checkout and the Customer Portal). The
    // Content-Security-Policy must allow them or the browser blocks the redirect.
    origins: ['https://checkout.stripe.com', 'https://billing.stripe.com'],
  },
  smtp: {
    url: process.env.SMTP_URL || '',
    from: process.env.MAIL_FROM || 'Bid Finder <no-reply@localhost>',
  },
};
