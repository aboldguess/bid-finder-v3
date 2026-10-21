// Entry point: web server plus the daily ingest and digest schedule.
import cron from 'node-cron';
import { config } from './config.js';
import { getDb } from './db/index.js';
import { log } from './log.js';
import { runAll } from './ingest/run.js';
import { runDigests } from './notify/digest.js';
import { createApp } from './web/app.js';

const db = getDb();
const app = createApp(db);

app.listen(config.port, config.host, () => {
  log.info(`Bid Finder listening on http://${config.host}:${config.port}`);
});

cron.schedule(config.ingestCron, () => runAll(db).catch((err) => log.error('Ingest failed', err)));
cron.schedule(config.digestCron, () => runDigests(db).catch((err) => log.error('Digests failed', err)));

// A fresh install has nothing to show, so fetch straight away.
if (db.prepare('SELECT COUNT(*) AS n FROM opportunities').get().n === 0) {
  log.info('Empty database: running first ingest now');
  runAll(db).catch((err) => log.error('First ingest failed', err));
}
