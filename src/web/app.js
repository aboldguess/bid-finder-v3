// Express application: wiring for security middleware, the JSON API, the
// web pages and the operational endpoints (health, readiness, metrics).
import crypto from 'node:crypto';
import path from 'node:path';
import net from 'node:net';
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
import { banner, entitlement, getPlan, getSetting, listPlans, pounds } from '../billing/plans.js';
import { billingRoutes, stripeWebhook } from './routes/billing.js';
import { welcomeRoutes } from './routes/welcome.js';
import { dataRoutes } from './routes/data.js';
import { createStripe } from '../billing/stripe.js';
import { VISIBLE, visibleSources } from '../match/visibility.js';
import { fmt } from './format.js';
import { apiRouter } from './api.js';
import { openapi } from './openapi.js';
import { accountRoutes } from './routes/account.js';
import { emailRoutes } from './routes/email.js';
import { opportunityRoutes } from './routes/opportunities.js';
import { searchRoutes } from './routes/searches.js';
import { adminRoutes } from './routes/admin.js';

// The made-up match shown on the hosted home page.
const EXAMPLE_MATCH = {
  id: 0, title: 'Design and build of a hydraulic test rig for rail bogie components', type: 'tender', funder: 'A national rail infrastructure owner',
  source_key: 'find-a-tender', award_min: 1500000, award_max: 1850000, currency: 'GBP', closes_at: new Date(Date.now() + 23 * 864e5).toISOString(), url: '/register',
  summary: 'Design, manufacture, installation and commissioning of a servo-hydraulic fatigue test rig, including control system, instrumentation and data acquisition.',
  match: { score: 91, reasons: ['Title mentions "test rig", "hydraulic"', 'CPV 71333000 is in your category 7133', 'Value is inside your range', 'East Midlands is one of your regions'] },
};

export function createApp(db, { mail, stripe } = {}) {
  ensureSources(db);
  const ctx = createContext(db, { mail });
  ctx.stripe = stripe || createStripe();
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(import.meta.dirname, 'views'));
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.locals.fmt = fmt;

  // Behind a Cloudflare Tunnel every request arrives from cloudflared on this
  // machine; the visitor's address is in CF-Connecting-IP. Trust that header
  // only from a trusted proxy, so nobody can pick their own address to dodge
  // rate limits.
  const trustedProxy = app.get('trust proxy fn');
  app.use((req, res, next) => {
    const header = config.clientIpHeader && req.get(config.clientIpHeader);
    const ip = header && header.trim();
    if (ip && net.isIP(ip) && trustedProxy(req.socket.remoteAddress, 0)) {
      Object.defineProperty(req, 'ip', { value: ip, configurable: true, enumerable: true });
    }
    next();
  });

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
      if (!schedulerHealthy(db)) return res.status(503).json({ ok: false, reason: 'scheduler stalled' });
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
  if (config.hosted) app.post('/stripe/webhook', express.raw({ type: '*/*', limit: '1mb' }), stripeWebhook(db));

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
      req.user = db.prepare('SELECT id, email, name, is_platform_admin, email_verified_at FROM users WHERE id = ?').get(userId);
      req.org = req.user && db.prepare(`
        SELECT o.*, m.role FROM orgs o JOIN memberships m ON m.org_id = o.id
        WHERE m.user_id = ? ORDER BY m.role = 'owner' DESC, o.id LIMIT 1
      `).get(userId);
      if (!req.user || !req.org || req.org.plan === 'suspended') {
        delete req.session.userId;
        req.user = req.org = undefined;
      }
    }
    // Only the sources this organisation may see, so private portal names never leak.
    const sourceNames = Object.fromEntries(visibleSources(db, req.org?.id).map((s) => [s.key, s.name]));
    req.access = entitlement(db, req.org);
    Object.assign(res.locals, { access: req.access, promo: config.hosted ? banner(db) : null, user: req.user, org: req.org, path: req.path, sourceNames, flash: req.session.flash, version: config.version, hosted: config.hosted, supportEmail: config.supportEmail, canRegister: !req.user && ctx.registrationOpen(config) });
    delete req.session.flash;
    next();
  });

  // When a hosted trial ends or a subscription is cancelled, the organisation
  // can still sign in and look, but changes are paused until it pays. Paying,
  // the account itself and signing out keep working, and so does the admin
  // area for platform administrators.
  const ALWAYS = /^\/(logout|billing|account|verify|admin)(\/|$)/;
  app.use((req, res, next) => {
    if (!req.access?.readOnly || ['GET', 'HEAD', 'OPTIONS'].includes(req.method) || ALWAYS.test(req.path)) return next();
    if (req.is('json') || req.xhr) return res.status(402).json({ error: 'Your trial has ended. Choose a plan to make changes.' });
    ctx.flash(req, 'Your trial has ended, so changes are paused. Choose a plan to carry on where you left off.');
    res.redirect(303, '/billing');
  });

  app.get('/', (req, res) => {
    if (req.user) return res.redirect('/dashboard');
    // After deleting, the session is gone, so the confirmation rides on the address.
    if (req.query.deleted === 'org') res.locals.flash = 'Your organisation and its data have been deleted.';
    if (req.query.deleted === 'account') res.locals.flash = 'Your account has been deleted.';
    // Public figures only: private sources are not counted.
    const stats = db.prepare(`SELECT COUNT(*) AS open FROM opportunities o WHERE (o.closes_at IS NULL OR o.closes_at > ?) AND ${VISIBLE}`).get(new Date().toISOString(), -1);
    const sources = db.prepare('SELECT COUNT(*) AS n FROM sources WHERE enabled = 1 AND org_id IS NULL').get().n;
    if (config.hosted) {
      // The public marketing page. Only public sources are named.
      const names = db.prepare('SELECT name FROM sources WHERE enabled = 1 AND org_id IS NULL ORDER BY rowid').all().map((s) => s.name);
      const trialPlan = getPlan(db, getSetting(db, 'trial_plan', 'team'));
      return res.render('home', {
        stats, sources: names, canRegister: ctx.registrationOpen(config), plans: listPlans(db, { publicOnly: true }), pounds,
        trialDays: Number(getSetting(db, 'trial_days', '14')), trialPlan: trialPlan?.name || '', example: EXAMPLE_MATCH,
      });
    }
    res.render('landing', { stats, sources, canRegister: ctx.registrationOpen(config) });
  });

  // Search engines: index the public pages of a hosted service, nothing else.
  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(config.hosted
      ? `User-agent: *\nAllow: /$\nAllow: /pricing\nAllow: /terms\nAllow: /privacy\nDisallow: /\nSitemap: ${config.baseUrl}/sitemap.xml\n`
      : 'User-agent: *\nDisallow: /\n');
  });
  app.get('/sitemap.xml', (req, res) => {
    if (!config.hosted) return res.status(404).end();
    const urls = ['/', '/pricing', '/terms', '/privacy'].map((p) => `<url><loc>${config.baseUrl}${p}</loc></url>`).join('');
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
  });

  app.get('/api', ctx.requireUser, (req, res) => res.render('api-docs', { spec: openapi(), baseUrl: config.baseUrl }));

  emailRoutes(app, ctx);
  accountRoutes(app, ctx);
  opportunityRoutes(app, ctx);
  welcomeRoutes(app, ctx);
  dataRoutes(app, ctx);
  searchRoutes(app, ctx);
  adminRoutes(app, ctx);
  billingRoutes(app, ctx);

  app.use((req, res) => res.status(404).render('error', { message: 'Page not found.' }));
   
  app.use((err, req, res, next) => {
    log.error(`Unhandled error on ${req.method} ${req.path}`, err, { id: req.id });
    res.status(500).render('error', { message: 'Something went wrong. It has been logged.' });
  });
  return app;
}
