// JSON API, version 1. Authenticated with a bearer token created on the
// Account page; a token acts as its user within their organisation.
// Mounted before sessions and CSRF, so it never sets cookies.
import express from 'express';
import { config } from '../config.js';
import { connectorForSource } from '../connectors/index.js';
import { isIngestRunning, runAll } from '../ingest/run.js';
import { STAGES, getFeed, normaliseFilters, setState } from '../match/feed.js';
import { visibleSources } from '../match/visibility.js';
import { parseFilters, runAlerts, searchResults } from '../notify/alerts.js';
import { log } from '../log.js';
import { sha256 } from './context.js';
import { openapi } from './openapi.js';

const LIMIT_PER_MINUTE = 120;
const windows = new Map(); // token id -> { start, count }

export function serialise(o) {
  return {
    id: o.id,
    source: o.source_key,
    type: o.type,
    title: o.title,
    summary: o.summary,
    buyer: o.funder,
    url: o.url,
    app_url: `${config.baseUrl}/o/${o.id}`,
    location: o.location,
    country: o.country,
    cpv_codes: (o.cpv_codes || '').split(' ').filter(Boolean),
    value: o.award_max,
    value_min: o.award_min,
    currency: o.currency,
    notice_type: o.notice_type,
    published_at: o.published_at,
    opens_at: o.opens_at,
    closes_at: o.closes_at,
    first_seen_at: o.first_seen_at,
    score: o.match?.score ?? null,
    reasons: o.match?.reasons ?? [],
    starred: Boolean(o.starred),
    hidden: Boolean(o.hidden),
    stage: o.stage || null,
    note: o.note || '',
  };
}

export function apiRouter(ctx) {
  const { db } = ctx;
  const api = express.Router();
  api.use(express.json({ limit: '100kb' }));
  const fail = (res, status, message) => res.status(status).json({ error: message });

  api.get('/openapi.json', (req, res) => res.json(openapi()));

  api.use((req, res, next) => {
    const token = (req.get('authorization') || '').match(/^Bearer\s+(\S+)$/i)?.[1];
    const row = token && db.prepare(`
      SELECT t.id, t.org_id, u.id AS user_id, u.email, u.is_platform_admin FROM api_tokens t
      JOIN users u ON u.id = t.user_id JOIN memberships m ON m.user_id = u.id AND m.org_id = t.org_id
      WHERE t.token_hash = ?
    `).get(sha256(token));
    if (!row) return fail(res.set('WWW-Authenticate', 'Bearer'), 401, 'Send a valid API token as "Authorization: Bearer <token>".');
    const now = Date.now();
    const w = windows.get(row.id);
    if (!w || now - w.start > 60e3) windows.set(row.id, { start: now, count: 1 });
    else if (++w.count > LIMIT_PER_MINUTE) return fail(res.set('Retry-After', '60'), 429, 'Rate limit exceeded: 120 requests a minute.');
    db.prepare(`UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?`).run(row.id);
    req.api = row;
    next();
  });

  const sourceKeys = (orgId) => visibleSources(db, orgId).map((s) => s.key);

  api.get('/opportunities', (req, res) => {
    const filters = normaliseFilters(req.query, { sourceKeys: sourceKeys(req.api.org_id) });
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const since = /^\d{4}-\d{2}-\d{2}/.test(req.query.since || '') ? new Date(req.query.since).toISOString().replace('T', ' ').slice(0, 19) : null;
    const feed = getFeed(db, req.api.org_id, { ...filters, since, limit, offset });
    res.json({ total: feed.total, limit, offset, items: feed.items.map(serialise) });
  });

  api.get('/opportunities/:id', (req, res) => {
    const opp = ctx.loadOpportunity(req.params.id, req.api.org_id);
    if (!opp) return fail(res, 404, 'Opportunity not found.');
    res.json(serialise(ctx.withMatch(opp, req.api.org_id)));
  });

  api.patch('/opportunities/:id', (req, res) => {
    const opp = ctx.loadOpportunity(req.params.id, req.api.org_id);
    if (!opp) return fail(res, 404, 'Opportunity not found.');
    const b = req.body || {};
    const changes = {};
    for (const key of ['starred', 'hidden']) if (typeof b[key] === 'boolean') changes[key] = b[key] ? 1 : 0;
    if (typeof b.note === 'string') changes.note = b.note.slice(0, 5000);
    if (b.stage === null || b.stage === '') changes.stage = '';
    else if (b.stage !== undefined) {
      if (!STAGES.includes(b.stage)) return fail(res, 400, `stage must be one of: ${STAGES.join(', ')}, or null.`);
      changes.stage = b.stage;
    }
    setState(db, req.api.org_id, opp.id, changes);
    res.json(serialise(ctx.withMatch(opp, req.api.org_id)));
  });

  api.get('/saved-searches', (req, res) => {
    const rows = db.prepare('SELECT * FROM saved_searches WHERE org_id = ? ORDER BY name').all(req.api.org_id);
    res.json({ items: rows.map((s) => ({ id: s.id, name: s.name, filters: parseFilters(s), frequency: s.frequency, last_alert_at: s.last_alert_at })) });
  });

  api.get('/saved-searches/:id/results', (req, res) => {
    const s = db.prepare('SELECT * FROM saved_searches WHERE id = ? AND org_id = ?').get(Number(req.params.id), req.api.org_id);
    if (!s) return fail(res, 404, 'Saved search not found.');
    const feed = searchResults(db, s, { limit: Math.min(200, Math.max(1, Number(req.query.limit) || 50)) });
    res.json({ total: feed.total, items: feed.items.map(serialise) });
  });

  api.get('/sources', (req, res) => {
    const now = new Date().toISOString();
    const rows = db.prepare(`
      SELECT s.*, (SELECT COUNT(*) FROM opportunities o WHERE o.source_key = s.key AND (o.closes_at IS NULL OR o.closes_at > ?)) AS open_count FROM sources s
      WHERE s.org_id IS NULL OR s.org_id = ? ORDER BY s.name
    `).all(now, req.api.org_id);
    res.json({ running: isIngestRunning(), items: rows.map((s) => ({
      key: s.key, name: s.name, kind: s.kind, type: s.type, enabled: Boolean(s.enabled), access: connectorForSource(s)?.access || null,
      interval_minutes: s.interval_minutes, last_run_at: s.last_run_at, last_status: s.last_status, last_error: s.last_error,
      last_found: s.last_found, last_new: s.last_new, next_run_at: s.next_run_at, open_count: s.open_count,
    })) });
  });

  api.post('/sources/:key/run', (req, res) => {
    if (!req.api.is_platform_admin) return fail(res, 403, 'Only a platform administrator\'s token can start a run.');
    if (!db.prepare('SELECT 1 FROM sources WHERE key = ?').get(req.params.key)) return fail(res, 404, 'Source not found.');
    if (isIngestRunning()) return fail(res, 409, 'A run is already in progress.');
    runAll(db, { only: req.params.key }).then((r) => r.length && runAlerts(db)).catch((err) => log.error('API-triggered run failed', err));
    res.status(202).json({ started: true });
  });

  api.use((req, res) => fail(res, 404, 'No such endpoint. See /api/v1/openapi.json.'));
   
  api.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return fail(res, 400, 'Request body is not valid JSON.');
    log.error('API error', err);
    fail(res, 500, 'Something went wrong. It has been logged.');
  });
  return api;
}
