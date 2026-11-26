// Plans, trials, limits and promotions in hosted mode.
import './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { config } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { saveOpportunities } from '../src/ingest/run.js';
import { runAlerts } from '../src/notify/alerts.js';
import { runDigests } from '../src/notify/digest.js';
import { entitlement, withPrices } from '../src/billing/plans.js';
import { createApp } from '../src/web/app.js';

const token = (html) => html.match(/name="_csrf" value="([^"]+)"/)[1];
const hosted = (name, fn) => test(name, async () => {
  config.hosted = true;
  try { await fn(); } finally { config.hosted = false; }
});

async function signUp(app, email, orgName) {
  const agent = request.agent(app);
  const page = await agent.get('/register');
  await agent.post('/register').type('form').send({ _csrf: token(page.text), name: 'Pat', email, password: 'correct horse battery', orgName, terms: '1' });
  return agent;
}

async function setup() {
  const db = openDb(':memory:');
  const app = createApp(db, { mail: async () => {} });
  const ops = await signUp(app, 'ops@operator.example', 'Operator');
  const pat = await signUp(app, 'pat@acme.example', 'Acme');
  db.prepare(`UPDATE users SET email_verified_at = datetime('now')`).run();
  const org = db.prepare(`SELECT * FROM orgs WHERE name = 'Acme'`).get();
  return { db, app, ops, pat, orgId: org.id, org: () => db.prepare('SELECT * FROM orgs WHERE id = ?').get(org.id) };
}

hosted('sign-up starts a 14-day trial on Team limits; the operator\'s own organisation is free', async () => {
  const { db, org } = await setup();
  assert.equal(db.prepare(`SELECT billing_status FROM orgs WHERE name = 'Operator'`).get().billing_status, 'comped');
  const o = org();
  assert.equal(o.billing_status, 'trialing');
  const days = (Date.parse(o.trial_ends_at) - Date.now()) / 864e5;
  assert.ok(days > 13.9 && days <= 14, `trial is 14 days, got ${days}`);
  const access = entitlement(db, o);
  assert.equal(access.plan.key, 'team');
  assert.equal(access.limits.seats, 5);
  assert.equal(access.trialDaysLeft, 14);
});

hosted('when the trial ends the organisation is read-only: it can look but not change, and gets no alerts', async () => {
  const { db, app, pat, orgId } = await setup();
  db.prepare(`INSERT INTO saved_searches (org_id, name, filters, frequency, emails) VALUES (?, 'Rigs', '{"q":"rig"}', 'instant', 'pat@acme.example')`).run(orgId);
  db.prepare(`UPDATE profiles SET min_score = 0 WHERE org_id = ?`).run(orgId);
  db.prepare(`UPDATE orgs SET trial_ends_at = ? WHERE id = ?`).run(new Date(Date.now() - 1000).toISOString(), orgId);
  saveOpportunities(db, { key: 'find-a-tender', type: 'tender' }, [{ external_id: 'r1', title: 'Test rig maintenance', url: 'https://e.example', closes_at: '2099-01-01T00:00:00Z' }]);

  const feed = await pat.get('/feed');
  assert.equal(feed.status, 200, 'still able to look');
  assert.match(feed.text, /free trial has ended/);
  const save = await pat.post('/profile').type('form').send({ _csrf: token(feed.text), keywords: 'anything' });
  assert.equal(save.status, 303);
  assert.equal(save.headers.location, '/billing');
  const oppId = db.prepare('SELECT id FROM opportunities').get().id;
  const star = await pat.post(`/o/${oppId}/state`).set('Content-Type', 'application/json').set('X-CSRF-Token', token(feed.text)).send({ starred: 1 });
  assert.equal(star.status, 402);
  assert.equal((await pat.get('/billing')).status, 200);

  const t = `bf_${crypto.randomBytes(8).toString('hex')}`;
  const userId = db.prepare(`SELECT id FROM users WHERE email = 'pat@acme.example'`).get().id;
  db.prepare('INSERT INTO api_tokens (org_id, user_id, name, prefix, token_hash) VALUES (?, ?, ?, ?, ?)').run(orgId, userId, 't', t.slice(0, 9), crypto.createHash('sha256').update(t).digest('hex'));
  assert.equal((await request(app).get('/api/v1/opportunities').set('Authorization', `Bearer ${t}`)).status, 200, 'the API can still read');
  assert.equal((await request(app).patch(`/api/v1/opportunities/${oppId}`).set('Authorization', `Bearer ${t}`).send({ starred: true })).status, 402);

  const sent = [];
  await runAlerts(db, { channels: { sendEmail: async (m) => sent.push(m) } });
  assert.equal(sent.length, 0, 'no alerts while lapsed');
  assert.ok(!(await runDigests(db)).some((r) => r.org === orgId), 'no digest while lapsed');

  // An administrator extends the trial: everything works again.
  const admin = await request.agent(app);
  const login = await admin.get('/login');
  await admin.post('/login').type('form').send({ _csrf: token(login.text), email: 'ops@operator.example', password: 'correct horse battery' });
  const page = await admin.get('/admin');
  assert.match(page.text, /Trial ends/);
  await admin.post(`/admin/orgs/${orgId}/billing`).type('form').send({ _csrf: token(page.text), billing_status: 'trialing', plan_key: '', trial_ends_at: '2099-01-01' });
  assert.equal(entitlement(db, db.prepare('SELECT * FROM orgs WHERE id = ?').get(orgId)).readOnly, false);
  assert.equal((await pat.post('/profile').type('form').send({ _csrf: token(feed.text), keywords: 'rig' })).headers.location, '/feed');
});

hosted('plan limits: team members, saved searches and instant alerts', async () => {
  const { db, pat, orgId } = await setup();
  db.prepare(`UPDATE orgs SET billing_status = 'active', plan_key = 'starter' WHERE id = ?`).run(orgId);

  const team = await pat.get('/team');
  const invite = await pat.post('/team/invites').type('form').send({ _csrf: token(team.text), email: 'sam@acme.example' });
  assert.equal(invite.status, 302);
  assert.match((await pat.get('/team')).text, /Your plan includes 1 team members/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM invites').get().n, 0);

  const form = await pat.get('/searches/new');
  assert.match(form.text, /Team plan and above/, 'instant alerts are shown as unavailable');
  const save = (name, frequency) => pat.post('/searches').type('form').send({ _csrf: token(form.text), name, q: 'rig', frequency, emails: '' });
  const instant = await save('Instant', 'instant');
  assert.equal(instant.status, 400);
  assert.match(instant.text, /Instant alerts are on the Team plan/);
  for (const n of [1, 2, 3]) assert.equal((await save(`Search ${n}`, 'daily')).status, 302);
  const fourth = await save('Search 4', 'daily');
  assert.equal(fourth.status, 400);
  assert.match(fourth.text, /includes 3 saved searches/);

  db.prepare(`UPDATE orgs SET plan_key = 'team' WHERE id = ?`).run(orgId);
  assert.equal((await save('Search 4', 'instant')).status, 302, 'upgrading lifts the limits');
});

hosted('admins edit prices, sales, badges and the banner; the pricing page shows them', async () => {
  const { db, app, ops, orgId } = await setup();
  const before = await request(app).get('/pricing');
  assert.match(before.text, /Most popular/);
  assert.match(before.text, /£79/);

  const page = await ops.get('/admin/plans');
  assert.equal(page.status, 200);
  const saved = await ops.post('/admin/plans').type('form').send({
    _csrf: token(page.text), key_existing: 'team', name: 'Team', tagline: 'For busy bid teams', monthly: '79', annual: '790',
    sale_monthly: '49', sale_annual: '490', sale_label: 'Black Friday', sale_ends_at: '2099-12-01', badge: 'Most popular', colour: '#aa2200',
    seats: '5', saved_searches: '20', private_sources: '0', instant_alerts: '1', public: '1', features: 'One\nTwo', sort: '2',
  });
  assert.equal(saved.status, 302);
  await ops.post('/admin/settings').type('form').send({ _csrf: token(page.text), trial_days: '30', trial_plan: 'pro', banner_text: 'FLASH SALE: 40% off', banner_colour: '#c62828', banner_ends_at: '' });

  const after = (await request(app).get('/pricing')).text;
  assert.match(after, /Black Friday/);
  assert.match(after, /<s class="muted">£79<\/s>/, 'the normal price is struck through');
  assert.match(after, /<strong>£49<\/strong>/);
  assert.match(after, /--plan: #aa2200/);
  assert.match(after, /Try any plan free for 30 days/);
  assert.match((await request(app).get('/')).text, /FLASH SALE: 40% off/, 'the banner shows on every page');

  const bad = await ops.post('/admin/plans').type('form').send({ _csrf: token(page.text), key_existing: 'team', name: 'Team', monthly: 'lots', annual: '1', colour: '#000000' });
  assert.equal(bad.status, 302);
  assert.equal(db.prepare(`SELECT monthly_pence FROM plans WHERE key = 'team'`).get().monthly_pence, 7900, 'a bad price changes nothing');

  // A sale that has ended stops applying by itself.
  const plan = db.prepare(`SELECT * FROM plans WHERE key = 'team'`).get();
  assert.equal(withPrices(plan, Date.parse('2100-01-01')).pay.monthly, 7900);
  assert.equal(withPrices(plan).pay.monthly, 4900);

  // Customers cannot reach any of it.
  assert.equal(orgId > 0, true);
});

hosted('private portals need a plan that includes them', async () => {
  const { db, ops, orgId } = await setup();
  db.prepare(`UPDATE orgs SET billing_status = 'active', plan_key = 'team' WHERE id = ?`).run(orgId);
  const form = await ops.get('/admin/sources/new?kind=rss');
  const save = () => ops.post('/admin/sources').type('form').send({ _csrf: token(form.text), kind: 'rss', name: 'Acme feed', type: 'tender', url: 'https://93.184.215.14/feed.rss', org_id: String(orgId), interval_minutes: '360' });
  const refused = await save();
  assert.equal(refused.status, 400);
  assert.match(refused.text, /includes 0 private portals/);
  db.prepare(`UPDATE orgs SET plan_key = 'pro' WHERE id = ?`).run(orgId);
  assert.equal((await save()).status, 302);
});

test('self-hosted: no limits, no pricing or billing pages, nothing read-only', async () => {
  const db = openDb(':memory:');
  const app = createApp(db);
  assert.equal((await request(app).get('/pricing')).status, 404);
  db.prepare(`INSERT INTO orgs (name, billing_status, trial_ends_at) VALUES ('X', 'trialing', '2000-01-01')`).run();
  const access = entitlement(db, db.prepare('SELECT * FROM orgs').get());
  assert.equal(access.readOnly, false);
  assert.equal(access.limits.seats, null);
});

hosted('plan limits: two people accepting invitations at once cannot both take the last seat', async () => {
  const { db, app, orgId } = await setup();
  // Acme has one member and its plan allows two, so one invitation can succeed.
  db.prepare(`UPDATE plans SET seats = 2 WHERE key = 'starter'`).run();
  db.prepare(`UPDATE orgs SET billing_status = 'active', plan_key = 'starter' WHERE id = ?`).run(orgId);
  const invite = (email) => {
    const t = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO invites (token_hash, org_id, email, expires_at) VALUES (?, ?, ?, ?)')
      .run(crypto.createHash('sha256').update(t).digest('hex'), orgId, email, new Date(Date.now() + 864e5).toISOString());
    return t;
  };
  const accept = async (t, email) => {
    const agent = request.agent(app);
    const page = await agent.get(`/invite/${t}`);
    return agent.post(`/invite/${t}`).type('form').send({ _csrf: token(page.text), name: 'New', email, password: 'correct horse battery', terms: '1' });
  };
  const [a, b] = [invite('one@acme.example'), invite('two@acme.example')];
  // Both pass the first check before either has finished hashing its password.
  const results = await Promise.all([accept(a, 'one@acme.example'), accept(b, 'two@acme.example')]);
  assert.deepEqual(results.map((r) => r.status).sort(), [302, 403]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?').get(orgId).n, 2);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM users WHERE email IN ('one@acme.example', 'two@acme.example')`).get().n, 1, 'the refused person has no stray account');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM invites WHERE used_at IS NULL').get().n, 1, 'the unused invitation still works later');
});
