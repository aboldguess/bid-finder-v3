#!/usr/bin/env node
// The bidfinder command. `bidfinder help` lists everything it can do.
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';

const HELP = `Bid Finder: finds tenders and grants that fit your firm.

Usage: bidfinder <command> [options]

Commands
  serve                    Start the web app and the background scheduler
  worker                   Run only the background scheduler (fetching, alerts,
                           digests, backups), for use with serve --no-scheduler
  ingest [source-key]      Fetch every enabled source now, or just one
  alerts                   Send saved-search alerts that are due
  digest                   Build and send the digests that are due
  sources                  List sources with the result of their last run
  backup                   Back up the database into the data folder
  users [--orgs]           List accounts and who is an admin, or organisations
  create-user <email>      Create an account and print its password (see below)
  promote <email>          Make an account a platform administrator
  demote <email>           Stop an account being a platform administrator
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
      --hosted             Run as a shared hosted service: anyone can sign up
                           and start an organisation (same as HOSTED=true)

Options for create-user
      --name <name>        The person's name (default: the part before the @)
      --org <name>         Start a new organisation with this name, owned by
                           the new account. Without --org or --org-id the
                           account joins the only organisation, if there is one.
      --org-id <id>        Join an existing organisation (ids are listed by
                           "bidfinder users --orgs")
      --owner              Join that organisation as an owner, not a member
      --admin              Also make the account a platform administrator.
                           The first account on a server always is one.
      --password-stdin     Read the password from standard input instead of
                           generating one

Examples
  bidfinder serve --port 8080
  bidfinder serve --local
  bidfinder ingest find-a-tender
  bidfinder create-user you@example.co.uk --name "Sam Jones" --org "Acme Ltd" --admin
  bidfinder promote colleague@example.co.uk

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
      hosted: { type: 'boolean' },
      name: { type: 'string' },
      org: { type: 'string' },
      'org-id': { type: 'string' },
      orgs: { type: 'boolean' },
      owner: { type: 'boolean' },
      admin: { type: 'boolean' },
      'password-stdin': { type: 'boolean' },
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
  if (values.hosted) process.env.HOSTED = 'true';
  const { serve } = await import('./server.js');
  await serve({ port, host, strictPort: Boolean(values['strict-port']), scheduler: values['no-scheduler'] ? false : undefined })
    .catch((err) => { console.error(err.message); process.exit(1); });
} else if (command === 'worker') {
  // The scheduler on its own, so slow fetching and scoring never hold up web pages.
  const { getDb } = await import('./db/index.js');
  const { startScheduler } = await import('./scheduler.js');
  const { log } = await import('./log.js');
  const db = getDb();
  const { ensureSources } = await import('./ingest/run.js');
  ensureSources(db);
  await startScheduler(db);
  log.info('Worker running. Stop it with Ctrl+C.');
  const stop = () => { db.close(); process.exit(0); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
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
  } else if (command === 'users') {
    const { listUsers, listOrgs } = await import('./users.js');
    const db = getDb();
    if (values.orgs) console.table(listOrgs(db));
    else {
      const rows = listUsers(db);
      if (rows.length) console.table(rows);
      else console.log('No accounts yet. Create the first with: bidfinder create-user <email> --org "<organisation>"');
    }
  } else if (command === 'create-user') {
    if (!arg) fail('Give the email address for the new account.');
    if (values.org && values['org-id']) fail('Choose one of --org and --org-id.');
    const { createUser, generatePassword, listOrgs, UserError } = await import('./users.js');
    const db = getDb();
    let orgId;
    if (values['org-id'] !== undefined) {
      orgId = Number(values['org-id']);
      if (!Number.isInteger(orgId)) fail(`--org-id must be a number, got "${values['org-id']}".`);
    } else if (!values.org) {
      const orgs = listOrgs(db);
      if (orgs.length === 0) fail('There is no organisation yet. Give one with --org "<name>".');
      if (orgs.length > 1) fail(`There is more than one organisation. Choose one with --org-id, or start a new one with --org "<name>":\n${orgs.map((o) => `  ${o.id}  ${o.name}`).join('\n')}`);
      orgId = orgs[0].id;
    }
    let password, generated;
    if (values['password-stdin']) {
      let input = '';
      for await (const chunk of process.stdin) input += chunk;
      password = input.replace(/\r?\n$/, '');
    }
    try {
      const user = await createUser(db, {
        email: arg,
        name: values.name || arg.split('@')[0],
        password: password ??= generated = generatePassword(),
        ...(orgId === undefined ? { orgName: values.org } : { orgId, role: values.owner ? 'owner' : 'member' }),
        admin: values.admin,
      });
      const org = db.prepare('SELECT name FROM orgs WHERE id = ?').get(user.orgId).name;
      console.log(`Created ${user.email} (${user.role} of ${org})${user.isAdmin ? ', a platform administrator' : ''}${user.first && !values.admin ? ' because it is the first account' : ''}.`);
      if (generated) console.log(`Password: ${generated}\nSign in and change it on the Account page.`);
    } catch (err) {
      if (err instanceof UserError) fail(err.message);
      throw err;
    }
  } else if (command === 'promote' || command === 'demote') {
    if (!arg) fail('Give the email address of the account.');
    const { setPlatformAdmin, UserError } = await import('./users.js');
    try {
      const { user, changed } = setPlatformAdmin(getDb(), arg, command === 'promote');
      const messages = command === 'promote' ? ['is now', 'was already'] : ['is no longer', 'was not'];
      console.log(`${user.email} ${messages[changed ? 0 : 1]} a platform administrator.`);
    } catch (err) {
      if (err instanceof UserError) { console.error(err.message); process.exit(1); }
      throw err;
    }
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
