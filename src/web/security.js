// Session store, CSRF protection and login throttling.
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
