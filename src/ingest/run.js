// Pulls opportunities from connectors into the database. Sources run one
// after another so a small server is never hammering several sites at once.
import { connectors, connectorForSource } from '../connectors/index.js';
import { createHttp } from '../http/client.js';
import { loadCredential } from '../secrets/vault.js';
import { config } from '../config.js';
import { log } from '../log.js';

const TEXT = ['title', 'summary', 'url', 'funder', 'location', 'eligibility', 'status', 'award_text', 'cpv_codes', 'country', 'notice_type'];
const NULLABLE = ['award_min', 'award_max', 'total_fund', 'opens_at', 'closes_at', 'published_at'];
const FIELDS = [...TEXT, ...NULLABLE, 'currency', 'dedupe_key'];

export function ensureSources(db) {
  const insert = db.prepare(`
    INSERT INTO sources (key, name, kind, type, enabled, interval_minutes) VALUES (?, ?, 'builtin', ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET name = excluded.name, type = excluded.type
  `);
  for (const c of connectors) insert.run(c.key, c.name, c.type, c.enabledByDefault === false ? 0 : 1, c.intervalMinutes || 360);
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();

// The same notice often appears on several portals (a Scottish tender on
// PCS, Find a Tender and TED). Title, buyer and closing day identify it.
export function dedupeKey(item) {
  const title = norm(item.title).replace(/\band\b/g, ' ').replace(/\s+/g, ' ').trim();
  const buyer = norm(item.funder).replace(/\b(ltd|limited|plc|the|council|of)\b/g, '').replace(/\s+/g, ' ').trim();
  if (title.length < 12 || !buyer || !item.closes_at) return null;
  return `${title}|${buyer}|${item.closes_at.slice(0, 10)}`;
}

// Marks later copies of a notice as duplicates of the first one seen on a
// different source. Feeds and alerts only show the original.
export function linkDuplicates(db) {
  db.prepare(`
    UPDATE opportunities SET duplicate_of = (
      SELECT c.id FROM opportunities c
      WHERE c.dedupe_key = opportunities.dedupe_key AND c.id < opportunities.id AND c.source_key != opportunities.source_key
      ORDER BY c.id LIMIT 1)
    WHERE dedupe_key IS NOT NULL
  `).run();
}

export function saveOpportunities(db, connector, items) {
  const exists = db.prepare('SELECT 1 FROM opportunities WHERE source_key = ? AND external_id = ?');
  const upsert = db.prepare(`
    INSERT INTO opportunities (source_key, external_id, type, ${FIELDS.join(', ')})
    VALUES (@source_key, @external_id, @type, ${FIELDS.map((f) => `@${f}`).join(', ')})
    ON CONFLICT(source_key, external_id) DO UPDATE SET
      ${FIELDS.map((f) => `${f} = excluded.${f}`).join(', ')},
      updated_at = datetime('now')
  `);
  let added = 0;
  db.transaction(() => {
    for (const item of items) {
      const row = { source_key: connector.key, type: connector.type, external_id: String(item.external_id).slice(0, 500) };
      for (const f of TEXT) row[f] = String(item[f] ?? '').slice(0, f === 'summary' ? 20000 : 2000);
      for (const f of NULLABLE) row[f] = item[f] ?? null;
      row.currency = item.currency || 'GBP';
      row.dedupe_key = dedupeKey(row);
      if (!exists.get(connector.key, row.external_id)) added++;
      upsert.run(row);
    }
    linkDuplicates(db);
  })();
  return added;
}

function sourceRow(db, key) {
  return db.prepare('SELECT * FROM sources WHERE key = ?').get(key);
}

function context(db, connector, source, opts) {
  const http = createHttp({ minDelayMs: connector.minDelayMs ?? 1000, respectRobots: Boolean(connector.respectRobots), guard: Boolean(connector.guard) });
  let sourceConfig = {};
  try { sourceConfig = JSON.parse(source?.config || '{}'); } catch { /* treat as empty */ }
  return {
    maxPages: config.maxPagesPerSource,
    get: http.get,
    request: http.request,
    since: source?.last_ok_at || null,
    config: sourceConfig,
    credential: source?.credential_id ? loadCredential(db, source.credential_id) : null,
    ...opts,
  };
}

// Runs one connector and records the outcome. Never throws: a failing
// portal must not stop the others.
export async function runSource(db, connector, opts = {}) {
  const started = Date.now();
  const source = sourceRow(db, connector.key);
  const run = db.prepare('INSERT INTO source_runs (source_key) VALUES (?)').run(connector.key).lastInsertRowid;
  const finish = db.prepare('UPDATE source_runs SET status = ?, duration_ms = ?, found = ?, added = ?, error = ? WHERE id = ?');
  try {
    const items = await connector.fetch(context(db, connector, source, opts));
    const added = saveOpportunities(db, connector, items);
    db.prepare(`UPDATE sources SET last_run_at = datetime('now'), last_status = 'ok', last_error = NULL, last_found = ?, last_new = ?, last_ok_at = ? WHERE key = ?`)
      .run(items.length, added, new Date(started).toISOString(), connector.key);
    finish.run('ok', Date.now() - started, items.length, added, null, run);
    log.info(`${connector.name}: ${items.length} found, ${added} new`, { source: connector.key, found: items.length, added, ms: Date.now() - started });
    return { key: connector.key, found: items.length, added };
  } catch (err) {
    const message = String(err.message || err).slice(0, 1000);
    db.prepare(`UPDATE sources SET last_run_at = datetime('now'), last_status = 'error', last_error = ? WHERE key = ?`).run(message, connector.key);
    finish.run('error', Date.now() - started, null, null, message, run);
    log.error(`${connector.name} failed: ${message}`, { source: connector.key });
    return { key: connector.key, error: message };
  }
}

// Fetches without saving, so an administrator can check a source's settings.
export async function testSource(db, source, opts = {}) {
  const connector = connectorForSource(source);
  if (!connector) throw new Error('Unknown source type');
  const items = await connector.fetch(context(db, connector, { ...source, last_ok_at: null }, { maxPages: 1, ...opts }));
  return items.slice(0, 8);
}

let running = false;
export const isIngestRunning = () => running;

// Runs enabled sources. `only` picks one by key; `dueOnly` runs just those
// whose schedule has come round. Returns [] if a run is already under way.
export async function runAll(db, { only, dueOnly = false, now = Date.now() } = {}) {
  if (running) return [];
  running = true;
  try {
    ensureSources(db);
    const sources = db.prepare('SELECT * FROM sources WHERE enabled = 1 ORDER BY kind, key').all()
      .filter((s) => (!only || only === s.key) && (!dueOnly || !s.next_run_at || Date.parse(s.next_run_at) <= now));
    const results = [];
    for (const source of sources) {
      const connector = connectorForSource(source);
      if (!connector) continue;
      // Schedule the next run first, so a crash mid-run cannot cause a tight loop.
      db.prepare('UPDATE sources SET next_run_at = ? WHERE key = ?')
        .run(new Date(Date.now() + Math.max(15, source.interval_minutes) * 60e3).toISOString(), source.key);
      results.push(await runSource(db, connector));
    }
    return results;
  } finally {
    running = false;
  }
}

// Housekeeping: drop long-closed opportunities nobody has triaged, and old run history.
export function prune(db, { now = Date.now(), retentionDays = config.retentionDays } = {}) {
  const cutoff = new Date(now - retentionDays * 864e5).toISOString();
  const removed = db.prepare(`
    DELETE FROM opportunities WHERE closes_at IS NOT NULL AND closes_at < ?
      AND id NOT IN (SELECT opportunity_id FROM org_opportunity_state WHERE starred = 1 OR note != '' OR stage != '')
  `).run(cutoff).changes;
  db.prepare(`DELETE FROM source_runs WHERE started_at < datetime('now', '-60 days')`).run();
  db.prepare(`DELETE FROM alert_log WHERE created_at < datetime('now', '-180 days')`).run();
  db.prepare(`DELETE FROM audit_log WHERE at < datetime('now', '-365 days')`).run();
  return removed;
}
