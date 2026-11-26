// Schema migrations, applied in order after the baseline schema.sql.
// SQLite's user_version records how many have run. Never edit a migration
// that has shipped: add a new one.
export const migrations = [
  // 1: tender platform. CPV codes, cross-source dedupe, custom and
  // authenticated sources, run history, saved searches, alerts, API tokens,
  // invites and an audit trail.
  `
  CREATE TABLE credentials (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('login', 'api-key', 'header')),
    secret TEXT NOT NULL,                 -- AES-256-GCM ciphertext, see secrets/vault.js
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  ALTER TABLE sources ADD COLUMN kind TEXT NOT NULL DEFAULT 'builtin';
  ALTER TABLE sources ADD COLUMN type TEXT NOT NULL DEFAULT 'tender';
  ALTER TABLE sources ADD COLUMN config TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE sources ADD COLUMN credential_id INTEGER REFERENCES credentials(id) ON DELETE SET NULL;
  ALTER TABLE sources ADD COLUMN interval_minutes INTEGER NOT NULL DEFAULT 360;
  ALTER TABLE sources ADD COLUMN next_run_at TEXT;
  ALTER TABLE sources ADD COLUMN last_ok_at TEXT;

  CREATE TABLE source_runs (
    id INTEGER PRIMARY KEY,
    source_key TEXT NOT NULL REFERENCES sources(key) ON DELETE CASCADE,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    duration_ms INTEGER,
    status TEXT NOT NULL DEFAULT 'running',
    found INTEGER,
    added INTEGER,
    error TEXT
  );
  CREATE INDEX idx_runs_source ON source_runs(source_key, id);

  ALTER TABLE opportunities ADD COLUMN cpv_codes TEXT NOT NULL DEFAULT '';
  ALTER TABLE opportunities ADD COLUMN country TEXT NOT NULL DEFAULT '';
  ALTER TABLE opportunities ADD COLUMN currency TEXT NOT NULL DEFAULT 'GBP';
  ALTER TABLE opportunities ADD COLUMN notice_type TEXT NOT NULL DEFAULT '';
  ALTER TABLE opportunities ADD COLUMN dedupe_key TEXT;
  ALTER TABLE opportunities ADD COLUMN duplicate_of INTEGER REFERENCES opportunities(id) ON DELETE SET NULL;
  CREATE INDEX idx_opps_dedupe ON opportunities(dedupe_key);
  CREATE INDEX idx_opps_duplicate ON opportunities(duplicate_of);

  ALTER TABLE profiles ADD COLUMN cpv_codes TEXT NOT NULL DEFAULT '';
  ALTER TABLE profiles ADD COLUMN countries TEXT NOT NULL DEFAULT '';

  ALTER TABLE org_opportunity_state ADD COLUMN stage TEXT NOT NULL DEFAULT '';
  ALTER TABLE org_opportunity_state ADD COLUMN updated_at TEXT;

  CREATE TABLE saved_searches (
    id INTEGER PRIMARY KEY,
    org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    filters TEXT NOT NULL DEFAULT '{}',   -- JSON: q, type, source, cpv, country, min_value, min_score
    frequency TEXT NOT NULL DEFAULT 'instant' CHECK (frequency IN ('instant', 'daily', 'weekly', 'off')),
    emails TEXT NOT NULL DEFAULT '',
    slack_webhook TEXT,                   -- encrypted
    webhook_url TEXT,                     -- encrypted
    last_alert_at TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Which opportunities a saved search has already alerted on.
  CREATE TABLE alert_deliveries (
    saved_search_id INTEGER NOT NULL REFERENCES saved_searches(id) ON DELETE CASCADE,
    opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
    sent_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (saved_search_id, opportunity_id)
  );

  CREATE TABLE alert_log (
    id INTEGER PRIMARY KEY,
    saved_search_id INTEGER NOT NULL REFERENCES saved_searches(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    channel TEXT NOT NULL,
    item_count INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    error TEXT
  );

  CREATE TABLE api_tokens (
    id INTEGER PRIMARY KEY,
    org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,      -- SHA-256 of the token; the token itself is shown once
    last_used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE invites (
    token_hash TEXT PRIMARY KEY,
    org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    email TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    used_at TEXT
  );

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    user_id INTEGER,
    actor TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT ''
  );
  `,
  // 2: hosted mode. When each person accepted the terms and privacy notice at sign-up.
  `
  ALTER TABLE users ADD COLUMN terms_accepted_at TEXT;
  `,
];

export function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  for (let v = current; v < migrations.length; v++) {
    db.transaction(() => {
      db.exec(migrations[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
