// What a customer can take away, and how they leave: a full export of an
// organisation's data, and deleting an account or a whole organisation.
// Deleting removes personal data; the audit log keeps what happened, with
// names and email addresses replaced.

// Everything an organisation has put into Bid Finder, as one JSON-ready object.
// Secrets (webhook addresses, portal passwords, token hashes) are left out.
export function exportOrg(db, orgId) {
  const org = db.prepare(`SELECT id, name, kind, created_at, plan_key, billing_status, billing_period, trial_ends_at FROM orgs WHERE id = ?`).get(orgId);
  const all = (sql) => db.prepare(sql).all(orgId);
  return {
    exported_at: new Date().toISOString(),
    format: 'bid-finder-export/1',
    organisation: org,
    profile: db.prepare('SELECT keywords, exclude_keywords, regions, applicant_types, types, cpv_codes, countries, min_award, max_award, min_score, digest_frequency, digest_emails, updated_at FROM profiles WHERE org_id = ?').get(orgId) || null,
    members: all(`SELECT u.name, u.email, m.role, u.created_at, u.terms_accepted_at, u.email_verified_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY u.id`),
    saved_searches: all(`SELECT name, filters, frequency, emails, last_alert_at, created_at, slack_webhook IS NOT NULL AND slack_webhook != '' AS has_slack, webhook_url IS NOT NULL AND webhook_url != '' AS has_webhook FROM saved_searches WHERE org_id = ? ORDER BY id`),
    opportunities: all(`
      SELECT o.title, o.url, o.funder AS buyer, o.closes_at, o.award_max AS value, o.currency, s.starred, s.hidden, s.note, s.stage
      FROM org_opportunity_state s JOIN opportunities o ON o.id = s.opportunity_id WHERE s.org_id = ? ORDER BY o.id`),
    digests: all('SELECT created_at, item_count, recipients, delivered FROM digests WHERE org_id = ? ORDER BY id'),
    private_sources: all('SELECT key, name, kind, type, enabled FROM sources WHERE org_id = ? ORDER BY key'),
    api_tokens: all('SELECT name, prefix, created_at, last_used_at FROM api_tokens WHERE org_id = ? ORDER BY id'),
  };
}

// Replaces a deleted person's name and email in the audit log.
function scrubAudit(db, users) {
  const byId = db.prepare(`UPDATE audit_log SET actor = '(deleted user)' WHERE user_id = ?`);
  const inDetail = db.prepare(`UPDATE audit_log SET detail = REPLACE(detail, ?, '(deleted user)') WHERE instr(detail, ?) > 0`);
  for (const u of users) {
    byId.run(u.id);
    inDetail.run(u.email, u.email);
  }
}

// Removes one person. Their organisations stay.
export function deleteUser(db, userId) {
  db.transaction(() => {
    const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(userId);
    if (!user) return;
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    scrubAudit(db, [user]);
    db.prepare(`DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?`).run(userId);
  })();
}

// Removes an organisation and everything in it: its private portals and what
// was found on them, stored logins, searches, notes, pipeline, and every member
// account that belongs to no other organisation. Returns the removed people.
export function deleteOrg(db, orgId) {
  return db.transaction(() => {
    const leaving = db.prepare(`
      SELECT u.id, u.email FROM users u JOIN memberships m ON m.user_id = u.id AND m.org_id = ?
      WHERE NOT EXISTS (SELECT 1 FROM memberships x WHERE x.user_id = u.id AND x.org_id != ?)
    `).all(orgId, orgId);
    db.prepare('DELETE FROM opportunities WHERE source_key IN (SELECT key FROM sources WHERE org_id = ?)').run(orgId);
    db.prepare('DELETE FROM sources WHERE org_id = ?').run(orgId);
    db.prepare('DELETE FROM credentials WHERE org_id = ?').run(orgId);
    db.prepare('DELETE FROM orgs WHERE id = ?').run(orgId);
    const gone = db.prepare('DELETE FROM users WHERE id = ?');
    const sessions = db.prepare(`DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?`);
    for (const u of leaving) { gone.run(u.id); sessions.run(u.id); }
    scrubAudit(db, leaving);
    return leaving;
  })();
}
