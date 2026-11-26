// Which opportunities an organisation may see. Sources with no org_id are
// shared by everyone; a source with an org_id is private to that one
// organisation, and so is everything it finds. Every query that returns
// opportunities to a customer must include VISIBLE (aliasing the
// opportunities table as o) with the organisation's id as its parameter.
export const VISIBLE = 'o.source_key IN (SELECT key FROM sources WHERE org_id IS NULL OR org_id = ?)';

export const visibleSources = (db, orgId) =>
  db.prepare('SELECT key, name FROM sources WHERE org_id IS NULL OR org_id = ? ORDER BY name').all(orgId ?? -1);

// An opportunity by id, or undefined if it does not exist or the organisation may not see it.
export const loadVisible = (db, id, orgId) =>
  db.prepare(`SELECT o.* FROM opportunities o WHERE o.id = ? AND ${VISIBLE}`).get(Number(id), orgId ?? -1);
