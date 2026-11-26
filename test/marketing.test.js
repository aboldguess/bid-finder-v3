// The public face of a hosted service: home page, pricing, footer and search engines.
import './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { config } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { setSetting } from '../src/billing/plans.js';
import { createApp } from '../src/web/app.js';

const hosted = (name, fn) => test(name, async () => {
  config.hosted = true;
  try { await fn(); } finally { config.hosted = false; config.supportEmail = ''; }
});

hosted('home page: sells the service with live sources, plans, an example and a trial button', async () => {
  const db = openDb(':memory:');
  const app = createApp(db);
  db.prepare(`INSERT INTO orgs (name) VALUES ('Acme')`).run();
  db.prepare(`INSERT INTO sources (key, name, kind, type, org_id) VALUES ('custom-secret', 'Secret Supplier Portal', 'portal', 'tender', 1)`).run();
  db.prepare(`UPDATE plans SET monthly_pence = 3900 WHERE key = 'starter'`).run();
  setSetting(db, 'trial_days', '21');

  const res = await request(app).get('/');
  assert.equal(res.status, 200);
  assert.match(res.text, /Start your free 21-day trial/);
  assert.match(res.text, /<meta name="description" content="[^"]*Free for 21 days/);
  assert.match(res.text, /<li>Find a Tender \(GOV\.UK\)<\/li>/, 'names the public sources');
  assert.ok(!res.text.includes('Secret Supplier Portal'), 'never a customer\'s private portal');
  assert.match(res.text, /£39/, 'prices come from the plans table');
  assert.match(res.text, /Most popular/);
  assert.match(res.text, /with the Team plan(&#39;|')s features/);
  assert.match(res.text, /hydraulic test rig/, 'shows an example match');
  assert.match(res.text, /href="\/terms"/);
  assert.ok(!res.text.includes('self-hosted'), 'no self-hosted wording on the hosted site');

  config.supportEmail = 'help@bids.example';
  assert.match((await request(app).get('/pricing')).text, /mailto:help@bids\.example/);
});

hosted('search engines: the public pages are indexed, nothing behind sign-in', async () => {
  const app = createApp(openDb(':memory:'));
  const robots = await request(app).get('/robots.txt');
  assert.match(robots.text, /Allow: \/pricing/);
  assert.match(robots.text, /Disallow: \/\n/);
  assert.match(robots.text, /Sitemap: .*\/sitemap\.xml/);
  const sitemap = await request(app).get('/sitemap.xml');
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.text, /<loc>[^<]*\/pricing<\/loc>/);
});

test('self-hosted: the landing page, footer and robots are as before', async () => {
  const app = createApp(openDb(':memory:'));
  const res = await request(app).get('/');
  assert.match(res.text, /Self-hosted tender monitoring/);
  assert.match(res.text, /self-hosted tender and grant monitoring/);
  assert.equal((await request(app).get('/robots.txt')).text, 'User-agent: *\nDisallow: /\n');
  assert.equal((await request(app).get('/sitemap.xml')).status, 404);
});
