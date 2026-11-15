#!/usr/bin/env node
// The bidfinder command. `bidfinder help` lists everything it can do.
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';

const HELP = `Bid Finder: finds tenders and grants that fit your firm.

Usage: bidfinder <command> [options]

Commands
  serve                    Start the web app and the background scheduler
  ingest [source-key]      Fetch every enabled source now, or just one
  alerts                   Send saved-search alerts that are due
  digest                   Build and send the digests that are due
  sources                  List sources with the result of their last run
  backup                   Back up the database into the data folder
  reset-password <email>   Set a new random password for a user and print it
  version                  Print the version

Options for serve
  -p, --port <number>      Port to listen on (default 3000, or PORT). If it is
                           in use, the next free port is used instead.
      --strict-port        Fail if the port is in use, rather than moving on
      --lan                Accept connections from other devices on your
                           network (the default; same as --host 0.0.0.0)
      --local              Accept connections from this machine only
      --host <address>     Listen on one specific address
      --no-scheduler       Serve the web app without fetching sources

Examples
  bidfinder serve --port 8080
  bidfinder serve --local
  bidfinder ingest find-a-tender

Settings such as SMTP_URL and BASE_URL are read from the environment or a .env
file in the current folder. See .env.example.`;

function fail(message) {
  console.error(`${message}\nRun "bidfinder help" for usage.`);
  process.exit(2);
}

// A .env file is optional; real environment variables win over it.
try { process.loadEnvFile('.env'); } catch { /* no .env file */ }

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string' },
      lan: { type: 'boolean' },
      local: { type: 'boolean' },
      'strict-port': { type: 'boolean' },
      'no-scheduler': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
} catch (err) {
  fail(err.message);
}
const { values, positionals } = parsed;
const [command = values.version ? 'version' : 'help', arg] = positionals;

if (values.help || command === 'help') {
  console.log(HELP);
} else if (command === 'serve') {
  if (values.lan && values.local) fail('Choose one of --lan and --local.');
  let port;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`Port must be a whole number from 1 to 65535, got "${values.port}".`);
  }
  const host = values.host || (values.local ? '127.0.0.1' : values.lan ? '0.0.0.0' : undefined);
  const { serve } = await import('./server.js');
  await serve({ port, host, strictPort: Boolean(values['strict-port']), scheduler: values['no-scheduler'] ? false : undefined })
    .catch((err) => { console.error(err.message); process.exit(1); });
} else {
  const { config } = await import('./config.js');
  const { getDb } = await import('./db/index.js');
  if (command === 'version') {
    console.log(config.version);
  } else if (command === 'ingest') {
    const { runAll, ensureSources } = await import('./ingest/run.js');
    const { runAlerts } = await import('./notify/alerts.js');
    const db = getDb();
    ensureSources(db);
    if (arg && !db.prepare('SELECT 1 FROM sources WHERE key = ?').get(arg)) fail(`No source called "${arg}". Run "bidfinder sources" to list them.`);
    const results = await runAll(db, { only: arg });
    console.table(results);
    await runAlerts(db);
    if (results.some((r) => r.error)) process.exitCode = 1;
  } else if (command === 'alerts') {
    const { runAlerts } = await import('./notify/alerts.js');
    console.table(await runAlerts(getDb()));
  } else if (command === 'digest') {
    const { runDigests } = await import('./notify/digest.js');
    console.table(await runDigests(getDb()));
  } else if (command === 'sources') {
    const { ensureSources } = await import('./ingest/run.js');
    const db = getDb();
    ensureSources(db);
    console.table(db.prepare('SELECT key, name, enabled, interval_minutes AS every_min, last_run_at, last_status, last_found AS found, last_new AS new FROM sources ORDER BY kind, name').all());
  } else if (command === 'backup') {
    const { backup } = await import('./scheduler.js');
    console.log(`Backed up to ${await backup(getDb())}`);
  } else if (command === 'reset-password') {
    if (!arg) fail('Give the email address of the account.');
    const db = getDb();
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(arg.toLowerCase());
    if (!user) fail(`No account with the email ${arg}.`);
    const bcrypt = (await import('bcryptjs')).default;
    const password = crypto.randomBytes(12).toString('base64url');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(password, 12), user.id);
    db.prepare(`DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?`).run(user.id);
    console.log(`New password for ${arg}: ${password}\nSign in and change it on the Account page.`);
  } else {
    fail(`Unknown command "${command}".`);
  }
}
