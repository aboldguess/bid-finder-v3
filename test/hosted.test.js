// Hosted mode: one server shared by many customer organisations.
import './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { config } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { createApp } from '../src/web/app.js';

const token = (html) => html.match(/name="_csrf" value="([^"]+)"/)[1];

async function signUp(app, email, { terms = '1', orgName = 'Acme', ...extra } = {}) {
  const agent = request.agent(app);
  const page = await agent.get('/register');
  const res = await agent.post('/register').type('form').send({
    _csrf: token(page.text), name: 'Pat', email, password: 'correct horse battery', orgName, ...(terms ? { terms } : {}), ...extra,
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
  assert.match(landing.text, /Start your free 14-day trial/);
  const second = await signUp(app, 'ann@acme.example', { orgName: 'Acme' });
  const third = await signUp(app, 'bob@beta.example', { orgName: 'Beta' });
  assert.equal(second.res.headers.location, '/welcome');
  assert.equal(third.res.headers.location, '/welcome');

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

// --- Abuse protection -----------------------------------------------------

hosted('sign-up: a filled honeypot or a form sent too fast creates nothing', async () => {
  const db = openDb(':memory:');
  const app = createApp(db);
  const page = await request.agent(app).get('/register');
  assert.match(page.text, /name="website"/, 'the honeypot is on the form');

  const bot = await signUp(app, 'bot@spam.example', { website: 'http://spam.example' });
  assert.equal(bot.res.status, 400);
  assert.match(bot.res.text, /Something went wrong with that form/);

  const before = config.signupMinSeconds;
  config.signupMinSeconds = 3;
  try {
    const fast = await signUp(app, 'fast@spam.example');
    assert.equal(fast.res.status, 400, 'sent instantly, so treated as a bot');
  } finally { config.signupMinSeconds = before; }

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
  assert.deepEqual(db.prepare(`SELECT detail FROM audit_log WHERE action = 'signup.bot' ORDER BY id`).all().map((r) => r.detail.split(' ')[0]), ['honeypot', 'too-fast']);
});

hosted('sign-up: one address can make 5 accounts a day and 10 attempts an hour', async () => {
  const db = openDb(':memory:');
  const app = createApp(db);
  for (let i = 0; i < 5; i++) assert.equal((await signUp(app, `user${i}@example.com`, { orgName: `Org ${i}` })).res.status, 302);
  const sixth = await signUp(app, 'user5@example.com', { orgName: 'Org 5' });
  assert.equal(sixth.res.status, 429);
  assert.ok(Number(sixth.res.headers['retry-after']) > 3600, 'told to come back much later');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 5);

  // Sent all at once, they cannot all pass the check while passwords are being hashed.
  const db3 = openDb(':memory:');
  const app3 = createApp(db3);
  const burst = await Promise.all(Array.from({ length: 8 }, (_, i) => signUp(app3, `burst${i}@example.com`, { orgName: `Burst ${i}` })));
  assert.equal(burst.filter((b) => b.res.status === 302).length, 5);
  assert.equal(db3.prepare('SELECT COUNT(*) AS n FROM users').get().n, 5, 'still five accounts a day');

  // Failed attempts count too, so a bot cannot keep guessing.
  const app2 = createApp(openDb(':memory:'));
  for (let i = 0; i < 10; i++) assert.equal((await signUp(app2, 'not-an-email')).res.status, 400);
  assert.equal((await signUp(app2, 'real@example.com')).res.status, 429);
});

test('sign-in: one address is blocked after 30 failures across any emails', async () => {
  const db = openDb(':memory:');
  const app = createApp(db);
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const attempt = (email) => agent.post('/login').type('form').send({ _csrf: token(page.text), email, password: 'wrong password' });
  for (let i = 0; i < 30; i++) assert.equal((await attempt(`person${i}@example.com`)).status, 401);
  const blocked = await attempt('someone-new@example.com');
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers['retry-after']);
  assert.match(blocked.text, /Too many failed sign-ins/);
});

test('rate limiter: counts per key and resets after its window', async () => {
  const { createLimiter } = await import('../src/web/security.js');
  let t = 0;
  const limit = createLimiter({ max: 2, windowMs: 1000, now: () => t });
  limit.hit('a'); limit.hit('a');
  assert.equal(limit.retryAfter('a'), 1);
  assert.equal(limit.retryAfter('b'), 0, 'other keys are unaffected');
  t = 1000;
  assert.equal(limit.retryAfter('a'), 0, 'the window has passed');
});
