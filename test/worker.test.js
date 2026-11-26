// Incremental alerts and the separate worker process.
import './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { openDb } from '../src/db/index.js';
import { ensureSources, saveOpportunities } from '../src/ingest/run.js';
import { baseline, runAlerts } from '../src/notify/alerts.js';
import { createApp } from '../src/web/app.js';

function setup() {
  const db = openDb(':memory:');
  ensureSources(db);
  const org = db.prepare(`INSERT INTO orgs (name) VALUES ('Northfield')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO profiles (org_id, keywords, types, min_score) VALUES (?, 'rig', 'tender', 0)`).run(org);
  const user = db.prepare(`INSERT INTO users (email, name, password_hash, email_verified_at) VALUES ('o@n.example', 'O', 'x', datetime('now'))`).run().lastInsertRowid;
  db.prepare(`INSERT INTO memberships (user_id, org_id, role) VALUES (?, ?, 'owner')`).run(user, org);
  const id = db.prepare(`INSERT INTO saved_searches (org_id, name, filters, frequency, emails) VALUES (?, 'Rigs', '{"q":"rig"}', 'instant', 'a@example.com')`).run(org).lastInsertRowid;
  const search = () => db.prepare('SELECT * FROM saved_searches WHERE id = ?').get(id);
  const add = (n, extra = {}) => saveOpportunities(db, { key: 'find-a-tender', type: 'tender' }, Array.from({ length: n }, (_, i) => ({
    external_id: `${extra.prefix || 'o'}${i}`, title: `Test rig number ${extra.prefix || ''}${i}`, url: 'https://e.example', closes_at: '2099-01-01T00:00:00Z', ...extra.fields,
  })));
  return { db, search, add };
}

test('alerts: only what is new since the last check is looked at, and nothing is lost or repeated', async () => {
  const { db, search, add } = setup();
  add(3, { prefix: 'old' });
  baseline(db, search());
  assert.ok(search().checked_at, 'a new search starts from now');

  const sent = [];
  const channels = { sendEmail: async (m) => sent.push(m) };
  assert.deepEqual(await runAlerts(db, { channels }), []);
  add(2, { prefix: 'new' });
  const [first] = await runAlerts(db, { channels });
  assert.equal(first.count, 2);
  assert.deepEqual(await runAlerts(db, { channels }), [], 'never sent twice');

  // When every channel fails, the check is not moved on, so the matches go out next time.
  add(1, { prefix: 'later' });
  const failing = { sendEmail: async () => { throw new Error('SMTP down'); } };
  const checkedBefore = search().checked_at;
  await runAlerts(db, { channels: failing });
  assert.equal(search().checked_at, checkedBefore);
  const [retry] = await runAlerts(db, { channels });
  assert.equal(retry.count, 1);
});

test('alerts: a busy day with more than 500 matching notices still alerts on every new one', async () => {
  const { db, search, add } = setup();
  add(600, { prefix: 'bulk', fields: { award_max: 9e9 } }); // high-scoring old notices that crowd the top
  baseline(db, search());
  add(1, { prefix: 'fresh' });
  const sent = [];
  const [result] = await runAlerts(db, { channels: { sendEmail: async (m) => sent.push(m) } });
  assert.equal(result.count, 1, 'the new one is found even though 600 older ones outrank it');
});

test('readiness: a web process with no scheduler reports a stalled separate worker', async () => {
  const db = openDb(':memory:');
  const app = createApp(db);
  assert.equal((await request(app).get('/readyz')).status, 200, 'no worker has ever run: fine');
  db.prepare(`INSERT INTO settings (key, value) VALUES ('worker_heartbeat', ?)`).run(String(Date.now()));
  assert.equal((await request(app).get('/readyz')).status, 200);
  db.prepare(`UPDATE settings SET value = ? WHERE key = 'worker_heartbeat'`).run(String(Date.now() - 20 * 60e3));
  const stalled = await request(app).get('/readyz');
  assert.equal(stalled.status, 503);
  assert.match(stalled.body.reason, /scheduler stalled/);
});

test('the bidfinder worker command runs the scheduler and records a heartbeat', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-worker-'));
  const cli = path.resolve(import.meta.dirname, '..', 'src', 'cli.js');
  const env = { ...process.env, DATA_DIR: dir, DB_FILE: path.join(dir, 'w.db'), LOG_LEVEL: 'info', MAX_PAGES_PER_SOURCE: '0' };
  // Turn every source off so the first tick fetches nothing from the internet.
  const db = openDb(env.DB_FILE);
  ensureSources(db);
  db.prepare('UPDATE sources SET enabled = 0').run();
  db.close();
  const child = spawn(process.execPath, [cli, 'worker'], { env, cwd: dir });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    for (let i = 0; i < 50 && !/Worker running/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(out, /Worker running/);
    let beat;
    for (let i = 0; i < 50 && !beat; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const check = openDb(env.DB_FILE);
      beat = check.prepare(`SELECT value FROM settings WHERE key = 'worker_heartbeat'`).get()?.value;
      check.close();
    }
    assert.ok(Number(beat) > Date.now() - 60e3, 'heartbeat written by the first tick');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

