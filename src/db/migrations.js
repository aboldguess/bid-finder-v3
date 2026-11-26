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
  // 3: email verification and password reset. Accounts that already exist
  // count as verified, so upgrading changes nothing for them.
  `
  ALTER TABLE users ADD COLUMN email_verified_at TEXT;
  UPDATE users SET email_verified_at = created_at;

  -- Single-use links sent by email. Only a hash of the token is kept.
  CREATE TABLE email_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
    email TEXT NOT NULL,                  -- the address it was sent to; a later email change voids it
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    used_at TEXT
  );
  CREATE INDEX idx_email_tokens_user ON email_tokens(user_id, purpose);
  `,
  // 4: private sources. A source or credential with an org_id belongs to
  // that one organisation; NULL means shared with everyone, as before. There
  // is deliberately no ON DELETE action: an organisation that still owns a
  // source cannot be deleted by accident, which would otherwise risk its
  // private results becoming visible to all.
  `
  ALTER TABLE sources ADD COLUMN org_id INTEGER REFERENCES orgs(id);
  ALTER TABLE credentials ADD COLUMN org_id INTEGER REFERENCES orgs(id);
  CREATE INDEX idx_sources_org ON sources(org_id);
  `,
  // 5: plans and trials for hosted mode. Prices and limits are edited by
  // platform administrators; these rows are only the starting point.
  // Existing organisations are 'comped' (free, unlimited), so upgrading
  // changes nothing for them.
  `
  CREATE TABLE plans (
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    tagline TEXT NOT NULL DEFAULT '',
    monthly_pence INTEGER NOT NULL,
    annual_pence INTEGER NOT NULL,
    sale_monthly_pence INTEGER,           -- a sale price replaces the normal one while the sale runs
    sale_annual_pence INTEGER,
    sale_label TEXT NOT NULL DEFAULT '',  -- e.g. "Black Friday"
    sale_ends_at TEXT,                    -- no end date: runs until removed
    badge TEXT NOT NULL DEFAULT '',       -- e.g. "Most popular"
    colour TEXT NOT NULL DEFAULT '#1565d8',
    seats INTEGER,                        -- NULL means unlimited
    saved_searches INTEGER,
    instant_alerts INTEGER NOT NULL DEFAULT 1,
    private_sources INTEGER NOT NULL DEFAULT 0,
    features TEXT NOT NULL DEFAULT '',    -- one selling point per line
    sort INTEGER NOT NULL DEFAULT 0,
    public INTEGER NOT NULL DEFAULT 1,    -- shown on the pricing page
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO plans (key, name, tagline, monthly_pence, annual_pence, badge, colour, seats, saved_searches, instant_alerts, private_sources, features, sort) VALUES
    ('starter', 'Starter', 'For a sole trader or a small firm bidding now and then.', 2900, 29000, '', '#3b7d5a', 1, 3, 0, 0,
      'Every public UK and international source
Fit scores with the reasons
3 saved searches with daily or weekly alerts
Daily digest email', 1),
    ('team', 'Team', 'For a firm that bids every month and works as a team.', 7900, 79000, 'Most popular', '#1565d8', 5, 20, 1, 0,
      'Everything in Starter
5 team members
20 saved searches with instant alerts
Slack and webhook alerts
Bid pipeline and shared shortlists
API access', 2),
    ('pro', 'Pro', 'For bid teams that want everything, including private portals.', 19900, 199000, 'Best value', '#7a3fc2', 15, NULL, 1, 3,
      'Everything in Team
15 team members
Unlimited saved searches
Up to 3 private portals watched for you
Priority support', 3);

  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO settings (key, value) VALUES ('trial_days', '14'), ('trial_plan', 'team'),
    ('banner_text', ''), ('banner_colour', '#c62828'), ('banner_ends_at', '');

  ALTER TABLE orgs ADD COLUMN plan_key TEXT REFERENCES plans(key);
  ALTER TABLE orgs ADD COLUMN trial_ends_at TEXT;
  ALTER TABLE orgs ADD COLUMN billing_status TEXT NOT NULL DEFAULT 'trialing';
  UPDATE orgs SET billing_status = 'comped';
  `,
  // 6: Stripe. Which customer and subscription belong to each organisation,
  // and which webhook events have been handled (Stripe can send one twice).
  `
  ALTER TABLE orgs ADD COLUMN stripe_customer_id TEXT;
  ALTER TABLE orgs ADD COLUMN stripe_subscription_id TEXT;
  ALTER TABLE orgs ADD COLUMN billing_period TEXT;
  CREATE UNIQUE INDEX idx_orgs_stripe_customer ON orgs(stripe_customer_id);
  CREATE TABLE stripe_events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  // 7: incremental alerts. When each saved search last looked for new
  // matches, so the next check only scores what has arrived since.
  `
  ALTER TABLE saved_searches ADD COLUMN checked_at TEXT;
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
