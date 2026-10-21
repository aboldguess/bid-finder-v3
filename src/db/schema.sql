-- Organisations are the tenant boundary: a company or a business-support hub.
CREATE TABLE IF NOT EXISTS orgs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'company' CHECK (kind IN ('company', 'hub')),
  plan TEXT NOT NULL DEFAULT 'trial' CHECK (plan IN ('trial', 'solo', 'hub', 'suspended')),
  share_token TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_platform_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  PRIMARY KEY (user_id, org_id)
);

-- What an organisation is looking for. List fields are newline-separated.
CREATE TABLE IF NOT EXISTS profiles (
  org_id INTEGER PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  keywords TEXT NOT NULL DEFAULT '',
  exclude_keywords TEXT NOT NULL DEFAULT '',
  regions TEXT NOT NULL DEFAULT '',
  applicant_types TEXT NOT NULL DEFAULT '',
  types TEXT NOT NULL DEFAULT 'grant',
  min_award REAL,
  max_award REAL,
  min_score INTEGER NOT NULL DEFAULT 30,
  digest_frequency TEXT NOT NULL DEFAULT 'daily' CHECK (digest_frequency IN ('daily', 'weekly', 'off')),
  digest_emails TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sources (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  last_status TEXT,
  last_error TEXT,
  last_found INTEGER,
  last_new INTEGER
);

-- One row per opportunity per source, deduplicated on (source_key, external_id).
CREATE TABLE IF NOT EXISTS opportunities (
  id INTEGER PRIMARY KEY,
  source_key TEXT NOT NULL REFERENCES sources(key),
  external_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('grant', 'tender')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  funder TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  eligibility TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  award_min REAL,
  award_max REAL,
  total_fund REAL,
  award_text TEXT NOT NULL DEFAULT '',
  opens_at TEXT,
  closes_at TEXT,
  published_at TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source_key, external_id)
);
CREATE INDEX IF NOT EXISTS idx_opps_closes ON opportunities(closes_at);
CREATE INDEX IF NOT EXISTS idx_opps_first_seen ON opportunities(first_seen_at);

CREATE VIRTUAL TABLE IF NOT EXISTS opportunities_fts USING fts5(
  title, summary, funder, eligibility,
  content='opportunities', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS opps_ai AFTER INSERT ON opportunities BEGIN
  INSERT INTO opportunities_fts(rowid, title, summary, funder, eligibility)
  VALUES (new.id, new.title, new.summary, new.funder, new.eligibility);
END;
CREATE TRIGGER IF NOT EXISTS opps_ad AFTER DELETE ON opportunities BEGIN
  INSERT INTO opportunities_fts(opportunities_fts, rowid, title, summary, funder, eligibility)
  VALUES ('delete', old.id, old.title, old.summary, old.funder, old.eligibility);
END;
CREATE TRIGGER IF NOT EXISTS opps_au AFTER UPDATE ON opportunities BEGIN
  INSERT INTO opportunities_fts(opportunities_fts, rowid, title, summary, funder, eligibility)
  VALUES ('delete', old.id, old.title, old.summary, old.funder, old.eligibility);
  INSERT INTO opportunities_fts(rowid, title, summary, funder, eligibility)
  VALUES (new.id, new.title, new.summary, new.funder, new.eligibility);
END;

-- Per-organisation triage state.
CREATE TABLE IF NOT EXISTS org_opportunity_state (
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  starred INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (org_id, opportunity_id)
);

CREATE TABLE IF NOT EXISTS digests (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  item_count INTEGER NOT NULL,
  recipients TEXT NOT NULL DEFAULT '',
  delivered INTEGER NOT NULL DEFAULT 0,
  html TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires INTEGER NOT NULL
);
