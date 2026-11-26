// Session store, CSRF protection, login throttling, rate limits and sign-up
// bot checks.
import crypto from 'node:crypto';
import session from 'express-session';

// express-session store backed by the app's own SQLite database.
export class SqliteStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  }
  get(sid, cb) {
    const row = this.db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?').get(sid);
    cb(null, row && row.expires > Date.now() ? JSON.parse(row.sess) : null);
  }
  set(sid, sess, cb) {
    const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 864e5;
    this.db.prepare('INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires')
      .run(sid, JSON.stringify(sess), expires);
    cb?.(null);
  }
  destroy(sid, cb) {
    this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
    cb?.(null);
  }
  touch(sid, sess, cb) {
    this.set(sid, sess, cb);
  }
}

// Synchroniser-token CSRF: one random token per session, required on every
// state-changing request as a form field or an X-CSRF-Token header.
export function csrf(req, res, next) {
  req.session.csrf ??= crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrf;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = req.body?._csrf || req.get('x-csrf-token') || '';
  const a = Buffer.from(sent);
  const b = Buffer.from(req.session.csrf);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.status(403).send('Your session expired. Go back, refresh the page and try again.');
}

// At most 10 failed logins per email+IP in 15 minutes.
const failures = new Map();
const WINDOW = 15 * 60e3;
export const loginThrottle = {
  key: (req) => `${req.ip}|${(req.body?.email || '').toLowerCase()}`,
  blocked(req) {
    const f = failures.get(this.key(req));
    return Boolean(f && f.count >= 10 && Date.now() - f.first < WINDOW);
  },
  fail(req) {
    const k = this.key(req);
    const f = failures.get(k);
    if (!f || Date.now() - f.first > WINDOW) failures.set(k, { count: 1, first: Date.now() });
    else f.count++;
  },
  clear(req) {
    failures.delete(this.key(req));
  },
};

// Fixed-window counter: at most `max` hits per key in `windowMs`. Kept in
// memory, which suits one web process; limits reset when it restarts.
export function createLimiter({ max, windowMs, now = Date.now }) {
  const hits = new Map();
  const sweep = () => { for (const [k, h] of hits) if (now() - h.first >= windowMs) hits.delete(k); };
  return {
    max,
    // Seconds until the key may try again, or 0 if it is under the limit.
    retryAfter(key) {
      const h = hits.get(key);
      if (!h || now() - h.first >= windowMs || h.count < max) return 0;
      return Math.max(1, Math.ceil((h.first + windowMs - now()) / 1000));
    },
    hit(key) {
      if (hits.size > 10000) sweep();
      const h = hits.get(key);
      if (!h || now() - h.first >= windowMs) hits.set(key, { count: 1, first: now() });
      else h.count++;
    },
    clear(key) { hits.delete(key); },
  };
}

// Limits for the public account forms, one set per app.
export const createAuthLimits = (opts = {}) => ({
  // Failed sign-ins from one address across every email: stops password spraying.
  loginIp: createLimiter({ max: 30, windowMs: 15 * 60e3, ...opts }),
  // Sign-up attempts (good or bad) from one address.
  signupAttempts: createLimiter({ max: 10, windowMs: 60 * 60e3, ...opts }),
  // Accounts actually created from one address.
  signupCreated: createLimiter({ max: 5, windowMs: 24 * 60 * 60e3, ...opts }),
  // Password reset requests, per address and per email (used by the reset form).
  resetIp: createLimiter({ max: 10, windowMs: 60 * 60e3, ...opts }),
  resetEmail: createLimiter({ max: 3, windowMs: 60 * 60e3, ...opts }),
});

export const tooMany = (res, seconds) => res.set('Retry-After', String(seconds)).status(429);

// Bot checks for sign-up: a hidden field people never see (a honeypot) and a
// minimum time between showing the form and sending it. Neither needs a
// third-party CAPTCHA or its cookies.
export const HONEYPOT = 'website';
export const markFormShown = (req) => { req.session.formShownAt = Date.now(); };
export function looksLikeBot(req, minSeconds) {
  if (String(req.body?.[HONEYPOT] || '').trim()) return 'honeypot';
  const shown = Number(req.session.formShownAt) || 0;
  if (minSeconds > 0 && (!shown || Date.now() - shown < minSeconds * 1000)) return 'too-fast';
  return null;
}
