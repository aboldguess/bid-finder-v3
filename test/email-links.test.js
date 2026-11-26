// Email verification and password reset by single-use links.
import './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { config } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { createApp } from '../src/web/app.js';
import { createUser } from '../src/users.js';
import { runDigests } from '../src/notify/digest.js';

const token = (html) => html.match(/name="_csrf" value="([^"]+)"/)[1];
const linkIn = (mail, kind) => mail.html.match(new RegExp(`/${kind}/[\\w-]+`))[0];

function setup() {
  const db = openDb(':memory:');
  const outbox = [];
  const app = createApp(db, { mail: async (m) => { outbox.push(m); } });
  return { db, app, outbox };
}

const hosted = (name, fn) => test(name, async () => {
  config.hosted = true;
  try { await fn(); } finally { config.hosted = false; }
});

async function signUp(app, email) {
  const agent = request.agent(app);
  const page = await agent.get('/register');
  await agent.post('/register').type('form').send({ _csrf: token(page.text), name: 'Pat', email, password: 'correct horse battery', orgName: 'Acme', terms: '1' });
  return agent;
}

hosted('hosted sign-up sends a confirmation link; until it is used, no digests go out', async () => {
  const { db, app, outbox } = setup();
  await signUp(app, 'admin@example.com'); // the operator, first account
  const agent = await signUp(app, 'pat@acme.example');
  const mail = outbox.find((m) => m.to[0] === 'pat@acme.example');
  assert.match(mail.subject, /Confirm your email/);
  const user = () => db.prepare(`SELECT * FROM users WHERE email = 'pat@acme.example'`).get();
  assert.equal(user().email_verified_at, null);
  assert.match((await agent.get('/dashboard')).text, /Please confirm your email address/);

  const org = db.prepare(`SELECT org_id FROM memberships WHERE user_id = ?`).get(user().id).org_id;
  db.prepare(`INSERT INTO opportunities (source_key, external_id, type, title, url) VALUES ('find-a-tender', 'x', 'tender', 'Anything', 'https://e.example')`).run();
  db.prepare(`UPDATE profiles SET min_score = 0 WHERE org_id = ?`).run(org);
  assert.ok(!(await runDigests(db)).some((r) => r.org === org), 'an unconfirmed organisation gets no digest');

  const link = linkIn(mail, 'verify');
  const used = await agent.get(link);
  assert.equal(used.headers.location, '/dashboard');
  assert.ok(user().email_verified_at);
  assert.doesNotMatch((await agent.get('/dashboard')).text, /Please confirm your email address/);
  assert.equal((await agent.get(link)).status, 400, 'a link works once');
  assert.ok((await runDigests(db)).some((r) => r.org === org), 'once confirmed, digests flow');
});

hosted('a new confirmation link can be requested, and replaces the old one', async () => {
  const { app, outbox } = setup();
  await signUp(app, 'admin@example.com');
  const agent = await signUp(app, 'pat@acme.example');
  const first = linkIn(outbox.at(-1), 'verify');
  const page = await agent.get('/dashboard');
  await agent.post('/account/verify').type('form').send({ _csrf: token(page.text) });
  const second = linkIn(outbox.at(-1), 'verify');
  assert.notEqual(first, second);
  assert.equal((await agent.get(first)).status, 400, 'the old link no longer works');
  assert.equal((await agent.get(second)).status, 302);
});

test('self-hosted sign-up needs no confirmation and sends nothing', async () => {
  const { db, app, outbox } = setup();
  const agent = await signUp(app, 'pat@example.com');
  assert.ok(db.prepare('SELECT email_verified_at FROM users').get().email_verified_at);
  assert.equal(outbox.length, 0);
  assert.doesNotMatch((await agent.get('/dashboard')).text, /Please confirm/);
});

test('password reset: a one-hour, single-use link that signs out other devices', async () => {
  const { db, app, outbox } = setup();
  await createUser(db, { email: 'pat@example.com', name: 'Pat', password: 'the old password', orgName: 'Acme' });
  const elsewhere = request.agent(app);
  const login = await elsewhere.get('/login');
  await elsewhere.post('/login').type('form').send({ _csrf: token(login.text), email: 'pat@example.com', password: 'the old password' });
  assert.equal((await elsewhere.get('/dashboard')).status, 200);

  const agent = request.agent(app);
  const forgot = await agent.get('/forgot');
  const sent = await agent.post('/forgot').type('form').send({ _csrf: token(forgot.text), email: 'PAT@example.com' });
  assert.match(sent.text, /If there is an account/);
  const link = linkIn(outbox.at(-1), 'reset');

  // An unknown address gets the same answer and no email.
  const unknown = await agent.post('/forgot').type('form').send({ _csrf: token(forgot.text), email: 'nobody@example.com' });
  assert.match(unknown.text, /If there is an account/);
  assert.equal(outbox.length, 1);

  const form = await agent.get(link);
  assert.equal(form.status, 200);
  const mismatch = await agent.post(link).type('form').send({ _csrf: token(form.text), password: 'a brand new password', confirm: 'something else' });
  assert.match(mismatch.text, /do not match/);
  const done = await agent.post(link).type('form').send({ _csrf: token(form.text), password: 'a brand new password', confirm: 'a brand new password' });
  assert.equal(done.headers.location, '/dashboard');
  assert.equal((await agent.get('/dashboard')).status, 200, 'signed straight in');
  assert.equal((await elsewhere.get('/dashboard')).status, 302, 'the other device was signed out');
  assert.equal((await request(app).get(link)).status, 400, 'a link works once');

  const again = request.agent(app);
  const page = await again.get('/login');
  assert.equal((await again.post('/login').type('form').send({ _csrf: token(page.text), email: 'pat@example.com', password: 'a brand new password' })).headers.location, '/dashboard');
  assert.deepEqual(db.prepare(`SELECT action FROM audit_log WHERE action LIKE 'password.reset%' ORDER BY id`).all().map((r) => r.action), ['password.reset.requested', 'password.reset']);
});

test('password reset: links expire, and die if the email changes', async () => {
  const { db, app } = setup();
  const { issueEmailToken, checkEmailToken } = await import('../src/users.js');
  await createUser(db, { email: 'pat@example.com', name: 'Pat', password: 'the old password', orgName: 'Acme' });
  const user = db.prepare('SELECT * FROM users').get();
  const t = issueEmailToken(db, user, 'reset', { now: Date.now() - 2 * 3600e3 });
  assert.equal(checkEmailToken(db, t, 'reset'), null, 'two hours old: expired');
  const fresh = issueEmailToken(db, user, 'reset');
  assert.ok(checkEmailToken(db, fresh, 'reset'));
  assert.equal(checkEmailToken(db, fresh, 'verify'), null, 'a reset link cannot confirm an email');
  db.prepare(`UPDATE users SET email = 'new@example.com'`).run();
  assert.equal(checkEmailToken(db, fresh, 'reset'), null);
  assert.equal((await request(app).get(`/reset/${fresh}`)).status, 400);
});

test('password reset: at most 3 emails an hour per account', async () => {
  const { db, app, outbox } = setup();
  await createUser(db, { email: 'pat@example.com', name: 'Pat', password: 'the old password', orgName: 'Acme' });
  const agent = request.agent(app);
  const page = await agent.get('/forgot');
  for (let i = 0; i < 5; i++) await agent.post('/forgot').type('form').send({ _csrf: token(page.text), email: 'pat@example.com' });
  assert.equal(outbox.length, 3);
});

test('without email set up, the forgotten-password page says to ask the administrator', async () => {
  const app = createApp(openDb(':memory:'));
  const page = await request(app).get('/forgot');
  assert.match(page.text, /bidfinder reset-password/);
  assert.match((await request(app).get('/login')).text, /href="\/forgot"/);
});
