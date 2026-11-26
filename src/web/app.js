// Express application: wiring for security middleware, the JSON API, the
// web pages and the operational endpoints (health, readiness, metrics).
import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { config } from '../config.js';
import { ensureSources } from '../ingest/run.js';
import { log } from '../log.js';
import { inc, renderMetrics } from '../metrics.js';
import { isPrivateAddress } from '../http/ssrf.js';
import { schedulerHealthy } from '../scheduler.js';
import { SqliteStore, csrf } from './security.js';
import { createContext } from './context.js';
import { fmt } from './format.js';
import { apiRouter } from './api.js';
import { openapi } from './openapi.js';
import { accountRoutes } from './routes/account.js';
import { opportunityRoutes } from './routes/opportunities.js';
import { searchRoutes } from './routes/searches.js';
import { adminRoutes } from './routes/admin.js';

export function createApp(db) {
  ensureSources(db);
  const ctx = createContext(db);
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(import.meta.dirname, 'views'));
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.locals.fmt = fmt;

  // Request id, access log and request metrics.
  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    req.id = (req.get('x-request-id') || '').replace(/[^\w-]/g, '').slice(0, 64) || crypto.randomUUID();
    res.set('X-Request-Id', req.id);
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      inc('bidfinder_http_requests_total', { status: `${Math.floor(res.statusCode / 100)}xx` });
      inc('bidfinder_http_request_duration_seconds_sum', {}, ms / 1000);
      if (!['/healthz', '/readyz', '/metrics'].includes(req.path) && !req.path.startsWith('/static/')) {
        log.info(`${req.method} ${req.path} ${res.statusCode}`, { id: req.id, ms: Math.round(ms), ip: req.ip });
      }
    });
    next();
  });

  // --- Operational endpoints: no session, no cookies -----------------------

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.get('/readyz', (req, res) => {
    try {
      db.prepare('SELECT 1').get();
      if (!schedulerHealthy()) return res.status(503).json({ ok: false, reason: 'scheduler stalled' });
      res.json({ ok: true, version: config.version });
    } catch (err) {
      res.status(503).json({ ok: false, reason: 'database unavailable' });
    }
  });

  // Prometheus metrics. With METRICS_TOKEN set, a bearer token is needed;
  // without it, only callers on this machine or a private network get in.
  app.get('/metrics', (req, res) => {
    const allowed = config.metricsToken
      ? req.get('authorization') === `Bearer ${config.metricsToken}`
      : isPrivateAddress(String(req.ip || '').replace(/^::ffff:/, ''));
    if (!allowed) return res.status(404).end();
    res.type('text/plain; version=0.0.4').send(renderMetrics(db));
  });

  app.use(helmet({
    contentSecurityPolicy: { directives: { 'upgrade-insecure-requests': null, 'form-action': ["'self'"] } },
    hsts: config.secureCookies,
    referrerPolicy: { policy: 'same-origin' },
  }));
  app.use('/api/v1', apiRouter(ctx));

  app.use('/static', express.static(path.join(import.meta.dirname, 'public'), { maxAge: '1h' }));
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
      if (!req.user || !req.org || req.org.plan === 'suspended') {
        delete req.session.userId;
        req.user = req.org = undefined;
      }
    }
    const sourceNames = Object.fromEntries(db.prepare('SELECT key, name FROM sources ORDER BY name').all().map((s) => [s.key, s.name]));
    Object.assign(res.locals, { user: req.user, org: req.org, path: req.path, sourceNames, flash: req.session.flash, version: config.version, hosted: config.hosted, canRegister: !req.user && ctx.registrationOpen(config) });
    delete req.session.flash;
    next();
  });

  app.get('/', (req, res) => {
    if (req.user) return res.redirect('/dashboard');
    const stats = db.prepare('SELECT COUNT(*) AS open FROM opportunities WHERE closes_at IS NULL OR closes_at > ?').get(new Date().toISOString());
    const sources = db.prepare('SELECT COUNT(*) AS n FROM sources WHERE enabled = 1').get().n;
    res.render('landing', { stats, sources, canRegister: ctx.registrationOpen(config) });
  });

  app.get('/api', ctx.requireUser, (req, res) => res.render('api-docs', { spec: openapi(), baseUrl: config.baseUrl }));

  accountRoutes(app, ctx);
  opportunityRoutes(app, ctx);
  searchRoutes(app, ctx);
  adminRoutes(app, ctx);

  app.use((req, res) => res.status(404).render('error', { message: 'Page not found.' }));
   
  app.use((err, req, res, next) => {
    log.error(`Unhandled error on ${req.method} ${req.path}`, err, { id: req.id });
    res.status(500).render('error', { message: 'Something went wrong. It has been logged.' });
  });
  return app;
}
