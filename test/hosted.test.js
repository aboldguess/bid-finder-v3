// Hosted mode: one server shared by many customer organisations.
import './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { config } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { createApp } from '../src/web/app.js';

const token = (html) => html.match(/name="_csrf" value="([^"]+)"/)[1];

async function signUp(app, email, { terms = '1', orgName = 'Acme' } = {}) {
  const agent = request.agent(app);
  const page = await agent.get('/register');
  const res = await agent.post('/register').type('form').send({
    _csrf: token(page.text), name: 'Pat', email, password: 'correct horse battery', orgName, ...(terms ? { terms } : {}),
  });
  return { agent, page, res };
}

// Runs a test with hosted mode on, and always turns it off again.
const hosted = (name, fn) => test(name, async () => {
  config.hosted = true;
  try { await fn(); } finally { config.hosted = false; }
});

hosted('hosted mode: anyone can sign up and each sign-up starts its own organisation', async () => {
  const db = openDb(':memory:');
  const app = createApp(db);
  const first = await signUp(app, 'phil@example.com', { orgName: 'Operator Ltd' });
  assert.equal(first.res.status, 302);
  assert.match(first.page.text, /name="terms"/, 'the form asks for consent');
  assert.match(first.page.text, /href="\/terms"/);

  // Sign-up stays open after the first account.
  const landing = await request(app).get('/');
  assert.match(landing.text, /Create your account/);
  const second = await signUp(app, 'ann@acme.example', { orgName: 'Acme' });
  const third = await signUp(app, 'bob@beta.example', { orgName: 'Beta' });
  assert.equal(second.res.headers.location, '/profile');
  assert.equal(third.res.headers.location, '/profile');

  const users = db.prepare(`
    SELECT u.email, u.is_platform_admin AS admin, u.terms_accepted_at AS terms, o.name AS org, m.role, o.plan
    FROM users u JOIN memberships m ON m.user_id = u.id JOIN orgs o ON o.id = m.org_id ORDER BY u.id
  `).all();
  assert.deepEqual(users.map((u) => [u.email, u.admin, u.org, u.role, u.plan]), [
    ['phil@example.com', 1, 'Operator Ltd', 'owner', 'trial'],
    ['ann@acme.example', 0, 'Acme', 'owner', 'trial'],
    ['bob@beta.example', 0, 'Beta', 'owner', 'trial'],
  ], 'only the first account is a platform administrator; every customer owns a separate trial organisation');
  assert.ok(users.every((u) => !Number.isNaN(Date.parse(u.terms))), 'consent time is stored for everyone');

  // Customers cannot reach the platform admin pages.
  assert.equal((await second.agent.get('/admin')).status, 403);
  const actions = db.prepare(`SELECT action FROM audit_log WHERE action = 'signup'`).all();
  assert.equal(actions.length, 3, 'each sign-up is audited');
});

hosted('hosted mode: sign-up without agreeing to the terms is refused', async () => {
  const db = openDb(':memory:');
  const app = createApp(db);
  const { res } = await signUp(app, 'pat@example.com', { terms: '' });
  assert.equal(res.status, 400);
  assert.match(res.text, /agree to the terms/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
});

hosted('hosted mode: the terms and privacy pages exist', async () => {
  const app = createApp(openDb(':memory:'));
  assert.equal((await request(app).get('/terms')).status, 200);
  assert.match((await request(app).get('/privacy')).text, /Privacy notice/);
});

test('self-hosted mode is unchanged: no consent tick, no legal pages, sign-up closes after the first account', async () => {
  assert.equal(config.hosted, false);
  const db = openDb(':memory:');
  const app = createApp(db);
  const { page, res } = await signUp(app, 'pat@example.com', { terms: '' });
  assert.doesNotMatch(page.text, /name="terms"/);
  assert.equal(res.status, 302);
  assert.equal(db.prepare('SELECT terms_accepted_at FROM users').get().terms_accepted_at, null);
  assert.equal((await request(app).get('/register')).status, 403);
  assert.equal((await request(app).get('/terms')).status, 404);
});
