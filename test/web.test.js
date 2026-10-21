import { fixture } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { openDb } from '../src/db/index.js';
import { runSource } from '../src/ingest/run.js';
import { createApp } from '../src/web/app.js';
import findAGrant from '../src/connectors/findAGrant.js';

const token = (html) => html.match(/name="_csrf" value="([^"]+)"/)[1];

async function signUp(agent, email, extra = {}) {
  const page = await agent.get('/register');
  return agent.post('/register').type('form').send({
    _csrf: token(page.text), name: 'Pat', email, password: 'correct horse battery', orgName: 'Acme', kind: 'company', ...extra,
  });
}

async function setup() {
  const db = openDb(':memory:');
  const app = createApp(db);
  await runSource(db, findAGrant, { get: async () => fixture('find-a-grant.html'), delayMs: 0 });
  return { db, app };
}

test('sign-up creates an org, makes the first user platform admin, and opens the profile', async () => {
  const { db, app } = await setup();
  const agent = request.agent(app);
  const res = await signUp(agent, 'pat@example.com');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/profile');
  assert.equal(db.prepare('SELECT is_platform_admin FROM users').get().is_platform_admin, 1);

  const second = request.agent(app);
  await signUp(second, 'sam@example.com', { orgName: 'Hub Co', kind: 'hub' });
  assert.equal(db.prepare(`SELECT is_platform_admin FROM users WHERE email = 'sam@example.com'`).get().is_platform_admin, 0);
  assert.equal((await second.get('/admin')).status, 403);
  assert.equal((await agent.get('/admin')).status, 200);
});

test('profile drives the ranked feed', async () => {
  const { app } = await setup();
  const agent = request.agent(app);
  await signUp(agent, 'pat@example.com');
  const page = await agent.get('/profile');
  const saved = await agent.post('/profile').type('form').send({
    _csrf: token(page.text), keywords: 'manufacturing\nAI', regions: 'South East England', types: 'grant',
    min_score: '20', digest_frequency: 'weekly', digest_emails: 'pat@example.com\nnot-an-email',
  });
  assert.equal(saved.headers.location, '/feed');
  const feed = await agent.get('/feed');
  assert.equal(feed.status, 200);
  assert.match(feed.text, /Smart Manufacturing Accelerator/);
  assert.match(feed.text, /Title mentions &#34;manufacturing&#34;/);
  assert.doesNotMatch(feed.text, /Rural Community Fund/);
});

test('state changes need the CSRF token', async () => {
  const { db, app } = await setup();
  const agent = request.agent(app);
  await signUp(agent, 'pat@example.com');
  const id = db.prepare('SELECT id FROM opportunities LIMIT 1').get().id;
  assert.equal((await agent.post(`/o/${id}/state`).send({ starred: true })).status, 403);
  const page = await agent.get('/feed');
  const csrf = page.text.match(/data-csrf="([^"]+)"/)[1];
  const ok = await agent.post(`/o/${id}/state`).set('X-CSRF-Token', csrf).send({ starred: true });
  assert.equal(ok.status, 200);
  assert.equal(db.prepare('SELECT starred FROM org_opportunity_state WHERE opportunity_id = ?').get(id).starred, 1);
});

test('login rejects bad passwords and accepts good ones; pages need sign-in', async () => {
  const { app } = await setup();
  await signUp(request.agent(app), 'pat@example.com');
  assert.equal((await request(app).get('/feed')).headers.location, '/login?next=%2Ffeed');
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const bad = await agent.post('/login').type('form').send({ _csrf: token(page.text), email: 'pat@example.com', password: 'nope' });
  assert.equal(bad.status, 401);
  const good = await agent.post('/login').type('form').send({ _csrf: token(bad.text), email: 'PAT@example.com', password: 'correct horse battery', next: '//evil.example' });
  assert.equal(good.headers.location, '/feed');
});

test('shared shortlist is public, read-only, and can be turned off', async () => {
  const { db, app } = await setup();
  const agent = request.agent(app);
  await signUp(agent, 'pat@example.com');
  const id = db.prepare('SELECT id FROM opportunities ORDER BY id LIMIT 1').get().id;
  const feed = await agent.get('/feed?view=starred');
  const csrf = token(feed.text);
  await agent.post(`/o/${id}/state`).type('form').send({ _csrf: csrf, starred: '1', back: '/feed' });
  await agent.post('/share').type('form').send({ _csrf: csrf, enable: '1' });
  const shareToken = db.prepare('SELECT share_token FROM orgs').get().share_token;
  const pub = await request(app).get(`/s/${shareToken}`);
  assert.equal(pub.status, 200);
  assert.match(pub.text, /Smart Manufacturing Accelerator/);
  assert.doesNotMatch(pub.text, /data-action=/);
  await agent.post('/share').type('form').send({ _csrf: csrf, enable: '0' });
  assert.equal((await request(app).get(`/s/${shareToken}`)).status, 404);
});

test('a digest can be built on demand and read back', async () => {
  const { app } = await setup();
  const agent = request.agent(app);
  await signUp(agent, 'pat@example.com');
  const page = await agent.get('/digests');
  await agent.post('/digests/now').type('form').send({ _csrf: token(page.text) });
  const list = await agent.get('/digests');
  const link = list.text.match(/href="(\/digests\/\d+)"/)[1];
  assert.match((await agent.get(link)).text, /New opportunities for Acme/);
});
