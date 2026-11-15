// Background work: runs each source when its interval comes round, sends
// alerts and digests, and does nightly housekeeping and backups.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './log.js';
import { prune, runAll } from './ingest/run.js';
import { runAlerts } from './notify/alerts.js';
import { runDigests } from './notify/digest.js';

let lastTick = 0;
export const schedulerHealthy = () => !config.scheduler || !lastTick || Date.now() - lastTick < 10 * 60e3;

// Online backup of the SQLite database, keeping the most recent few.
export async function backup(db, { dir = path.join(config.dataDir, 'backups'), keep = config.backupsToKeep, now = new Date() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `bidfinder-${now.toISOString().slice(0, 10)}.db`);
  await db.backup(file);
  const old = fs.readdirSync(dir).filter((f) => /^bidfinder-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -keep);
  for (const f of old) fs.rmSync(path.join(dir, f));
  return file;
}

export async function tick(db) {
  lastTick = Date.now();
  const results = await runAll(db, { dueOnly: true });
  if (results.length) await runAlerts(db);
  return results;
}

export async function startScheduler(db) {
  // Imported here so that loading this module (for the health check) starts no timers.
  const { default: cron } = await import('node-cron');
  const safely = (name, fn) => () => fn().catch((err) => log.error(`${name} failed`, err));
  const opts = { timezone: config.timezone };
  // Sources that are due run on the next minute; a fresh install starts straight away.
  setTimeout(safely('Ingest', () => tick(db)), 2000).unref();
  cron.schedule('* * * * *', safely('Ingest', () => tick(db)), opts);
  cron.schedule(config.digestCron, safely('Digests', async () => { await runDigests(db); await runAlerts(db); }), opts);
  cron.schedule(config.maintenanceCron, safely('Maintenance', async () => {
    const removed = prune(db);
    const file = await backup(db);
    log.info(`Maintenance: removed ${removed} expired opportunities, backed up to ${file}`);
  }), opts);
  log.info('Scheduler started');
}
