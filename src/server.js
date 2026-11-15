// Starts the web app and the background scheduler. Run through the CLI
// (`bidfinder serve`) or directly (`node src/server.js`).
import { config } from './config.js';
import { getDb } from './db/index.js';
import { log } from './log.js';
import { accessUrls, listen } from './listen.js';
import { startScheduler } from './scheduler.js';
import { createApp } from './web/app.js';

export async function serve({ port = config.port, host = config.host, strictPort = false, scheduler = config.scheduler } = {}) {
  const db = getDb();
  const app = createApp(db);
  const { server, port: actual } = await listen(app, { port, host, strict: strictPort });
  if (actual !== port) log.warn(`Port ${port} is in use, so Bid Finder is using ${actual} instead.`);
  // Links in emails and alerts should point at the port we really got, unless BASE_URL was set.
  if (!process.env.BASE_URL) config.baseUrl = `http://localhost:${actual}`;
  const urls = accessUrls({ host, port: actual });
  log.info(`Bid Finder ${config.version} is running at ${urls.local}`);
  if (urls.lan.length) log.info(`On your network: ${urls.lan.join(', ')}`);
  else if (host === '127.0.0.1' || host === 'localhost') log.info('Only this machine can connect. Use --lan to allow other devices on your network.');
  if (scheduler) startScheduler(db);

  const stop = (signal) => {
    log.info(`${signal} received, shutting down`);
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  return { server, port: actual, urls };
}

if (import.meta.filename === process.argv[1]) {
  serve().catch((err) => { log.error(err.message); process.exit(1); });
}
