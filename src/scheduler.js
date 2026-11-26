// Background work: runs each source when its interval comes round, sends
// alerts and digests, and does nightly housekeeping and backups.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { log } from './log.js';
import { prune, runAll } from './ingest/run.js';
import { runAlerts } from './notify/alerts.js';
import { runDigests } from './notify/digest.js';

let lastTick = 0;
let running = false;
// A scheduler in this process must have ticked in the last 10 minutes. A web
// process without one checks the separate worker's heartbeat instead.
export function schedulerHealthy(db) {
  if (running) return !lastTick || Date.now() - lastTick < 10 * 60e3;
  const beat = db?.prepare(`SELECT value FROM settings WHERE key = 'worker_heartbeat'`).get()?.value;
  return !beat || Date.now() - Number(beat) < 10 * 60e3;
}

// Online backup of the SQLite database, keeping the most recent few.
export async function backup(db, { dir = path.join(config.dataDir, 'backups'), keep = config.backupsToKeep, now = new Date() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `bidfinder-${now.toISOString().slice(0, 10)}.db`);
  await db.backup(file);
  // One self-contained file (no -wal/-shm beside it), ready to copy offsite.
  const copy = new Database(file);
  copy.pragma('journal_mode = DELETE');
  copy.close();
  const old = fs.readdirSync(dir).filter((f) => /^bidfinder-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -keep);
  for (const f of old) fs.rmSync(path.join(dir, f));
  return file;
}

// Re-gathers the statistics SQLite's planner uses to choose indexes, at most
// every few hours. Without them it can scan every open opportunity for each
// alert check instead of reading only the new ones.
let analyzedAt = 0;
export function refreshStats(db, minAgeMs = 6 * 3600e3) {
  if (Date.now() - analyzedAt < minAgeMs) return;
  db.exec('ANALYZE');
  analyzedAt = Date.now();
}

export async function tick(db) {
  lastTick = Date.now();
  db.prepare(`INSERT INTO settings (key, value) VALUES ('worker_heartbeat', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(lastTick));
  const results = await runAll(db, { dueOnly: true });
  if (results.length) {
    refreshStats(db);
    await runAlerts(db);
  }
  return results;
}

export async function startScheduler(db) {
  // Imported here so that loading this module (for the health check) starts no timers.
  const { default: cron } = await import('node-cron');
  running = true;
  const safely = (name, fn) => () => fn().catch((err) => log.error(`${name} failed`, err));
  const opts = { timezone: config.timezone };
  // Sources that are due run on the next minute; a fresh install starts straight away.
  setTimeout(safely('Ingest', () => tick(db)), 2000).unref();
  cron.schedule('* * * * *', safely('Ingest', () => tick(db)), opts);
  cron.schedule(config.digestCron, safely('Digests', async () => { await runDigests(db); await runAlerts(db); }), opts);
  cron.schedule(config.maintenanceCron, safely('Maintenance', async () => {
    const removed = prune(db);
    refreshStats(db, 0);
    const file = await backup(db);
    log.info(`Maintenance: removed ${removed} expired opportunities, backed up to ${file}`);
  }), opts);
  log.info('Scheduler started');
}
