// Express application: pages for SMEs and hubs, plus the platform admin.
import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { connectors } from '../connectors/index.js';
import { ensureSources, isIngestRunning, runAll } from '../ingest/run.js';
import { getFeed, getProfile, setState } from '../match/feed.js';
import { scoreOpportunity, splitList } from '../match/score.js';
import { sendDigest } from '../notify/digest.js';
import { SqliteStore, csrf, loginThrottle } from './security.js';

const SOURCE_NAMES = Object.fromEntries(connectors.map((c) => [c.key, c.name]));

export function createApp(db) {
  ensureSources(db);
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(import.meta.dirname, 'views'));
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');

  app.use(helmet({ contentSecurityPolicy: { directives: { 'upgrade-insecure-requests': null } }, hsts: config.secureCookies }));
  app.use('/static', express.static(path.join(import.meta.dirname, 'public'), { maxAge: '1d' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(express.json({ limit: '100kb' }));
  app.use(session({
    store: new SqliteStore(db),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    name: 'bf.sid',
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, maxAge: 30 * 864e5 },
  }));
  app.use(csrf);

  // Load the signed-in user and their organisation for every request.
  app.use((req, res, next) => {
    const userId = req.session.userId;
    if (userId) {
      req.user = db.prepare('SELECT id, email, name, is_platform_admin FROM users WHERE id = ?').get(userId);
      req.org = req.user && db.prepare(`
        SELECT o.*, m.role FROM orgs o JOIN memberships m ON m.org_id = o.id
        WHERE m.user_id = ? ORDER BY m.role = 'owner' DESC, o.id LIMIT 1
      `).get(userId);
      if (!req.user || !req.org) delete req.session.userId;
    }
    Object.assign(res.locals, { user: req.user, org: req.org, path: req.path, sourceNames: SOURCE_NAMES, flash: req.session.flash });
    delete req.session.flash;
    next();
  });

  const flash = (req, message) => { req.session.flash = message; };
  const requireUser = (req, res, next) => (req.user ? next() : res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`));
  const requireAdmin = (req, res, next) => (req.user?.is_platform_admin ? next() : res.status(403).render('error', { message: 'Platform administrators only.' }));
  const loadOpportunity = (id) => db.prepare('SELECT * FROM opportunities WHERE id = ?').get(Number(id));

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.get('/', (req, res) => {
    if (req.user) return res.redirect('/feed');
    const stats = db.prepare(`SELECT COUNT(*) AS open FROM opportunities WHERE closes_at IS NULL OR closes_at > ?`).get(new Date().toISOString());
    res.render('landing', { stats });
  });

  // --- Accounts -----------------------------------------------------------

  app.get('/register', (req, res) => res.render('register', { error: null, form: {} }));

  app.post('/register', async (req, res) => {
    const form = {
      name: (req.body.name || '').trim(),
      email: (req.body.email || '').trim().toLowerCase(),
      orgName: (req.body.orgName || '').trim(),
      kind: req.body.kind === 'hub' ? 'hub' : 'company',
    };
    const password = req.body.password || '';
    const error =
      !form.name || !form.email || !form.orgName ? 'Please fill in every field.'
      : !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email) ? 'That email address does not look right.'
      : password.length < 10 ? 'Use a password of at least 10 characters.'
      : db.prepare('SELECT 1 FROM users WHERE email = ?').get(form.email) ? 'An account with that email already exists.'
      : null;
    if (error) return res.status(400).render('register', { error, form });

    const hash = await bcrypt.hash(password, 12);
    const userId = db.transaction(() => {
      // The very first account on a fresh install runs the platform.
      const first = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
      const user = db.prepare('INSERT INTO users (email, name, password_hash, is_platform_admin) VALUES (?, ?, ?, ?)').run(form.email, form.name, hash, first ? 1 : 0);
      const org = db.prepare('INSERT INTO orgs (name, kind) VALUES (?, ?)').run(form.orgName, form.kind);
      db.prepare(`INSERT INTO memberships (user_id, org_id, role) VALUES (?, ?, 'owner')`).run(user.lastInsertRowid, org.lastInsertRowid);
      db.prepare('INSERT INTO profiles (org_id, digest_emails) VALUES (?, ?)').run(org.lastInsertRowid, form.email);
      return user.lastInsertRowid;
    })();
    req.session.regenerate(() => {
      req.session.userId = userId;
      flash(req, 'Welcome! Tell us what you are looking for and we will rank every opportunity for you.');
      res.redirect('/profile');
    });
  });

  app.get('/login', (req, res) => res.render('login', { error: null, email: '', next: req.query.next || '' }));

  app.post('/login', async (req, res) => {
    const email = (req.body.email || '').trim().toLowerCase();
    const next = /^\/[^/]/.test(req.body.next || '') ? req.body.next : '/feed';
    if (loginThrottle.blocked(req)) return res.status(429).render('login', { error: 'Too many attempts. Try again in 15 minutes.', email, next });
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !(await bcrypt.compare(req.body.password || '', user.password_hash))) {
      loginThrottle.fail(req);
      return res.status(401).render('login', { error: 'Email or password is incorrect.', email, next });
    }
    loginThrottle.clear(req);
    req.session.regenerate(() => {
      req.session.userId = user.id;
      res.redirect(next);
    });
  });

  app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

  // --- Feed and opportunities --------------------------------------------

  app.get('/feed', requireUser, (req, res) => {
    const filters = {
      q: String(req.query.q || '').slice(0, 200),
      type: ['grant', 'tender'].includes(req.query.type) ? req.query.type : '',
      source: SOURCE_NAMES[req.query.source] ? req.query.source : '',
      view: ['matches', 'all', 'starred', 'hidden'].includes(req.query.view) ? req.query.view : 'matches',
    };
    const feed = getFeed(db, req.org.id, filters);
    const profileEmpty = !splitList(feed.profile.keywords).length;
    res.render('feed', { ...feed, filters, profileEmpty, ingesting: isIngestRunning() });
  });

  app.get('/o/:id', requireUser, (req, res) => {
    const opp = loadOpportunity(req.params.id);
    if (!opp) return res.status(404).render('error', { message: 'Opportunity not found.' });
    const state = db.prepare('SELECT * FROM org_opportunity_state WHERE org_id = ? AND opportunity_id = ?').get(req.org.id, opp.id) || {};
    res.render('opportunity', { opp, state, match: scoreOpportunity(opp, getProfile(db, req.org.id)) });
  });

  app.post('/o/:id/state', requireUser, (req, res) => {
    const opp = loadOpportunity(req.params.id);
    if (!opp) return res.status(404).json({ error: 'not found' });
    const changes = {};
    for (const key of ['starred', 'hidden']) if (key in req.body) changes[key] = ['1', 'true', true, 1].includes(req.body[key]) ? 1 : 0;
    if (typeof req.body.note === 'string') changes.note = req.body.note.slice(0, 5000);
    setState(db, req.org.id, opp.id, changes);
    if (req.is('json')) return res.json({ ok: true, ...changes });
    res.redirect(/^\/[^/\\]/.test(req.body.back || '') ? req.body.back : `/o/${opp.id}`);
  });

  // --- Profile -------------------------------------------------------------

  app.get('/profile', requireUser, (req, res) => {
    res.render('profile', { profile: getProfile(db, req.org.id), error: null });
  });

  app.post('/profile', requireUser, (req, res) => {
    const b = req.body;
    const money = (v) => {
      const n = Number(String(v || '').replace(/[£,\s]/g, ''));
      return v && Number.isFinite(n) && n >= 0 ? n : null;
    };
    const list = (v) => splitList(Array.isArray(v) ? v.join('\n') : v).join('\n');
    const types = ['grant', 'tender'].filter((t) => [].concat(b.types || []).includes(t));
    db.prepare(`
      UPDATE profiles SET keywords = ?, exclude_keywords = ?, regions = ?, applicant_types = ?, types = ?,
        min_award = ?, max_award = ?, min_score = ?, digest_frequency = ?, digest_emails = ?, updated_at = datetime('now')
      WHERE org_id = ?
    `).run(
      list(b.keywords), list(b.exclude_keywords), list(b.regions), list(b.applicant_types), (types.length ? types : ['grant']).join('\n'),
      money(b.min_award), money(b.max_award), Math.min(100, Math.max(0, Number(b.min_score) || 0)),
      ['daily', 'weekly', 'off'].includes(b.digest_frequency) ? b.digest_frequency : 'daily',
      list(b.digest_emails).split('\n').filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)).join('\n'),
      req.org.id,
    );
    if (b.org_name?.trim() && req.org.role === 'owner') db.prepare('UPDATE orgs SET name = ? WHERE id = ?').run(b.org_name.trim().slice(0, 200), req.org.id);
    flash(req, 'Profile saved. Your feed has been re-ranked.');
    res.redirect('/feed');
  });

  // --- Digests and sharing -------------------------------------------------

  app.get('/digests', requireUser, (req, res) => {
    const digests = db.prepare('SELECT id, created_at, item_count, recipients, delivered FROM digests WHERE org_id = ? ORDER BY id DESC LIMIT 50').all(req.org.id);
    res.render('digests', { digests, smtp: Boolean(config.smtp.url) });
  });

  app.get('/digests/:id', requireUser, (req, res) => {
    const digest = db.prepare('SELECT * FROM digests WHERE id = ? AND org_id = ?').get(Number(req.params.id), req.org.id);
    if (!digest) return res.status(404).render('error', { message: 'Digest not found.' });
    res.render('digest', { digest });
  });

  app.post('/digests/now', requireUser, async (req, res) => {
    const result = await sendDigest(db, req.org);
    flash(req, result ? `Digest built with ${result.count} opportunities${result.delivered ? ' and emailed' : ''}.` : 'Nothing new since your last digest.');
    res.redirect('/digests');
  });

  // A hub (or company) can publish its starred list as a read-only page to
  // share with members or colleagues, without them needing an account.
  app.post('/share', requireUser, (req, res) => {
    const token = req.body.enable === '1' ? crypto.randomBytes(12).toString('base64url') : null;
    db.prepare('UPDATE orgs SET share_token = ? WHERE id = ?').run(token, req.org.id);
    flash(req, token ? 'Shared shortlist is live. Anyone with the link can view it.' : 'Shared shortlist turned off.');
    res.redirect('/feed?view=starred');
  });

  app.get('/s/:token', (req, res) => {
    const org = db.prepare('SELECT * FROM orgs WHERE share_token = ?').get(req.params.token);
    if (!org) return res.status(404).render('error', { message: 'This shared list does not exist or has been turned off.' });
    const { items } = getFeed(db, org.id, { view: 'starred' });
    res.render('shared', { sharedOrg: org, items });
  });

  // --- Platform admin ------------------------------------------------------

  app.get('/admin', requireUser, requireAdmin, (req, res) => {
    const sources = db.prepare(`
      SELECT s.*, (SELECT COUNT(*) FROM opportunities o WHERE o.source_key = s.key AND (o.closes_at IS NULL OR o.closes_at > ?)) AS open_count
      FROM sources s ORDER BY s.name
    `).all(new Date().toISOString());
    const orgs = db.prepare(`
      SELECT o.*, (SELECT COUNT(*) FROM memberships m WHERE m.org_id = o.id) AS members,
        (SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = o.id AND m.role = 'owner' LIMIT 1) AS owner_email
      FROM orgs o ORDER BY o.created_at DESC
    `).all();
    res.render('admin', { sources, orgs, ingesting: isIngestRunning() });
  });

  app.post('/admin/ingest', requireUser, requireAdmin, (req, res) => {
    const only = SOURCE_NAMES[req.body.source] ? req.body.source : undefined;
    runAll(db, { only }); // runs in the background; the page shows progress
    flash(req, `Refresh started${only ? ` for ${SOURCE_NAMES[only]}` : ''}. It takes a minute or two.`);
    res.redirect('/admin');
  });

  app.post('/admin/sources/:key/toggle', requireUser, requireAdmin, (req, res) => {
    db.prepare('UPDATE sources SET enabled = 1 - enabled WHERE key = ?').run(req.params.key);
    res.redirect('/admin');
  });

  app.post('/admin/orgs/:id/plan', requireUser, requireAdmin, (req, res) => {
    if (['trial', 'solo', 'hub', 'suspended'].includes(req.body.plan)) {
      db.prepare('UPDATE orgs SET plan = ? WHERE id = ?').run(req.body.plan, Number(req.params.id));
    }
    res.redirect('/admin');
  });

  app.use((req, res) => res.status(404).render('error', { message: 'Page not found.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('error', { message: 'Something went wrong. It has been logged.' });
  });
  return app;
}
