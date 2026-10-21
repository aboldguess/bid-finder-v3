// Pulls opportunities from every enabled connector into the database.
// Sources run one after another so a Pi is never hammering several sites.
import { connectors, connectorByKey } from '../connectors/index.js';
import { config } from '../config.js';
import { log } from '../log.js';

const FIELDS = ['title', 'summary', 'url', 'funder', 'location', 'eligibility', 'status', 'award_min', 'award_max', 'total_fund', 'award_text', 'opens_at', 'closes_at', 'published_at'];

export function ensureSources(db) {
  const insert = db.prepare('INSERT INTO sources (key, name) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET name = excluded.name');
  for (const c of connectors) insert.run(c.key, c.name);
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
      const row = { source_key: connector.key, type: connector.type };
      for (const f of ['external_id', ...FIELDS]) row[f] = item[f] ?? (f.startsWith('award') || f.endsWith('_at') || f === 'total_fund' ? null : '');
      row.external_id = String(row.external_id);
      if (!exists.get(connector.key, row.external_id)) added++;
      upsert.run(row);
    }
  })();
  return added;
}

export async function runSource(db, connector, opts = {}) {
  const started = Date.now();
  try {
    const items = await connector.fetch({ maxPages: config.maxPagesPerSource, ...opts });
    const added = saveOpportunities(db, connector, items);
    db.prepare(`UPDATE sources SET last_run_at = datetime('now'), last_status = 'ok', last_error = NULL, last_found = ?, last_new = ? WHERE key = ?`)
      .run(items.length, added, connector.key);
    log.info(`${connector.name}: ${items.length} found, ${added} new (${Date.now() - started} ms)`);
    return { key: connector.key, found: items.length, added };
  } catch (err) {
    db.prepare(`UPDATE sources SET last_run_at = datetime('now'), last_status = 'error', last_error = ? WHERE key = ?`)
      .run(err.message, connector.key);
    log.error(`${connector.name} failed: ${err.message}`);
    return { key: connector.key, error: err.message };
  }
}

let running = false;
export async function runAll(db, { only } = {}) {
  if (running) return [];
  running = true;
  try {
    ensureSources(db);
    const enabled = new Set(db.prepare('SELECT key FROM sources WHERE enabled = 1').all().map((r) => r.key));
    const results = [];
    for (const c of connectors) {
      if (!enabled.has(c.key) || (only && only !== c.key)) continue;
      results.push(await runSource(db, connectorByKey(c.key)));
    }
    return results;
  } finally {
    running = false;
  }
}

export const isIngestRunning = () => running;
