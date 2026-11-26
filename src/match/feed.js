// Builds an organisation's ranked feed: open opportunities scored against
// its profile, merged with its triage state (shortlist, hidden, pipeline).
import { cpvMatch, cpvPrefix, scoreOpportunity, splitList } from './score.js';
import { VISIBLE } from './visibility.js';

export const STAGES = ['qualifying', 'bidding', 'submitted', 'won', 'lost', 'no-bid'];
export const STAGE_LABELS = { qualifying: 'Qualifying', bidding: 'Bidding', submitted: 'Submitted', won: 'Won', lost: 'Lost', 'no-bid': 'No bid' };

// Turns user search text into a safe FTS5 query: each word quoted, ANDed.
export function ftsQuery(text) {
  const words = (text || '').match(/[\p{L}\p{N}]+/gu) || [];
  return words.map((w) => `"${w}"*`).join(' ');
}

const DEFAULT_PROFILE = { types: 'grant\ntender', min_score: 30 };
export function getProfile(db, orgId) {
  return db.prepare('SELECT * FROM profiles WHERE org_id = ?').get(orgId) || { ...DEFAULT_PROFILE };
}

// Cleans filters from a query string, a saved search or the API into one shape.
export function normaliseFilters(input = {}, { sourceKeys } = {}) {
  const num = (v) => { const n = Number(String(v ?? '').replace(/[£$€,\s]/g, '')); return v !== '' && v != null && Number.isFinite(n) && n >= 0 ? n : null; };
  return {
    q: String(input.q || '').slice(0, 200).trim(),
    type: ['grant', 'tender'].includes(input.type) ? input.type : '',
    source: input.source && (!sourceKeys || sourceKeys.includes(input.source)) ? String(input.source) : '',
    cpv: splitList(String(input.cpv || '')).map(cpvPrefix).filter((p) => /^\d{2,8}$/.test(p)).join(', '),
    country: /^[A-Za-z]{2}$/.test(input.country || '') ? input.country.toUpperCase() : '',
    min_value: num(input.min_value),
    min_score: num(input.min_score) == null ? null : Math.min(100, num(input.min_score)),
    view: ['matches', 'all', 'starred', 'hidden', 'pipeline'].includes(input.view) ? input.view : 'matches',
    sort: ['score', 'deadline', 'newest', 'value'].includes(input.sort) ? input.sort : 'score',
  };
}

const SORTS = {
  score: (a, b) => b.match.score - a.match.score || (a.closes_at || '9999').localeCompare(b.closes_at || '9999'),
  deadline: (a, b) => (a.closes_at || '9999').localeCompare(b.closes_at || '9999') || b.match.score - a.match.score,
  newest: (a, b) => b.first_seen_at.localeCompare(a.first_seen_at) || b.match.score - a.match.score,
  value: (a, b) => (b.award_max ?? -1) - (a.award_max ?? -1) || b.match.score - a.match.score,
};

export function getFeed(db, orgId, {
  q = '', type = '', source = '', view = 'matches', cpv = '', country = '', min_value = null, min_score = null,
  sort = 'score', since = null, closingWithinDays = null, limit = 200, offset = 0, now = Date.now(), profile: draft = null,
} = {}) {
  // `profile` scores against a draft that is not saved yet (the welcome page's preview).
  const profile = draft || getProfile(db, orgId);
  // The pipeline keeps bids that have closed (submitted, won, lost); other views show open ones.
  const where = view === 'pipeline' ? [] : ['(o.closes_at IS NULL OR o.closes_at > ?)'];
  const params = view === 'pipeline' ? [orgId] : [orgId, new Date(now).toISOString()];
  const fts = ftsQuery(q);
  // Alerts (with `since`) look at a handful of new rows: test each against
  // the full-text index afterwards rather than listing every match first.
  const ftsEach = Boolean(fts && since);
  if (fts && !ftsEach) {
    where.push('o.id IN (SELECT rowid FROM opportunities_fts WHERE opportunities_fts MATCH ?)');
    params.push(fts);
  }
  if (type) { where.push('o.type = ?'); params.push(type); }
  if (source) { where.push('o.source_key = ?'); params.push(source); }
  if (since) { where.push('o.first_seen_at > ?'); params.push(since); }
  if (country) { where.push('o.country = ?'); params.push(country); }
  if (min_value != null) { where.push('o.award_max >= ?'); params.push(min_value); }
  if (closingWithinDays != null) { where.push('o.closes_at <= ?'); params.push(new Date(now + closingWithinDays * 864e5).toISOString()); }
  if (view === 'starred') where.push('s.starred = 1');
  else if (view === 'hidden') where.push('s.hidden = 1');
  else if (view === 'pipeline') where.push(`s.stage != ''`);
  else where.push('COALESCE(s.hidden, 0) = 0');
  // Copies of a notice on other portals are folded into the first one seen.
  // With `since`, the first-seen index is far more selective; the unary + stops SQLite choosing the duplicate index instead.
  if (view === 'matches' || view === 'all') where.push(since ? '+o.duplicate_of IS NULL' : 'o.duplicate_of IS NULL');
  // Never another organisation's private sources.
  where.push(VISIBLE);
  params.push(orgId);

  const rows = db.prepare(`
    SELECT o.*, COALESCE(s.starred, 0) AS starred, COALESCE(s.hidden, 0) AS hidden, COALESCE(s.note, '') AS note, COALESCE(s.stage, '') AS stage
    FROM opportunities o
    LEFT JOIN org_opportunity_state s ON s.opportunity_id = o.id AND s.org_id = ?
    WHERE ${where.join(' AND ')}
  `).all(...params);

  const prefixes = splitList(cpv).map(cpvPrefix);
  const threshold = min_score ?? profile.min_score;
  let candidates = rows;
  if (ftsEach && rows.length) {
    // New rows have the newest ids, and the full-text index can start from an id cheaply.
    // A loop, not Math.min(...ids): a long outage can leave more rows than a call can take as arguments.
    let minId = Infinity;
    for (const o of rows) if (o.id < minId) minId = o.id;
    const hits = new Set(db.prepare('SELECT rowid FROM opportunities_fts WHERE opportunities_fts MATCH ? AND rowid >= ?').all(fts, minId).map((r) => r.rowid));
    candidates = rows.filter((o) => hits.has(o.id));
  }
  let scored = candidates.map((o) => ({ ...o, match: scoreOpportunity(o, profile, now) }));
  if (prefixes.length) scored = scored.filter((o) => cpvMatch(o.cpv_codes, prefixes));
  if (view === 'matches') scored = scored.filter((o) => !o.match.excluded && (o.match.score >= threshold || o.starred));
  scored.sort(SORTS[sort] || SORTS.score);
  return { profile, total: scored.length, items: scored.slice(offset, offset + limit) };
}

export function setState(db, orgId, oppId, changes) {
  db.prepare('INSERT INTO org_opportunity_state (org_id, opportunity_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(orgId, oppId);
  for (const [col, value] of Object.entries(changes)) {
    if (!['starred', 'hidden', 'note', 'stage'].includes(col)) continue;
    if (col === 'stage' && value !== '' && !STAGES.includes(value)) continue;
    db.prepare(`UPDATE org_opportunity_state SET ${col} = ?, updated_at = datetime('now') WHERE org_id = ? AND opportunity_id = ?`).run(value, orgId, oppId);
  }
}

// Numbers for the dashboard.
export function getSummary(db, orgId, { now = Date.now() } = {}) {
  const { items } = getFeed(db, orgId, { limit: 100000, now });
  const dayAgo = new Date(now - 864e5).toISOString().replace('T', ' ').slice(0, 19);
  const weekAgo = new Date(now - 7 * 864e5).toISOString().replace('T', ' ').slice(0, 19);
  const soon = new Date(now + 7 * 864e5).toISOString();
  const stages = Object.fromEntries(db.prepare(`SELECT stage, COUNT(*) AS n FROM org_opportunity_state WHERE org_id = ? AND stage != '' GROUP BY stage`).all(orgId).map((r) => [r.stage, r.n]));
  return {
    matches: items.length,
    new24h: items.filter((o) => o.first_seen_at > dayAgo).length,
    new7d: items.filter((o) => o.first_seen_at > weekAgo).length,
    closingSoon: items.filter((o) => o.closes_at && o.closes_at <= soon).sort((a, b) => a.closes_at.localeCompare(b.closes_at)).slice(0, 6),
    closingSoonCount: items.filter((o) => o.closes_at && o.closes_at <= soon).length,
    newest: items.filter((o) => o.first_seen_at > weekAgo).slice(0, 6),
    shortlisted: items.filter((o) => o.starred).length,
    pipelineValue: db.prepare(`SELECT COALESCE(SUM(o.award_max), 0) AS v FROM org_opportunity_state s JOIN opportunities o ON o.id = s.opportunity_id WHERE s.org_id = ? AND s.stage IN ('qualifying', 'bidding', 'submitted') AND ${VISIBLE}`).get(orgId, orgId).v,
    stages,
  };
}
