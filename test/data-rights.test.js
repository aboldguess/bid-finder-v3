// Leaving and taking your data with you: export, deleting an account or a whole
// organisation, and the legal pages administrators write.
import './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { config } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { saveOpportunities } from '../src/ingest/run.js';
import { setState } from '../src/match/feed.js';
import { createUser } from '../src/users.js';
import { createApp } from '../src/web/app.js';
import { renderLegal } from '../src/web/routes/data.js';

const token = (html) => html.match(/name="_csrf" value="([^"]+)"/)[1];
const PASSWORD = 'correct horse battery';

const hosted = (name, fn) => test(name, async () => {
  config.hosted = true;
  try { await fn(); } finally { config.hosted = false; }
});

async function login(app, email) {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const res = await agent.post('/login').type('form').send({ _csrf: token(page.text), email, password: PASSWORD });
  assert.equal(res.status, 302, `${email} signs in`);
  return agent;
}

// An operator, then Acme (owner Pat, member Sam) with a private portal, a
// subscription, a search and pipeline notes, and Beta, who must be untouched.
async function setup({ cancel } = {}) {
  const db = openDb(':memory:');
  const calls = [];
  const subs = { sub_acme: 'active' }; // what Stripe holds
  const stripe = {
    configured: true,
    getSubscription: async (id) => ({ id, status: subs[id] || 'canceled' }),
    // A real cancellation takes a moment, which is when a second request can slip in.
    cancelSubscription: async (id) => { calls.push(id); await new Promise((r) => setTimeout(r, 100)); if (cancel) throw new Error(cancel); subs[id] = 'canceled'; return { id, status: 'canceled' }; },
  };
  const app = createApp(db, { mail: async () => {}, stripe });
  await createUser(db, { email: 'ops@operator.example', name: 'Ops', password: PASSWORD, orgName: 'Operator', admin: true });
  const pat = await createUser(db, { email: 'pat@acme.example', name: 'Pat', password: PASSWORD, orgName: 'Acme', trial: true });
  const acme = db.prepare(`SELECT id FROM orgs WHERE name = 'Acme'`).get().id;
  const sam = await createUser(db, { email: 'sam@acme.example', name: 'Sam', password: PASSWORD, orgId: acme, role: 'member' });
  await createUser(db, { email: 'bo@beta.example', name: 'Bo', password: PASSWORD, orgName: 'Beta', trial: true });
  const beta = db.prepare(`SELECT id FROM orgs WHERE name = 'Beta'`).get().id;
  db.prepare(`UPDATE orgs SET stripe_subscription_id = 'sub_acme', billing_status = 'active' WHERE id = ?`).run(acme);

  db.prepare(`INSERT INTO sources (key, name, kind, type, org_id) VALUES ('custom-acme', 'Acme portal', 'portal', 'tender', ?)`).run(acme);
  db.prepare(`INSERT INTO credentials (name, kind, secret, org_id) VALUES ('Acme login', 'login', 'x', ?)`).run(acme);
  const item = (id, title) => ({ external_id: id, title, url: 'https://e.example', closes_at: '2099-01-01T00:00:00Z' });
  saveOpportunities(db, { key: 'custom-acme', type: 'tender' }, [item('p1', 'Acme private notice')]);
  saveOpportunities(db, { key: 'find-a-tender', type: 'tender' }, [item('f1', 'Public bridge works')]);
  const pub = db.prepare(`SELECT id FROM opportunities WHERE external_id = 'f1'`).get().id;
  setState(db, acme, pub, { starred: 1, note: 'Worth a look', stage: 'qualifying' });
  setState(db, beta, pub, { starred: 1, note: 'Beta note' });
  db.prepare(`INSERT INTO saved_searches (org_id, name, filters, frequency, emails, slack_webhook) VALUES (?, 'Bridges', '{"q":"bridge"}', 'daily', 'pat@acme.example', 'encrypted-secret')`).run(acme);
  db.prepare(`INSERT INTO audit_log (user_id, actor, action, detail) VALUES (?, 'pat@acme.example', 'login', 'pat@acme.example signed in')`).run(pat.id);
  return { db, app, calls, subs, acme, beta, pat, sam, pub };
}

hosted('export: everything the organisation put in, as JSON, without secrets', async () => {
  const { app } = await setup();
  const sam = await login(app, 'sam@acme.example');
  const res = await sam.get('/account/export');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-disposition'], /attachment; filename="bid-finder-acme-\d{4}-\d{2}-\d{2}\.json"/);
  const data = JSON.parse(res.text);
  assert.equal(data.organisation.name, 'Acme');
  assert.deepEqual(data.members.map((m) => [m.email, m.role]), [['pat@acme.example', 'owner'], ['sam@acme.example', 'member']]);
  assert.equal(data.opportunities[0].note, 'Worth a look');
  assert.equal(data.saved_searches[0].has_slack, 1);
  assert.equal(data.private_sources[0].name, 'Acme portal');
  for (const secret of ['encrypted-secret', 'password_hash', 'token_hash', 'Beta note', 'bo@beta']) assert.ok(!res.text.includes(secret), `leaves out ${secret}`);
});

hosted('deleting the organisation removes its data and people, cancels the subscription, and leaves others alone', async () => {
  const { db, app, calls, acme, beta, pub } = await setup();
  const pat = await login(app, 'pat@acme.example');
  const page = await pat.get('/account');
  assert.match(page.text, /The whole organisation, <strong>Acme<\/strong>/);

  const wrongName = await pat.post('/account/delete').type('form').send({ _csrf: token(page.text), scope: 'org', confirm: 'acme', password: PASSWORD });
  assert.equal(wrongName.headers.location, '/account#delete');
  const wrongPassword = await pat.post('/account/delete').type('form').send({ _csrf: token(page.text), scope: 'org', confirm: 'Acme', password: 'nope' });
  assert.equal(wrongPassword.headers.location, '/account#delete');
  assert.ok(db.prepare('SELECT 1 FROM orgs WHERE id = ?').get(acme), 'nothing deleted yet');
  assert.deepEqual(calls, []);

  const res = await pat.post('/account/delete').type('form').send({ _csrf: token(page.text), scope: 'org', confirm: 'Acme', password: PASSWORD });
  assert.equal(res.headers.location, '/?deleted=org');
  assert.deepEqual(calls, ['sub_acme'], 'the subscription is cancelled first');
  const count = (sql, ...a) => db.prepare(sql).get(...a).n;
  assert.equal(count('SELECT COUNT(*) AS n FROM orgs WHERE id = ?', acme), 0);
  assert.equal(count(`SELECT COUNT(*) AS n FROM users WHERE email LIKE '%@acme.example'`), 0, 'both Acme accounts are gone');
  assert.equal(count(`SELECT COUNT(*) AS n FROM sources WHERE key = 'custom-acme'`), 0);
  assert.equal(count(`SELECT COUNT(*) AS n FROM opportunities WHERE external_id = 'p1'`), 0, 'notices from its private portal are gone');
  assert.equal(count('SELECT COUNT(*) AS n FROM credentials'), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM saved_searches'), 0);
  assert.equal(count(`SELECT COUNT(*) AS n FROM audit_log WHERE actor LIKE '%acme.example%' OR detail LIKE '%acme.example%'`), 0, 'the audit log keeps events, not names');
  assert.equal(count(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'org.deleted'`), 1);

  assert.ok(db.prepare('SELECT 1 FROM opportunities WHERE id = ?').get(pub), 'public notices stay');
  assert.equal(db.prepare('SELECT note FROM org_opportunity_state WHERE org_id = ?').get(beta).note, 'Beta note');
  assert.ok(await login(app, 'bo@beta.example'));
  assert.equal((await pat.get('/dashboard')).status, 302, 'the deleted session is signed out');
  assert.match((await request(app).get('/?deleted=org')).text, /Your organisation and its data have been deleted/);
});

hosted('deleting: if the payment provider cannot cancel, nothing is deleted', async () => {
  const { db, app, acme } = await setup({ cancel: 'Stripe is down' });
  const pat = await login(app, 'pat@acme.example');
  const page = await pat.get('/account');
  await pat.post('/account/delete').type('form').send({ _csrf: token(page.text), scope: 'org', confirm: 'Acme', password: PASSWORD });
  assert.ok(db.prepare('SELECT 1 FROM orgs WHERE id = ?').get(acme));
  assert.match((await pat.get('/account')).text, /could not cancel your subscription/);
});

hosted('deleting just your own account: members can, a sole owner with a team cannot, the last administrator cannot', async () => {
  const { db, app, acme } = await setup();
  const pat = await login(app, 'pat@acme.example');
  let page = await pat.get('/account');
  await pat.post('/account/delete').type('form').send({ _csrf: token(page.text), scope: 'me', password: PASSWORD });
  assert.match((await pat.get('/account')).text, /You are the only owner/);

  const sam = await login(app, 'sam@acme.example');
  page = await sam.get('/account');
  assert.ok(!page.text.includes('The whole organisation'), 'members are not offered the organisation');
  const forged = await sam.post('/account/delete').type('form').send({ _csrf: token(page.text), scope: 'org', confirm: 'Acme', password: PASSWORD });
  assert.equal(forged.headers.location, '/account#delete');
  assert.ok(db.prepare('SELECT 1 FROM orgs WHERE id = ?').get(acme), 'a member cannot delete the organisation');
  const res = await sam.post('/account/delete').type('form').send({ _csrf: token(page.text), scope: 'me', password: PASSWORD });
  assert.equal(res.headers.location, '/?deleted=account');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM users WHERE email = 'sam@acme.example'`).get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?').get(acme).n, 1, 'Acme carries on');

  const ops = await login(app, 'ops@operator.example');
  page = await ops.get('/account');
  await ops.post('/account/delete').type('form').send({ _csrf: token(page.text), scope: 'org', confirm: 'Operator', password: PASSWORD });
  assert.match((await ops.get('/account')).text, /only platform administrator/);
});

hosted('legal pages: administrators publish the wording, safely formatted and dated', async () => {
  const { app } = await setup();
  assert.match((await request(app).get('/terms')).text, /being finalised/);
  const ops = await login(app, 'ops@operator.example');
  const form = await ops.get('/admin/legal');
  assert.equal(form.status, 200);
  await ops.post('/admin/legal').type('form').send({ _csrf: token(form.text), terms: '# 1. Who we are\nBid Finder Ltd.\n\n- Fair use\n- No scraping\n\n<script>alert(1)</script>', privacy: '' });
  const terms = await request(app).get('/terms');
  assert.match(terms.text, /<h2>1\. Who we are<\/h2><p>Bid Finder Ltd\.<\/p>/);
  assert.match(terms.text, /<ul><li>Fair use<\/li><li>No scraping<\/li><\/ul>/);
  assert.match(terms.text, /&lt;script&gt;/);
  assert.match(terms.text, /Last updated/);
  assert.match((await request(app).get('/privacy')).text, /being finalised/);
  const pat = await login(app, 'pat@acme.example');
  assert.equal((await pat.get('/admin/legal')).status, 403);
});

test('legal text formatting and self-hosted servers', async () => {
  assert.equal(renderLegal('One\nline two\n\n## Head'), '<p>One<br>line two</p>\n<h2>Head</h2>');
  assert.equal(renderLegal(''), '');
  const app = createApp(openDb(':memory:'));
  assert.equal((await request(app).get('/terms')).status, 404);
});

hosted('deleting: a subscription still live at Stripe is cancelled even if its status here was changed by hand', async () => {
  const { db, app, calls, acme } = await setup();
  db.prepare(`UPDATE orgs SET billing_status = 'comped' WHERE id = ?`).run(acme);
  const pat = await login(app, 'pat@acme.example');
  const page = await pat.get('/account');
  await pat.post('/account/delete').type('form').send({ _csrf: token(page.text), scope: 'org', confirm: 'Acme', password: PASSWORD });
  assert.deepEqual(calls, ['sub_acme']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orgs WHERE id = ?').get(acme).n, 0);
});

hosted('deleting: an already-ended subscription is not cancelled twice', async () => {
  const { db, app, calls, subs, acme } = await setup();
  subs.sub_acme = 'canceled';
  const pat = await login(app, 'pat@acme.example');
  const page = await pat.get('/account');
  await pat.post('/account/delete').type('form').send({ _csrf: token(page.text), scope: 'org', confirm: 'Acme', password: PASSWORD });
  assert.deepEqual(calls, []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orgs WHERE id = ?').get(acme).n, 0);
});

hosted('deleting: two administrators deleting their organisations at once cannot leave none', async () => {
  const { db, app, acme, beta } = await setup();
  // The operator stops being an administrator; Pat (Acme) and Bo (Beta) are the only two, both subscribed.
  db.prepare(`UPDATE users SET is_platform_admin = CASE WHEN email IN ('pat@acme.example', 'bo@beta.example') THEN 1 ELSE 0 END`).run();
  db.prepare(`UPDATE orgs SET stripe_subscription_id = 'sub_beta' WHERE id = ?`).run(beta);
  const pat = await login(app, 'pat@acme.example');
  const bo = await login(app, 'bo@beta.example');
  const [pa, ba] = [await pat.get('/account'), await bo.get('/account')];
  await Promise.all([
    pat.post('/account/delete').type('form').send({ _csrf: token(pa.text), scope: 'org', confirm: 'Acme', password: PASSWORD }),
    bo.post('/account/delete').type('form').send({ _csrf: token(ba.text), scope: 'org', confirm: 'Beta', password: PASSWORD }),
  ]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_platform_admin = 1').get().n, 1, 'one administrator is always left');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orgs WHERE id IN (?, ?)').get(acme, beta).n, 1);
});
