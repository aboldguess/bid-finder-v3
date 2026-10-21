import { fixture } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { ensureSources, runSource } from '../src/ingest/run.js';
import { getFeed, setState } from '../src/match/feed.js';
import { buildDigest, isDue, sendDigest } from '../src/notify/digest.js';
import findAGrant from '../src/connectors/findAGrant.js';
import ukri from '../src/connectors/ukri.js';

function setup() {
  const db = openDb(':memory:');
  ensureSources(db);
  const org = db.prepare(`INSERT INTO orgs (name, kind) VALUES ('Acme Aero', 'company')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO profiles (org_id, keywords, regions, min_score, digest_emails) VALUES (?, 'manufacturing\nAI\nengineering biology', 'South East England', 20, 'a@example.com')`).run(org);
  return { db, org: db.prepare('SELECT * FROM orgs WHERE id = ?').get(org) };
}

const fakeGet = (name) => async () => fixture(name);

test('ingest deduplicates and updates in place', async () => {
  const { db } = setup();
  const first = await runSource(db, findAGrant, { get: fakeGet('find-a-grant.html'), delayMs: 0 });
  assert.deepEqual([first.found, first.added], [2, 2]);
  const again = await runSource(db, findAGrant, { get: fakeGet('find-a-grant.html'), delayMs: 0 });
  assert.equal(again.added, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM opportunities').get().n, 2);
  const src = db.prepare(`SELECT * FROM sources WHERE key = 'find-a-grant'`).get();
  assert.equal(src.last_status, 'ok');
});

test('a failing source records the error and does not throw', async () => {
  const { db } = setup();
  const r = await runSource(db, ukri, { get: async () => { throw new Error('HTTP 503'); } });
  assert.equal(r.error, 'HTTP 503');
  assert.equal(db.prepare(`SELECT last_error FROM sources WHERE key = 'ukri'`).get().last_error, 'HTTP 503');
});

test('feed ranks by fit, supports search, star and hide', async () => {
  const { db, org } = setup();
  await runSource(db, findAGrant, { get: fakeGet('find-a-grant.html'), delayMs: 0 });
  await runSource(db, ukri, { get: fakeGet('ukri.html'), delayMs: 0, maxPages: 1 });
  const now = Date.parse('2026-10-21T12:00:00Z');

  const matches = getFeed(db, org.id, { now });
  assert.equal(matches.items[0].title, 'Smart Manufacturing Accelerator');
  assert.ok(!matches.items.some((i) => i.title === 'Rural Community Fund'), 'closed or unmatched items are left out');

  const searched = getFeed(db, org.id, { q: 'biology', view: 'all', now });
  assert.deepEqual(searched.items.map((i) => i.external_id), ['engineering-biology-hubs']);

  const id = matches.items[0].id;
  setState(db, org.id, id, { starred: 1 });
  assert.deepEqual(getFeed(db, org.id, { view: 'starred', now }).items.map((i) => i.id), [id]);
  setState(db, org.id, id, { hidden: 1 });
  assert.ok(!getFeed(db, org.id, { now }).items.some((i) => i.id === id));
  assert.equal(getFeed(db, org.id, { view: 'hidden', now }).items[0].id, id);

  // Another organisation's triage is separate.
  const other = db.prepare(`INSERT INTO orgs (name) VALUES ('Other')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO profiles (org_id) VALUES (?)`).run(other);
  assert.equal(getFeed(db, other, { view: 'starred', now }).items.length, 0);
});

test('digests include only new matches and respect frequency', async () => {
  const { db, org } = setup();
  await runSource(db, findAGrant, { get: fakeGet('find-a-grant.html'), delayMs: 0 });
  const now = Date.parse('2026-10-21T12:00:00Z');
  const digest = await buildDigest(db, org, { now: Date.now() });
  assert.ok(digest.items.length >= 1);
  assert.match(digest.html, /Smart Manufacturing Accelerator/);
  assert.deepEqual(digest.recipients, ['a@example.com']);

  const sent = await sendDigest(db, org);
  assert.equal(sent.delivered, 0, 'no SMTP configured, so stored but not emailed');
  assert.equal(await buildDigest(db, org), null, 'nothing new since the last digest');

  assert.equal(isDue('daily', null, now), true);
  assert.equal(isDue('daily', '2026-10-21 06:00:00', now), false);
  assert.equal(isDue('daily', '2026-10-20 06:00:00', now), true);
  assert.equal(isDue('weekly', '2026-10-18 06:00:00', now), false);
  assert.equal(isDue('off', null, now), false);
});
