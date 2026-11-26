// Onboarding: from hosted sign-up to a ranked feed in three quick choices.
import './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { config } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { saveOpportunities } from '../src/ingest/run.js';
import { mergePresets, presets } from '../src/match/presets.js';
import { createApp } from '../src/web/app.js';
import { draftProfile } from '../src/web/routes/welcome.js';

const token = (html) => html.match(/name="_csrf" value="([^"]+)"/)[1];
const open = (fields) => ({ url: 'https://e.example', closes_at: '2099-01-01T00:00:00Z', country: 'GB', ...fields });

function seed(db) {
  saveOpportunities(db, { key: 'find-a-tender', type: 'tender' }, [
    open({ external_id: 'c1', title: 'Highways bridge inspection and drainage design', cpv_codes: '71311000' }),
    open({ external_id: 'c2', title: 'Structural engineering framework for school buildings', cpv_codes: '71312000' }),
    open({ external_id: 'f1', title: 'Hospital catering supplies', cpv_codes: '15000000' }),
    open({ external_id: 'ie1', title: 'Civil engineering works, Cork harbour', country: 'IE', cpv_codes: '45221000' }),
  ]);
}

async function hostedSignUp(app, email = 'pat@civils.example') {
  const agent = request.agent(app);
  const page = await agent.get('/register');
  const res = await agent.post('/register').type('form').send({ _csrf: token(page.text), name: 'Pat', email, password: 'correct horse battery', orgName: 'Civils Ltd', terms: '1' });
  return { agent, res };
}

const withHosted = (name, fn) => test(name, async () => {
  config.hosted = true;
  try { await fn(); } finally { config.hosted = false; }
});

withHosted('onboarding: sign up, pick a sector, see the count live, and land on a ranked feed', async () => {
  const db = openDb(':memory:');
  const app = createApp(db);
  seed(db);
  // The first account on a server is the operator's; customers come after.
  await hostedSignUp(app, 'operator@example.com');
  const started = Date.now();
  const { agent, res } = await hostedSignUp(app);
  assert.equal(res.headers.location, '/welcome');

  const welcome = await agent.get('/welcome');
  assert.equal(welcome.status, 200);
  assert.match(welcome.text, /Let's find your first bids/);
  assert.match(welcome.text, /watching 4 open contracts/);
  for (const p of presets) assert.ok(welcome.text.includes(`value="${p.id}"`), `offers ${p.label}`);

  const none = await agent.get('/welcome/preview?countries=GB&types=tender');
  assert.deepEqual(none.body, { total: 0, top: [] }, 'nothing picked yet');
  const civil = await agent.get('/welcome/preview?presets=civil&countries=GB&types=tender&types=grant');
  assert.equal(civil.body.total, 2, 'the two UK civil notices, not catering, not Ireland');
  assert.match(civil.body.top[0].title, /bridge|Structural/i);
  const ireland = await agent.get('/welcome/preview?presets=civil&countries=GB,IE&types=tender');
  assert.equal(ireland.body.total, 3);
  const user = db.prepare(`SELECT org_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'pat@civils.example'`).get();
  assert.equal(db.prepare('SELECT keywords FROM profiles WHERE org_id = ?').get(user.org_id).keywords, '', 'previewing saves nothing');

  const saved = await agent.post('/welcome').type('form').send({ _csrf: token(welcome.text), presets: ['civil'], keywords: 'school buildings', countries: 'GB', types: ['tender', 'grant'] });
  assert.equal(saved.headers.location, '/feed');
  const profile = db.prepare('SELECT * FROM profiles WHERE org_id = ?').get(user.org_id);
  assert.match(profile.keywords, /^school buildings\ncivil engineering\n/);
  assert.match(profile.cpv_codes, /71311/);
  assert.equal(profile.countries, 'GB');
  assert.equal(profile.digest_emails, 'pat@civils.example');

  const feed = await agent.get('/feed');
  assert.match(feed.text, /Your feed is ready: 2 open opportunities match/);
  assert.ok(feed.text.indexOf('Highways bridge') > 0 && !feed.text.includes('Hospital catering'));
  assert.ok(!feed.text.includes('Your feed is not personalised yet'));
  assert.ok(Date.now() - started < 5000, 'the whole flow is a handful of quick requests');
  assert.ok(db.prepare(`SELECT 1 FROM audit_log WHERE action = 'onboarding' AND detail LIKE 'civil; 2 matches'`).get());
});

withHosted('onboarding: saving with nothing picked asks again, and other organisations\' private notices never show', async () => {
  const db = openDb(':memory:');
  const app = createApp(db);
  seed(db);
  await hostedSignUp(app, 'operator@example.com');
  const other = await hostedSignUp(app, 'rival@example.com');
  const orgB = db.prepare(`SELECT org_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'rival@example.com'`).get().org_id;
  db.prepare(`INSERT INTO sources (key, name, kind, type, org_id) VALUES ('custom-rival', 'Rival portal', 'portal', 'tender', ?)`).run(orgB);
  saveOpportunities(db, { key: 'custom-rival', type: 'tender' }, [open({ external_id: 'p1', title: 'Private bridge maintenance framework' })]);
  assert.equal((await other.agent.get('/welcome/preview?presets=civil&countries=GB&types=tender')).body.total, 3, 'the owner sees its own');

  const { agent } = await hostedSignUp(app);
  const preview = await agent.get('/welcome/preview?presets=civil&countries=GB&types=tender');
  assert.equal(preview.body.total, 2);
  assert.ok(!JSON.stringify(preview.body).includes('Private bridge'));

  const page = await agent.get('/welcome');
  const empty = await agent.post('/welcome').type('form').send({ _csrf: token(page.text), countries: 'GB', types: 'tender' });
  assert.equal(empty.headers.location, '/welcome');
  assert.match((await agent.get('/welcome')).text, /Pick at least one kind of work/);
});

test('onboarding: self-hosted sign-up still goes to the full profile page', async () => {
  const app = createApp(openDb(':memory:'));
  const agent = request.agent(app);
  const page = await agent.get('/register');
  const res = await agent.post('/register').type('form').send({ _csrf: token(page.text), name: 'Sam', email: 'sam@example.com', password: 'correct horse battery', orgName: 'Self Ltd' });
  assert.equal(res.headers.location, '/profile');
});

test('presets: merging keeps what is there, adds each item once, and ignores unknown ids', () => {
  const merged = mergePresets(['civil', 'construction', 'nonsense'], { keywords: 'Bridge\nCivil Engineering', cpv_codes: '45' });
  const lines = merged.keywords.split('\n');
  assert.deepEqual(lines.slice(0, 2), ['Bridge', 'Civil Engineering']);
  assert.equal(lines.filter((l) => l.toLowerCase() === 'civil engineering').length, 1);
  assert.ok(lines.includes('refurbishment'));
  assert.equal(merged.cpv_codes.split('\n').filter((c) => c === '45').length, 1);
  assert.ok(presets.every((p) => p.cpv.every((c) => /^\d{2,8}$/.test(c)) && p.keywords.length >= 5), 'every preset is well-formed');
  assert.equal(new Set(presets.map((p) => p.id)).size, presets.length);
  const draft = draftProfile({ keywords: '', cpv_codes: '' }, { presets: 'rd', countries: 'gb,XX1', types: 'bogus' });
  assert.equal(draft.countries, 'GB');
  assert.equal(draft.types, 'tender\ngrant', 'no valid type picked means both');
});
