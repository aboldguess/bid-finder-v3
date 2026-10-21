// Builds an organisation's ranked feed: open opportunities scored against
// its profile, merged with its starred/hidden state.
import { scoreOpportunity } from './score.js';

// Turns user search text into a safe FTS5 query: each word quoted, ANDed.
export function ftsQuery(text) {
  const words = (text || '').match(/[\p{L}\p{N}]+/gu) || [];
  return words.map((w) => `"${w}"*`).join(' ');
}

export function getProfile(db, orgId) {
  return db.prepare('SELECT * FROM profiles WHERE org_id = ?').get(orgId) || { types: 'grant', min_score: 30 };
}

export function getFeed(db, orgId, { q = '', type = '', source = '', view = 'matches', since = null, limit = 200, now = Date.now() } = {}) {
  const profile = getProfile(db, orgId);
  const where = ['(o.closes_at IS NULL OR o.closes_at > ?)'];
  const params = [orgId, new Date(now).toISOString()];
  const fts = ftsQuery(q);
  if (fts) {
    where.push('o.id IN (SELECT rowid FROM opportunities_fts WHERE opportunities_fts MATCH ?)');
    params.push(fts);
  }
  if (type) { where.push('o.type = ?'); params.push(type); }
  if (source) { where.push('o.source_key = ?'); params.push(source); }
  if (since) { where.push('o.first_seen_at > ?'); params.push(since); }
  if (view === 'starred') where.push('s.starred = 1');
  else if (view === 'hidden') where.push('s.hidden = 1');
  else where.push('COALESCE(s.hidden, 0) = 0');

  const rows = db.prepare(`
    SELECT o.*, COALESCE(s.starred, 0) AS starred, COALESCE(s.hidden, 0) AS hidden, COALESCE(s.note, '') AS note
    FROM opportunities o
    LEFT JOIN org_opportunity_state s ON s.opportunity_id = o.id AND s.org_id = ?
    WHERE ${where.join(' AND ')}
  `).all(...params);

  const scored = rows.map((o) => ({ ...o, match: scoreOpportunity(o, profile, now) }));
  const filtered = view === 'matches'
    ? scored.filter((o) => !o.match.excluded && (o.match.score >= profile.min_score || o.starred))
    : scored;
  filtered.sort((a, b) => b.match.score - a.match.score || (a.closes_at || '9999').localeCompare(b.closes_at || '9999'));
  return { profile, total: filtered.length, items: filtered.slice(0, limit) };
}

export function setState(db, orgId, oppId, changes) {
  db.prepare('INSERT INTO org_opportunity_state (org_id, opportunity_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(orgId, oppId);
  for (const [col, value] of Object.entries(changes)) {
    if (!['starred', 'hidden', 'note'].includes(col)) continue;
    db.prepare(`UPDATE org_opportunity_state SET ${col} = ? WHERE org_id = ? AND opportunity_id = ?`).run(value, orgId, oppId);
  }
}
