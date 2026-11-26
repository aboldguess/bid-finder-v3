// Tenant isolation: one organisation can never see another's private
// sources, their names, or anything they found, through any route.
import './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { openDb } from '../src/db/index.js';
import { saveOpportunities } from '../src/ingest/run.js';
import { runAlerts } from '../src/notify/alerts.js';
import { buildDigest } from '../src/notify/digest.js';
import { createApp } from '../src/web/app.js';
import { createUser } from '../src/users.js';

const token = (html) => html.match(/name="_csrf" value="([^"]+)"/)[1];
const PRIVATE_TITLE = 'Confidential widget framework for Acme only';
const PUBLIC_TITLE = 'Public widget framework open to everyone';

async function signIn(app, email) {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  await agent.post('/login').type('form').send({ _csrf: token(page.text), email, password: 'a long password' });
  return agent;
}

async function setup() {
  const db = openDb(':memory:');
  const app = createApp(db, { mail: async () => {} });
  const admin = await createUser(db, { email: 'ops@operator.example', name: 'Ops', password: 'a long password', orgName: 'Operator' });
  const a = await createUser(db, { email: 'ann@acme.example', name: 'Ann', password: 'a long password', orgName: 'Acme' });
  const b = await createUser(db, { email: 'bob@beta.example', name: 'Bob', password: 'a long password', orgName: 'Beta' });
  for (const org of [a.orgId, b.orgId]) db.prepare(`UPDATE profiles SET keywords = 'widget', types = 'tender', min_score = 0 WHERE org_id = ?`).run(org);
  db.prepare(`INSERT INTO sources (key, name, kind, type, org_id) VALUES ('custom-acme-portal', 'Acme supplier portal', 'portal', 'tender', ?)`).run(a.orgId);
  const item = (o) => ({ funder: 'Widget Council', url: 'https://e.example/x', closes_at: '2099-12-08T12:00:00.000Z', ...o });
  saveOpportunities(db, { key: 'custom-acme-portal', type: 'tender' }, [item({ external_id: 'p1', title: PRIVATE_TITLE })]);
  saveOpportunities(db, { key: 'find-a-tender', type: 'tender' }, [item({ external_id: 'f1', title: PUBLIC_TITLE })]);
  const privateId = db.prepare('SELECT id FROM opportunities WHERE external_id = ?').get('p1').id;
  const apiToken = (user) => {
    const t = `bf_${crypto.randomBytes(16).toString('hex')}`;
    db.prepare('INSERT INTO api_tokens (org_id, user_id, name, prefix, token_hash) VALUES (?, ?, ?, ?, ?)')
      .run(user.orgId, user.id, 'test', t.slice(0, 9), crypto.createHash('sha256').update(t).digest('hex'));
    return t;
  };
  return { db, app, admin, a, b, privateId, apiToken };
}

test('isolation: the web app never shows one organisation another\'s private portal', async () => {
  const { app, privateId } = await setup();
  const ann = await signIn(app, 'ann@acme.example');
  const bob = await signIn(app, 'bob@beta.example');

  const annFeed = (await ann.get('/feed')).text;
  assert.match(annFeed, /Confidential widget framework/, 'the owner sees its own private results');
  assert.match(annFeed, /Acme supplier portal/, 'and its portal in the source filter');

  for (const path of ['/feed', '/feed?view=all', '/dashboard', '/searches/new', `/feed?source=custom-acme-portal`]) {
    const page = (await bob.get(path)).text;
    assert.doesNotMatch(page, /Confidential widget framework/, `${path} shows no private results`);
    assert.doesNotMatch(page, /Acme supplier portal/, `${path} does not name the private portal`);
  }
  assert.match((await bob.get('/feed')).text, /Public widget framework/);

  assert.equal((await bob.get(`/o/${privateId}`)).status, 404, 'opening it by number looks like it does not exist');
  const feed = await bob.get('/feed');
  const star = await bob.post(`/o/${privateId}/state`).set('Content-Type', 'application/json').set('X-CSRF-Token', token(feed.text)).send({ starred: 1 });
  assert.equal(star.status, 404, 'and it cannot be starred into the pipeline');
  assert.equal((await ann.get(`/o/${privateId}`)).status, 200);

  const landing = (await request(app).get('/')).text;
  assert.match(landing, /1 open opportunit/, 'public figures on the landing page leave private results out');
  assert.match((await bob.get('/welcome')).text, /watching 1 open contracts/, 'the welcome page counts only what Beta can see');
  assert.match((await ann.get('/welcome')).text, /watching 2 open contracts/, 'Acme counts its own private results');
});

test('isolation: the API never shows one organisation another\'s private portal', async () => {
  const { app, a, b, privateId, apiToken } = await setup();
  const bob = apiToken(b);
  const ann = apiToken(a);
  const get = (t, path) => request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${t}`);

  const list = await get(bob, '/opportunities?limit=200');
  assert.ok(list.body.items.some((o) => o.title === PUBLIC_TITLE));
  assert.ok(!list.body.items.some((o) => o.title === PRIVATE_TITLE));
  assert.ok(!(await get(bob, '/opportunities?source=custom-acme-portal')).body.items.some((o) => o.title === PRIVATE_TITLE));
  assert.equal((await get(bob, `/opportunities/${privateId}`)).status, 404);
  const patch = await request(app).patch(`/api/v1/opportunities/${privateId}`).set('Authorization', `Bearer ${bob}`).send({ starred: true });
  assert.equal(patch.status, 404);
  assert.ok(!(await get(bob, '/sources')).body.items.some((s) => s.key === 'custom-acme-portal'));

  assert.ok((await get(ann, '/opportunities')).body.items.some((o) => o.title === PRIVATE_TITLE));
  assert.ok((await get(ann, '/sources')).body.items.some((s) => s.key === 'custom-acme-portal'));
});

test('isolation: alerts and digests only carry what the organisation may see', async () => {
  const { db, a, b } = await setup();
  for (const org of [a.orgId, b.orgId]) {
    db.prepare(`INSERT INTO saved_searches (org_id, name, filters, frequency, emails) VALUES (?, 'Widgets', '{"q":"widget"}', 'instant', 'x@example.com')`).run(org);
  }
  const sent = [];
  await runAlerts(db, { channels: { sendEmail: async (m) => sent.push(m) } });
  const toOrg = (orgId) => sent.find((m) => m.subject.includes('Widgets') && m.html.includes(orgId === a.orgId ? 'Confidential' : 'Public'));
  assert.ok(toOrg(a.orgId), 'the owner is alerted about its private result');
  const bobAlerts = sent.filter((m) => !m.html.includes('Confidential'));
  assert.equal(sent.length, 2);
  assert.equal(bobAlerts.length, 1, 'the other organisation\'s alert leaves it out');

  const digestA = await buildDigest(db, { id: a.orgId, name: 'Acme' });
  const digestB = await buildDigest(db, { id: b.orgId, name: 'Beta' });
  assert.ok(digestA.items.some((o) => o.title === PRIVATE_TITLE));
  assert.ok(!digestB.items.some((o) => o.title === PRIVATE_TITLE));
});

test('isolation: a public notice is never folded into a private copy of it', async () => {
  const { db, app } = await setup();
  // The private portal saw it first; Find a Tender publishes the same notice later.
  const same = { title: 'Bridge widget inspection services', funder: 'Northshire Council', url: 'https://e.example/b', closes_at: '2099-10-01T12:00:00.000Z' };
  saveOpportunities(db, { key: 'custom-acme-portal', type: 'tender' }, [{ external_id: 'p2', ...same }]);
  saveOpportunities(db, { key: 'find-a-tender', type: 'tender' }, [{ external_id: 'f2', ...same }]);
  const pub = db.prepare(`SELECT duplicate_of FROM opportunities WHERE external_id = 'f2'`).get();
  assert.equal(pub.duplicate_of, null, 'the public copy stands on its own');
  const bob = await signIn(app, 'bob@beta.example');
  assert.match((await bob.get('/feed')).text, /Bridge widget inspection services/, 'so other organisations still see it');
});

test('admin: a customer\'s credential can only be used by a source private to that customer', async () => {
  const { db, app, a, b } = await setup();
  const ops = await signIn(app, 'ops@operator.example');
  const admin = await ops.get('/admin');
  await ops.post('/admin/credentials').type('form').send({ _csrf: token(admin.text), name: 'Acme login', kind: 'login', username: 'acme', password: 'secret', org_id: String(a.orgId) });
  const cred = db.prepare(`SELECT id, org_id FROM credentials WHERE name = 'Acme login'`).get();
  assert.equal(cred.org_id, a.orgId);

  const form = await ops.get('/admin/sources/new?kind=rss');
  assert.match(form.text, /Only Acme/, 'the form offers each organisation');
  const save = (orgId) => ops.post('/admin/sources').type('form').send({
    _csrf: token(form.text), kind: 'rss', name: `Feed for ${orgId || 'all'}`, type: 'tender', url: 'https://93.184.215.14/feed.rss', credential_id: String(cred.id), org_id: orgId ? String(orgId) : '', interval_minutes: '360',
  });
  const shared = await save(null);
  assert.equal(shared.status, 400);
  assert.match(shared.text, /must be private to the same organisation/);
  assert.equal((await save(b.orgId)).status, 400, 'nor private to someone else');
  assert.equal((await save(a.orgId)).status, 302);
  assert.equal(db.prepare(`SELECT org_id FROM sources WHERE name = ?`).get(`Feed for ${a.orgId}`).org_id, a.orgId);

  // Editing a shared source: the chosen organisation is what gets saved.
  db.prepare(`INSERT INTO sources (key, name, kind, type, config, org_id) VALUES ('custom-shared-feed', 'Shared feed', 'rss', 'tender', '{}', NULL)`).run();
  const edit = await ops.get('/admin/sources/custom-shared-feed');
  const update = (orgId) => ops.post('/admin/sources/custom-shared-feed').type('form').send({
    _csrf: token(edit.text), name: 'Shared feed', type: 'tender', url: 'https://93.184.215.14/feed.rss', credential_id: String(cred.id), org_id: orgId ? String(orgId) : '', interval_minutes: '360',
  });
  assert.equal((await update(null)).status, 400, 'a shared source cannot take a customer credential');
  assert.equal((await update(a.orgId)).status, 302);
  const edited = db.prepare(`SELECT org_id, credential_id FROM sources WHERE key = 'custom-shared-feed'`).get();
  assert.deepEqual(edited, { org_id: a.orgId, credential_id: cred.id }, 'the source became private along with the credential');

  // Customers never reach the admin pages at all.
  const ann = await signIn(app, 'ann@acme.example');
  assert.equal((await ann.get('/admin')).status, 403);
});

test('isolation: an organisation that owns a private source cannot be deleted by accident', async () => {
  const { db, a } = await setup();
  assert.throws(() => db.prepare('DELETE FROM orgs WHERE id = ?').run(a.orgId), /FOREIGN KEY/);
});
