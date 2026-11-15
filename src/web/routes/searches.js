// Saved searches and their alerts.
import { getFeed, normaliseFilters } from '../../match/feed.js';
import { splitList } from '../../match/score.js';
import { baseline, deliver, parseFilters, searchResults } from '../../notify/alerts.js';
import { emailConfigured } from '../../notify/channels.js';
import { assertPublicUrl } from '../../http/ssrf.js';
import { encrypt } from '../../secrets/vault.js';
import { validEmail } from '../context.js';

export function searchRoutes(app, ctx) {
  const { db, flash, requireUser, audit } = ctx;
  const load = (req) => db.prepare('SELECT * FROM saved_searches WHERE id = ? AND org_id = ?').get(Number(req.params.id), req.org.id);
  const notFound = (res) => res.status(404).render('error', { message: 'Saved search not found.' });

  app.get('/searches', requireUser, (req, res) => {
    const searches = db.prepare('SELECT * FROM saved_searches WHERE org_id = ? ORDER BY name').all(req.org.id).map((s) => ({
      ...s, filters: parseFilters(s), count: searchResults(db, s).total, hasSlack: Boolean(s.slack_webhook), hasWebhook: Boolean(s.webhook_url),
    }));
    res.render('searches', { searches, smtp: emailConfigured() });
  });

  const form = (req, res, search, { status = 200, error = null } = {}) =>
    res.status(status).render('search-form', { search, error, smtp: emailConfigured(), defaultEmail: req.user.email });

  app.get('/searches/new', requireUser, (req, res) => {
    const filters = normaliseFilters(req.query, { sourceKeys: Object.keys(res.locals.sourceNames) });
    form(req, res, { id: null, name: '', filters, frequency: 'instant', emails: req.user.email, hasSlack: false, hasWebhook: false });
  });

  app.get('/searches/:id/edit', requireUser, (req, res) => {
    const s = load(req);
    if (!s) return notFound(res);
    form(req, res, { ...s, filters: parseFilters(s), hasSlack: Boolean(s.slack_webhook), hasWebhook: Boolean(s.webhook_url) });
  });

  async function save(req, res) {
    const existing = req.params.id ? load(req) : null;
    if (req.params.id && !existing) return notFound(res);
    const b = req.body;
    const { view, sort, ...filters } = normaliseFilters(b, { sourceKeys: Object.keys(res.locals.sourceNames) });
    const draft = {
      id: existing?.id ?? null,
      name: (b.name || '').trim().slice(0, 120),
      filters,
      frequency: ['instant', 'daily', 'weekly', 'off'].includes(b.frequency) ? b.frequency : 'instant',
      emails: splitList(b.emails).filter(validEmail).join('\n'),
      hasSlack: Boolean(existing?.slack_webhook), hasWebhook: Boolean(existing?.webhook_url),
    };
    // Secret fields are write-only: empty keeps what is stored, "-" clears it.
    const secret = async (value, stored, check) => {
      const v = (value || '').trim();
      if (!v) return stored ?? null;
      if (v === '-') return null;
      await check(v);
      return encrypt(v);
    };
    let slack; let hook;
    try {
      if (!draft.name) throw new Error('Give the search a name.');
      slack = await secret(b.slack_webhook, existing?.slack_webhook, (v) => { if (!/^https:\/\/hooks\.slack(-gov)?\.com\//.test(v)) throw new Error('Slack webhook URLs start with https://hooks.slack.com/'); });
      hook = await secret(b.webhook_url, existing?.webhook_url, (v) => assertPublicUrl(v));
    } catch (err) {
      return form(req, res, draft, { status: 400, error: err.message });
    }
    const values = [draft.name, JSON.stringify(filters), draft.frequency, draft.emails, slack, hook];
    let id = existing?.id;
    if (existing) {
      db.prepare('UPDATE saved_searches SET name = ?, filters = ?, frequency = ?, emails = ?, slack_webhook = ?, webhook_url = ? WHERE id = ?').run(...values, id);
    } else {
      id = db.prepare('INSERT INTO saved_searches (name, filters, frequency, emails, slack_webhook, webhook_url, org_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(...values, req.org.id, req.user.id).lastInsertRowid;
      baseline(db, db.prepare('SELECT * FROM saved_searches WHERE id = ?').get(id));
    }
    audit(req, existing ? 'search.updated' : 'search.created', draft.name);
    flash(req, existing ? 'Search saved.' : 'Search saved. You will be alerted about new matches from now on.');
    res.redirect(`/searches/${id}`);
  }
  app.post('/searches', requireUser, save);
  app.post('/searches/:id', requireUser, save);

  app.get('/searches/:id', requireUser, (req, res) => {
    const s = load(req);
    if (!s) return notFound(res);
    const filters = parseFilters(s);
    const feed = getFeed(db, req.org.id, { ...filters, view: 'matches', limit: 100 });
    const log = db.prepare('SELECT * FROM alert_log WHERE saved_search_id = ? ORDER BY id DESC LIMIT 10').all(s.id);
    res.render('search', { search: { ...s, filters, hasSlack: Boolean(s.slack_webhook), hasWebhook: Boolean(s.webhook_url) }, ...feed, log });
  });

  // Sends the current top matches to every channel, to prove the wiring works.
  app.post('/searches/:id/test', requireUser, async (req, res) => {
    const s = load(req);
    if (!s) return notFound(res);
    const items = searchResults(db, s).items.slice(0, 5);
    if (!items.length) flash(req, 'Nothing matches this search yet, so there is nothing to send.');
    else {
      const results = await deliver(db, s, items);
      const parts = Object.entries(results).map(([channel, ok]) => `${channel} ${ok ? 'sent' : 'failed'}`);
      flash(req, parts.length ? `Test alert: ${parts.join(', ')}.` : 'No channel is set up for this search. Add an email address (with SMTP configured), a Slack webhook or a webhook URL.');
    }
    res.redirect(`/searches/${s.id}`);
  });

  app.post('/searches/:id/delete', requireUser, (req, res) => {
    const s = load(req);
    if (s) {
      db.prepare('DELETE FROM saved_searches WHERE id = ?').run(s.id);
      audit(req, 'search.deleted', s.name);
      flash(req, 'Search deleted.');
    }
    res.redirect('/searches');
  });
}
