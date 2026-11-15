// Dashboard, feed, opportunity pages, pipeline, profile, digests and sharing.
import crypto from 'node:crypto';
import { config } from '../../config.js';
import { isIngestRunning } from '../../ingest/run.js';
import { STAGES, STAGE_LABELS, getFeed, getProfile, getSummary, normaliseFilters, setState } from '../../match/feed.js';
import { cpvPrefix, splitList } from '../../match/score.js';
import { presets } from '../../match/presets.js';
import { emailConfigured } from '../../notify/channels.js';
import { sendDigest } from '../../notify/digest.js';
import { localPath, validEmail } from '../context.js';

const PAGE = 50;

export function opportunityRoutes(app, ctx) {
  const { db, flash, requireUser } = ctx;

  app.get('/dashboard', requireUser, (req, res) => {
    const summary = getSummary(db, req.org.id);
    const sources = db.prepare('SELECT key, name, enabled, last_status, last_run_at, last_error FROM sources WHERE enabled = 1 ORDER BY name').all();
    const searches = db.prepare('SELECT id, name, frequency FROM saved_searches WHERE org_id = ? ORDER BY name').all(req.org.id);
    const profile = getProfile(db, req.org.id);
    const profileEmpty = !splitList(profile.keywords).length && !splitList(profile.cpv_codes).length;
    res.render('dashboard', { summary, sources, searches, profileEmpty, ingesting: isIngestRunning(), STAGES, STAGE_LABELS });
  });

  app.get('/feed', requireUser, (req, res) => {
    const filters = normaliseFilters(req.query, { sourceKeys: Object.keys(res.locals.sourceNames) });
    const page = Math.max(1, Number(req.query.page) || 1);
    const feed = getFeed(db, req.org.id, { ...filters, limit: PAGE, offset: (page - 1) * PAGE });
    const profileEmpty = !splitList(feed.profile.keywords).length && !splitList(feed.profile.cpv_codes).length;
    const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, String(v)]));
    res.render('feed', { ...feed, filters, profileEmpty, ingesting: isIngestRunning(), page, pages: Math.max(1, Math.ceil(feed.total / PAGE)), query: query.toString() });
  });

  app.get('/pipeline', requireUser, (req, res) => {
    const { items } = getFeed(db, req.org.id, { view: 'pipeline', limit: 1000 });
    res.render('pipeline', { columns: STAGES.map((stage) => ({ stage, label: STAGE_LABELS[stage], items: items.filter((o) => o.stage === stage) })) });
  });

  app.get('/o/:id', requireUser, (req, res) => {
    const opp = ctx.loadOpportunity(req.params.id);
    if (!opp) return res.status(404).render('error', { message: 'Opportunity not found.' });
    const full = ctx.withMatch(opp, req.org.id);
    const also = opp.dedupe_key
      ? db.prepare('SELECT id, source_key, url FROM opportunities WHERE dedupe_key = ? AND id != ? ORDER BY id').all(opp.dedupe_key, opp.id)
      : [];
    res.render('opportunity', { opp: full, state: full, match: full.match, also, STAGES, STAGE_LABELS });
  });

  app.post('/o/:id/state', requireUser, (req, res) => {
    const opp = ctx.loadOpportunity(req.params.id);
    if (!opp) return res.status(404).json({ error: 'not found' });
    const changes = {};
    for (const key of ['starred', 'hidden']) if (key in req.body) changes[key] = ['1', 'true', true, 1].includes(req.body[key]) ? 1 : 0;
    if (typeof req.body.note === 'string') changes.note = req.body.note.slice(0, 5000);
    if (typeof req.body.stage === 'string' && (req.body.stage === '' || STAGES.includes(req.body.stage))) changes.stage = req.body.stage;
    setState(db, req.org.id, opp.id, changes);
    if (req.is('json')) return res.json({ ok: true, ...changes });
    res.redirect(localPath(req.body.back, `/o/${opp.id}`));
  });

  // --- Profile ---------------------------------------------------------------

  app.get('/profile', requireUser, (req, res) => {
    res.render('profile', { profile: getProfile(db, req.org.id), error: null, presets });
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
      UPDATE profiles SET keywords = ?, exclude_keywords = ?, regions = ?, applicant_types = ?, types = ?, cpv_codes = ?, countries = ?,
        min_award = ?, max_award = ?, min_score = ?, digest_frequency = ?, digest_emails = ?, updated_at = datetime('now')
      WHERE org_id = ?
    `).run(
      list(b.keywords), list(b.exclude_keywords), list(b.regions), list(b.applicant_types), (types.length ? types : ['tender']).join('\n'),
      splitList(b.cpv_codes).map(cpvPrefix).filter((p) => /^\d{2,8}$/.test(p)).join('\n'),
      splitList(b.countries).map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)).join('\n'),
      money(b.min_award), money(b.max_award), Math.min(100, Math.max(0, Number(b.min_score) || 0)),
      ['daily', 'weekly', 'off'].includes(b.digest_frequency) ? b.digest_frequency : 'daily',
      list(b.digest_emails).split('\n').filter(validEmail).join('\n'),
      req.org.id,
    );
    if (b.org_name?.trim() && req.org.role === 'owner') db.prepare('UPDATE orgs SET name = ? WHERE id = ?').run(b.org_name.trim().slice(0, 200), req.org.id);
    flash(req, 'Profile saved. Your feed has been re-ranked.');
    res.redirect('/feed');
  });

  // --- Digests and sharing -------------------------------------------------

  app.get('/digests', requireUser, (req, res) => {
    const digests = db.prepare('SELECT id, created_at, item_count, recipients, delivered FROM digests WHERE org_id = ? ORDER BY id DESC LIMIT 50').all(req.org.id);
    res.render('digests', { digests, smtp: emailConfigured() });
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

  // An organisation can publish its shortlist as a read-only page to share
  // with colleagues or partners, without them needing an account.
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
    res.render('shared', { sharedOrg: org, items, baseUrl: config.baseUrl });
  });
}
