// Tests for the tender platform: new connectors, HTTP politeness, the
// credential vault, dedupe, CPV scoring, alerts, the API and operations.
import { fixture } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import request from 'supertest';
import { openDb } from '../src/db/index.js';
import { createHttp, redact, resetHttpState, createJar } from '../src/http/client.js';
import { parseRobots, robotsDecision } from '../src/http/robots.js';
import { assertPublicUrl, isPrivateAddress } from '../src/http/ssrf.js';
import { decrypt, encrypt, loadCredential, saveCredential } from '../src/secrets/vault.js';
import findATender, { mapReleases, parsePage as parseFts } from '../src/connectors/findATender.js';
import { publicContractsScotland } from '../src/connectors/proactis.js';
import ted, { parsePage as parseTed } from '../src/connectors/ted.js';
import samGov, { parsePage as parseSam } from '../src/connectors/samGov.js';
import { parseFeed, rssConnector } from '../src/connectors/rss.js';
import { buildLogin, parseListing, portalConnector } from '../src/connectors/portal.js';
import { connectors } from '../src/connectors/index.js';
import { dedupeKey, ensureSources, prune, runAll, runSource, saveOpportunities } from '../src/ingest/run.js';
import { getFeed, setState } from '../src/match/feed.js';
import { cpvPrefix, scoreOpportunity } from '../src/match/score.js';
import { baseline, runAlerts } from '../src/notify/alerts.js';
import { slackPayload } from '../src/notify/channels.js';
import { backup } from '../src/scheduler.js';
import { listen } from '../src/listen.js';
import { createApp } from '../src/web/app.js';

const now = Date.parse('2026-11-01T12:00:00Z');
const res = (body, { status = 200, headers = {} } = {}) => new Response(body, { status, headers });

// --- HTTP client -------------------------------------------------------------

test('robots.txt: longest rule wins, Allow beats Disallow on a tie, wildcards work', () => {
  const groups = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/open\nDisallow: /*.pdf$\nCrawl-delay: 5\n\nUser-agent: BidFinder\nDisallow: /nobots');
  assert.equal(robotsDecision(groups, 'OtherBot', '/private/x').allowed, false);
  assert.equal(robotsDecision(groups, 'OtherBot', '/private/open/1').allowed, true);
  assert.equal(robotsDecision(groups, 'OtherBot', '/docs/a.pdf').allowed, false);
  assert.equal(robotsDecision(groups, 'OtherBot', '/docs/a.pdf?x=1').allowed, true);
  assert.equal(robotsDecision(groups, 'OtherBot', '/').crawlDelay, 5);
  // Our own group replaces the wildcard group entirely.
  assert.equal(robotsDecision(groups, 'BidFinder', '/private/x').allowed, true);
  assert.equal(robotsDecision(groups, 'BidFinder', '/nobots/1').allowed, false);
});

test('http client: honours robots.txt, retries with Retry-After, identifies itself', async () => {
  resetHttpState();
  const calls = [];
  const waits = [];
  let failures = 2;
  const fetchImpl = async (url, opts) => {
    calls.push({ url, ua: opts.headers['User-Agent'] });
    if (url.endsWith('/robots.txt')) return res('User-agent: *\nDisallow: /secret');
    if (failures-- > 0) return res('slow down', { status: 429, headers: { 'retry-after': '7' } });
    return res('hello');
  };
  const client = createHttp({ fetchImpl, respectRobots: true, minDelayMs: 0, sleep: async (ms) => { waits.push(ms); }, userAgent: 'BidFinder/test' });
  assert.equal(await client.get('https://portal.example/list'), 'hello');
  assert.deepEqual(waits.filter((w) => w === 7000).length, 2, 'waited as long as the server asked, twice');
  assert.ok(calls.every((c) => c.ua === 'BidFinder/test'));
  await assert.rejects(client.get('https://portal.example/secret/1'), /robots\.txt/);
  assert.equal(calls.filter((c) => c.url.endsWith('/robots.txt')).length, 1, 'robots.txt is cached');
});

test('http client: a robots.txt that fails with a server error means stay away, and says why', async () => {
  resetHttpState();
  const fetchImpl = async (url) => (url.endsWith('/robots.txt')
    ? { ok: false, status: 500, redirected: true, url: 'https://auth.portal.example/sso', text: async () => 'oops' }
    : res('page'));
  const client = createHttp({ fetchImpl, respectRobots: true, minDelayMs: 0 });
  await assert.rejects(client.get('https://portal.example/search'), /disallows \/search \(its robots\.txt could not be read: HTTP 500 after a redirect to auth\.portal\.example/);
});

test('http client: spaces out requests to the same host', async () => {
  resetHttpState();
  const waits = [];
  const client = createHttp({ fetchImpl: async () => res('ok'), minDelayMs: 5000, sleep: async (ms) => { waits.push(ms); } });
  await client.get('https://a.example/1');
  await client.get('https://a.example/2');
  await client.get('https://b.example/1');
  assert.equal(waits.length, 1);
  assert.ok(waits[0] > 4000 && waits[0] <= 5000);
});

test('http client: gives up after retries and keeps API keys out of the error', async () => {
  resetHttpState();
  const client = createHttp({ fetchImpl: async () => res('no', { status: 503 }), minDelayMs: 0, retries: 2, sleep: async () => {} });
  await assert.rejects(client.get('https://api.example/x?api_key=SECRET123&limit=1'), (err) => {
    assert.equal(err.status, 503);
    assert.doesNotMatch(err.message, /SECRET123/);
    return true;
  });
  assert.equal(redact('https://x/y?a=1&token=abc&b=2'), 'https://x/y?a=1&token=***&b=2');
});

test('private-network guard blocks internal addresses, including via DNS and redirects', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
  await assert.rejects(assertPublicUrl('http://169.254.169.254/latest/meta-data'), /private network/);
  await assert.rejects(assertPublicUrl('file:///etc/passwd'), /http and https/);
  const lookup = async (host) => (host === 'evil.example' ? [{ address: '10.0.0.7' }] : [{ address: '93.184.216.34' }]);
  await assert.rejects(assertPublicUrl('https://evil.example/', { lookup }), /private network/);
  resetHttpState();
  const client = createHttp({ guard: true, lookup, minDelayMs: 0, fetchImpl: async () => res('', { status: 302, headers: { location: 'http://evil.example/admin' } }) });
  await assert.rejects(client.get('https://good.example/'), /private network/);
});

// --- Vault ---------------------------------------------------------------------

test('vault: round-trips, never stores plaintext, and detects tampering', () => {
  const db = openDb(':memory:');
  const id = saveCredential(db, { name: 'Portal login', kind: 'login', secret: { username: 'pat', password: 'hunter2-very-secret' } });
  const stored = db.prepare('SELECT secret FROM credentials WHERE id = ?').get(id).secret;
  assert.doesNotMatch(stored, /hunter2|pat/);
  assert.deepEqual(loadCredential(db, id), { id, name: 'Portal login', kind: 'login', username: 'pat', password: 'hunter2-very-secret' });
  assert.notEqual(encrypt('same'), encrypt('same'), 'a fresh nonce every time');
  const parts = encrypt({ a: 1 }).split(':');
  parts[3] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => decrypt(parts.join(':')), /Could not decrypt/);
});

// --- Connectors ------------------------------------------------------------------

test('Find a Tender: maps OCDS releases, keeps the latest per procurement, drops closed ones', () => {
  const { releases, next } = parseFts(fixture('find-a-tender.json'));
  assert.match(next, /cursor=/);
  const items = mapReleases(releases);
  assert.equal(items.length, 1, 'one open procurement out of three releases');
  const [t] = items;
  assert.equal(t.external_id, 'ocds-h6vhtk-0aaa01');
  assert.equal(t.title, 'Hydraulic test rig design and build (updated)');
  assert.equal(t.url, 'https://www.find-tender.service.gov.uk/Notice/012346-2026');
  assert.equal(t.funder, 'Network Rail Infrastructure Ltd');
  assert.equal(t.cpv_codes, '71333000 42000000');
  assert.equal(t.award_max, 1850000);
  assert.equal(t.currency, 'GBP');
  assert.equal(t.country, 'GB');
  assert.equal(t.closes_at, '2099-12-08T12:00:00.000Z');
  assert.match(t.eligibility, /Suitable for SMEs; 71333000 Mechanical engineering services/);
});

test('Find a Tender: follows the cursor, asks only for what changed since the last run', async () => {
  const urls = [];
  const page2 = JSON.stringify({ releases: [] });
  const items = await findATender.fetch({
    now, since: '2026-10-31T06:00:00.000Z',
    get: async (url) => { urls.push(url); return urls.length === 1 ? fixture('find-a-tender.json') : page2; },
  });
  assert.equal(urls.length, 2);
  assert.match(urls[0], /stages=tender&limit=100&updatedFrom=2026-10-31T05:00:00&updatedTo=2026-11-01T12:00:00$/);
  assert.match(urls[1], /cursor=abc123/);
  assert.equal(items.length, 1);
});

test('Public Contracts Scotland: reads this month and last for each notice type', async () => {
  const urls = [];
  const pkg = JSON.stringify({ releases: [{ ocid: 'ocds-r6ebe6-0000700001', id: 'NOV500001', date: '2026-10-20T00:00:00Z', buyer: { name: 'Scottish Water' },
    tender: { title: 'Pump refurbishment framework', status: 'active', value: { amount: 400000, currency: 'GBP' }, tenderPeriod: { endDate: '2099-01-10T12:00:00Z' },
      classification: { scheme: 'CPV', id: '50511000' }, documents: [{ url: 'https://www.publiccontractsscotland.gov.uk/search/show/search_view.aspx?ID=NOV500001' }] } }] });
  const items = await publicContractsScotland.fetch({ now, delayMs: 0, get: async (url) => { urls.push(url); return pkg; } });
  assert.deepEqual(urls.map((u) => u.split('?')[1]), [
    'dateFrom=10-2026&noticeType=2&outputType=0', 'dateFrom=10-2026&noticeType=102&outputType=0',
    'dateFrom=11-2026&noticeType=2&outputType=0', 'dateFrom=11-2026&noticeType=102&outputType=0',
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].location, 'Scotland');
  assert.match(items[0].url, /search_view\.aspx\?ID=NOV500001/);
});

test('TED: reads multilingual values, pages by token, falls back if a field is refused', async () => {
  const { items, next } = parseTed(fixture('ted.json'));
  assert.equal(next, 'tok-2');
  const [n] = items;
  assert.equal(n.external_id, '712345-2026');
  assert.equal(n.title, 'Ireland-Dublin: Engineering design services');
  assert.equal(n.url, 'https://ted.europa.eu/en/notice/-/detail/712345-2026');
  assert.equal(n.funder, 'Irish Water');
  assert.equal(n.country, 'IE');
  assert.equal(n.cpv_codes, '71320000 71300000');
  assert.equal(n.award_max, 2500000);
  assert.equal(n.currency, 'EUR');
  assert.equal(n.closes_at, '2099-12-15T22:59:00.000Z');

  const bodies = [];
  const got = await ted.fetch({
    now, config: { query: 'classification-cpv IN (71000000)' },
    get: async (url, opts) => {
      const body = JSON.parse(opts.body);
      bodies.push(body);
      if (bodies.length === 1) throw Object.assign(new Error('HTTP 400'), { status: 400 });
      return body.iterationNextToken ? JSON.stringify({ notices: [] }) : fixture('ted.json');
    },
  });
  assert.equal(got.length, 2);
  assert.ok(bodies[0].fields.length > bodies[1].fields.length, 'retried with the core fields only');
  assert.match(bodies[1].query, /^notice-type IN \(cn-standard cn-social\) AND publication-date>=20261018 AND \(classification-cpv IN \(71000000\)\)$/);
  assert.equal(bodies[2].iterationNextToken, 'tok-2');
});

test('SAM.gov: needs a key from the vault, skips awards, never leaks the key', async () => {
  await assert.rejects(samGov.fetch({ now, get: async () => '{}' }), /needs an API key/);
  const urls = [];
  const items = await samGov.fetch({ now, credential: { key: 'SAMKEY' }, config: { ncode: '541330' }, get: async (url) => { urls.push(url); return fixture('sam-gov.json'); } });
  assert.match(urls[0], /api_key=SAMKEY&postedFrom=10%2F25%2F2026&postedTo=11%2F01%2F2026&limit=1000&offset=0&ncode=541330/);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Engineering support services for test facility');
  assert.equal(items[0].country, 'US');
  assert.match(items[0].eligibility, /NAICS 541330/);
  assert.equal(parseSam(fixture('sam-gov.json')).total, 2);
});

test('RSS and Atom feeds: links, dates, deadlines and values from the text', () => {
  const rss = parseFeed(`<?xml version="1.0"?><rss><channel>
    <item><title>Supply of control panels</title><link>/notices/77</link><guid>n-77</guid><pubDate>Mon, 26 Oct 2026 09:00:00 GMT</pubDate>
      <description>&lt;p&gt;Value £120,000. Closing date: 12 December 2099 at 12:00pm&lt;/p&gt;</description><category>Electrical</category></item>
    <item><title>No link here</title></item></channel></rss>`, { baseUrl: 'https://portal.example/feed.rss' });
  assert.equal(rss.length, 1);
  assert.deepEqual([rss[0].external_id, rss[0].url, rss[0].award_max, rss[0].closes_at, rss[0].eligibility], ['n-77', 'https://portal.example/notices/77', 120000, '2099-12-12T12:00:00.000Z', 'Electrical']);
  const atom = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Bridge bearings</title><id>urn:x:1</id>
    <link rel="alternate" href="https://portal.example/t/1"/><updated>2026-10-30T10:00:00Z</updated><summary>Deadline 2099-03-01</summary></entry></feed>`);
  assert.deepEqual([atom[0].url, atom[0].closes_at, atom[0].published_at], ['https://portal.example/t/1', '2099-03-01T23:59:00.000Z', '2026-10-30T10:00:00.000Z']);
  assert.equal(rssConnector({ key: 'custom-x', name: 'X', config: { url: 'https://portal.example/feed' } }).respectRobots, true);
});

// A tiny private portal: a login form with a CSRF token, then a session cookie.
function fakePortal() {
  const seen = [];
  const LOGIN = '<form method="post" action="/session"><input type="hidden" name="csrf" value="tok123"><input type="email" name="user_email"><input type="password" name="user_pass"><button type="submit" name="go" value="1">Sign in</button></form>';
  const LIST = (page) => `<table><tbody>${page === 1
    ? '<tr class="opp"><td><a class="t" href="/opps/501">Conveyor controls upgrade</a></td><td class="buyer">Acme Logistics</td><td class="close">14 January 2099</td><td class="val">£75,000</td></tr>'
    : '<tr class="opp"><td><a class="t" href="/opps/502">Gantry crane inspection</a></td><td class="buyer">Acme Ports</td><td class="close">20 February 2099</td><td class="val">£30k</td></tr>'}
    </tbody></table>${page === 1 ? '<a rel="next" href="/opps?page=2">Next</a>' : ''}`;
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    const cookie = opts.headers?.Cookie || '';
    seen.push(`${opts.method || 'GET'} ${u.pathname}${u.search}`);
    if (u.pathname === '/login') return res(LOGIN, { headers: { 'set-cookie': 'pre=1; Path=/' } });
    if (u.pathname === '/session') {
      const body = new URLSearchParams(opts.body);
      const ok = body.get('csrf') === 'tok123' && body.get('user_email') === 'pat@example.com' && body.get('user_pass') === 'right' && cookie.includes('pre=1');
      return ok ? res('', { status: 302, headers: { location: '/home', 'set-cookie': 'sid=abc; HttpOnly' } }) : res(LOGIN);
    }
    if (u.pathname === '/home') return res('<h1>Welcome</h1>');
    if (u.pathname === '/opps') return cookie.includes('sid=abc') ? res(LIST(u.searchParams.get('page') === '2' ? 2 : 1)) : res(LOGIN);
    return res('nope', { status: 404 });
  };
  return { fetchImpl, seen };
}
const portalSource = (extra = {}) => ({ key: 'custom-acme', name: 'Acme portal', type: 'tender', config: {
  loginUrl: 'https://portal.example/login', listUrl: 'https://portal.example/opps', itemSelector: 'tr.opp', titleSelector: 'a.t',
  buyerSelector: '.buyer', deadlineSelector: '.close', valueSelector: '.val', nextSelector: 'a[rel=next]', ...extra } });

test('private portal: signs in through the form, keeps the session, follows pages', async () => {
  resetHttpState();
  const { fetchImpl, seen } = fakePortal();
  const client = createHttp({ fetchImpl, minDelayMs: 0 });
  const connector = portalConnector(portalSource());
  const items = await connector.fetch({ request: client.request, now, credential: { kind: 'login', username: 'pat@example.com', password: 'right' } });
  assert.deepEqual(seen, ['GET /login', 'POST /session', 'GET /home', 'GET /opps', 'GET /opps?page=2']);
  assert.deepEqual(items.map((i) => [i.title, i.funder, i.award_max, i.closes_at.slice(0, 10), i.url]), [
    ['Conveyor controls upgrade', 'Acme Logistics', 75000, '2099-01-14', 'https://portal.example/opps/501'],
    ['Gantry crane inspection', 'Acme Ports', 30000, '2099-02-20', 'https://portal.example/opps/502'],
  ]);
  assert.equal(connector.respectRobots, false);
  assert.equal(connector.guard, true);
});

test('private portal: a wrong password is reported plainly, and a credential is required', async () => {
  resetHttpState();
  const { fetchImpl } = fakePortal();
  const client = createHttp({ fetchImpl, minDelayMs: 0 });
  const connector = portalConnector(portalSource());
  await assert.rejects(connector.fetch({ request: client.request, now, credential: { kind: 'login', username: 'pat@example.com', password: 'wrong' } }), /Sign-in was rejected/);
  await assert.rejects(connector.fetch({ request: client.request, now }), /username and password credential/);
  const login = buildLogin('<form action="do"><input name="u"><input type="password" name="p"><input type="checkbox" name="remember" checked></form>', 'https://x.example/a/login', { username: 'a', password: 'b' });
  assert.equal(login.action, 'https://x.example/a/do');
  assert.equal(login.fields.toString(), 'u=a&p=b&remember=on');
  assert.equal(parseListing('<ul><li><a href="javascript:void(0)">x</a></li></ul>', 'https://x.example/', { itemSelector: 'li' }).items.length, 0);
  assert.ok(createJar() instanceof Map);
});

test('every built-in connector declares how it accesses its source', () => {
  for (const c of connectors) {
    assert.ok(c.key && c.name && c.access && typeof c.fetch === 'function', c.key);
    assert.ok(['tender', 'grant'].includes(c.type));
    if (/listing pages/.test(c.access)) assert.equal(c.respectRobots, true, `${c.key} scrapes HTML so must respect robots.txt`);
  }
  assert.deepEqual(connectors.filter((c) => c.enabledByDefault === false).map((c) => c.key), ['sell2wales', 'ted', 'sam-gov', 'innovate-uk']);
});

// --- Ingest, dedupe, scoring ---------------------------------------------------------

const opp = (o = {}) => ({ external_id: 'x1', title: 'Hydraulic test rig design and build', funder: 'Network Rail Ltd', url: 'https://e.example/1', closes_at: '2099-12-08T12:00:00.000Z', cpv_codes: '71333000', award_max: 500000, ...o });

function setupOrg(profile = {}) {
  const db = openDb(':memory:');
  ensureSources(db);
  const org = db.prepare(`INSERT INTO orgs (name) VALUES ('Northfield')`).run().lastInsertRowid;
  const p = { keywords: 'test rig', cpv_codes: '713', types: 'tender', min_score: 30, ...profile };
  db.prepare('INSERT INTO profiles (org_id, keywords, cpv_codes, types, min_score) VALUES (?, ?, ?, ?, ?)').run(org, p.keywords, p.cpv_codes, p.types, p.min_score);
  return { db, org };
}

test('the same notice on two portals is shown once, with the other linked', () => {
  const { db, org } = setupOrg();
  assert.equal(dedupeKey(opp()), dedupeKey(opp({ title: 'HYDRAULIC Test-Rig: design & build', funder: 'The Network Rail Limited', closes_at: '2099-12-08T23:59:00.000Z' })));
  assert.equal(dedupeKey(opp({ closes_at: null })), null);
  saveOpportunities(db, { key: 'find-a-tender', type: 'tender' }, [opp()]);
  saveOpportunities(db, { key: 'contracts-finder', type: 'tender' }, [opp({ external_id: 'cf-9', title: 'Hydraulic test rig: design and build' }), opp({ external_id: 'cf-10', title: 'Something else entirely for the depot' })]);
  const rows = db.prepare('SELECT id, source_key, duplicate_of FROM opportunities ORDER BY id').all();
  assert.deepEqual(rows.map((r) => r.duplicate_of), [null, rows[0].id, null]);
  const feed = getFeed(db, org, { view: 'all', now });
  assert.deepEqual(feed.items.map((i) => i.source_key).sort(), ['contracts-finder', 'find-a-tender']);
  assert.equal(feed.total, 2);
});

test('CPV categories and countries drive the score, with reasons', () => {
  assert.equal(cpvPrefix('71300000'), '713');
  assert.equal(cpvPrefix('42'), '42');
  assert.equal(cpvPrefix('09300000-2'), '093');
  const profile = { types: 'tender', keywords: '', cpv_codes: '713\n42000000', countries: 'GB\nIE', min_award: 50000, max_award: 1e6 };
  const hit = scoreOpportunity({ type: 'tender', title: 'Design services', summary: '', eligibility: '', funder: '', cpv_codes: '45000000 71320000', country: 'GB', award_max: 2e5 }, profile, now);
  assert.ok(hit.reasons.includes('CPV 71320000 is in your category 713'));
  assert.ok(hit.reasons.includes('Contract value is in your range'));
  const miss = scoreOpportunity({ type: 'tender', title: 'Design services', summary: '', eligibility: '', funder: '', cpv_codes: '45000000', country: 'FR', award_max: 5e6 }, profile, now);
  assert.ok(miss.score < hit.score);
  assert.ok(miss.reasons.includes('Outside your countries (FR)'));
  assert.ok(miss.reasons.includes('Contract value is outside your range'), 'a tender\'s single value is its size, not a ceiling');
});

test('feed filters: CPV, value, sort, paging and the pipeline', () => {
  const { db, org } = setupOrg();
  saveOpportunities(db, { key: 'find-a-tender', type: 'tender' }, [
    opp({ external_id: 'a', title: 'Test rig for bogies and wheelsets', award_max: 900000, closes_at: '2099-03-01T00:00:00.000Z' }),
    opp({ external_id: 'b', title: 'Machine tools supply contract', cpv_codes: '42600000', award_max: 50000, closes_at: '2099-02-01T00:00:00.000Z' }),
    opp({ external_id: 'c', title: 'Old test rig contract now closed', closes_at: '2020-01-01T00:00:00.000Z' }),
  ]);
  const ids = (f) => getFeed(db, org, { view: 'all', now, ...f }).items.map((i) => i.external_id);
  assert.deepEqual(ids({ cpv: '42' }), ['b']);
  assert.deepEqual(ids({ min_value: 100000 }), ['a']);
  assert.deepEqual(ids({ sort: 'deadline' }), ['b', 'a']);
  assert.deepEqual(ids({ sort: 'value', limit: 1, offset: 1 }), ['b']);
  const closed = db.prepare(`SELECT id FROM opportunities WHERE external_id = 'c'`).get().id;
  setState(db, org, closed, { stage: 'submitted' });
  setState(db, org, closed, { stage: 'nonsense' });
  assert.deepEqual(getFeed(db, org, { view: 'pipeline', now }).items.map((i) => [i.external_id, i.stage]), [['c', 'submitted']], 'the pipeline keeps closed bids');
  assert.equal(prune(db, { now: Date.parse('2030-01-01') }), 0, 'bids in the pipeline are never pruned');
});

test('runs are recorded, scheduled, and only due sources run', async () => {
  const db = openDb(':memory:');
  ensureSources(db);
  db.prepare('UPDATE sources SET enabled = 0').run();
  db.prepare(`INSERT INTO sources (key, name, kind, type, config, interval_minutes, enabled) VALUES ('custom-feed', 'Feed', 'rss', 'tender', '{"url":"https://127.0.0.1/feed"}', 60, 1)`).run();
  const first = await runAll(db, { dueOnly: true });
  assert.match(first[0].error, /private network/, 'a custom source cannot be pointed at this machine');
  const src = db.prepare(`SELECT * FROM sources WHERE key = 'custom-feed'`).get();
  assert.ok(Date.parse(src.next_run_at) > Date.now() + 59 * 60e3);
  assert.deepEqual(await runAll(db, { dueOnly: true }), [], 'not due again yet');
  const run = db.prepare('SELECT * FROM source_runs').get();
  assert.equal(run.status, 'error');
  assert.ok(run.duration_ms >= 0);
  const ok = await runSource(db, { ...findATender, key: 'find-a-tender' }, { now, get: async (url) => (/cursor/.test(url) ? '{"releases":[]}' : fixture('find-a-tender.json')) });
  assert.deepEqual([ok.found, ok.added], [1, 1]);
  assert.ok(db.prepare(`SELECT last_ok_at FROM sources WHERE key = 'find-a-tender'`).get().last_ok_at);
});

// --- Alerts ------------------------------------------------------------------------

test('saved-search alerts: only new matches, once, to every channel', async () => {
  const { db, org } = setupOrg();
  const { encrypt: enc } = await import('../src/secrets/vault.js');
  saveOpportunities(db, { key: 'find-a-tender', type: 'tender' }, [opp({ external_id: 'old', title: 'Existing test rig maintenance contract' })]);
  const id = db.prepare(`INSERT INTO saved_searches (org_id, name, filters, frequency, emails, slack_webhook, webhook_url) VALUES (?, 'Rigs', ?, 'instant', 'a@example.com', ?, ?)`)
    .run(org, JSON.stringify({ q: 'rig', min_value: 100000 }), enc('https://hooks.slack.com/services/T/B/x'), enc('https://crm.example/hook')).lastInsertRowid;
  const search = db.prepare('SELECT * FROM saved_searches WHERE id = ?').get(id);
  assert.doesNotMatch(search.slack_webhook, /hooks\.slack/, 'webhook URLs are stored encrypted');
  baseline(db, search);
  const sent = [];
  const channels = {
    sendEmail: async (m) => sent.push(['email', m.to.join(), m.subject, m.html]),
    sendSlack: async (url, m) => sent.push(['slack', url, m.items.length]),
    sendWebhook: async () => { throw new Error('HTTP 500'); },
  };
  assert.deepEqual(await runAlerts(db, { channels }), [], 'what already matched is not alerted on');
  saveOpportunities(db, { key: 'find-a-tender', type: 'tender' }, [
    opp({ external_id: 'new', title: 'New fatigue test rig for bogies' }),
    opp({ external_id: 'small', title: 'Small test rig repair job', award_max: 5000 }),
    opp({ external_id: 'other', title: 'Unrelated engineering design work', award_max: 900000 }),
  ]);
  const [result] = await runAlerts(db, { channels });
  assert.deepEqual([result.count, result.email, result.slack, result.webhook], [1, true, true, false]);
  assert.equal(sent[0][2], '1 new match for "Rigs"');
  assert.match(sent[0][3], /New fatigue test rig for bogies/);
  assert.deepEqual(sent[1], ['slack', 'https://hooks.slack.com/services/T/B/x', 1]);
  assert.deepEqual(await runAlerts(db, { channels }), [], 'never sent twice');
  assert.deepEqual(db.prepare('SELECT channel, ok FROM alert_log ORDER BY id').all(), [{ channel: 'email', ok: 1 }, { channel: 'slack', ok: 1 }, { channel: 'webhook', ok: 0 }]);
  const payload = slackPayload({ title: 'T', link: 'https://x', items: [{ id: 1, title: 'A <b> & c', funder: 'Buyer', closes_at: '2099-01-01T00:00:00Z', award_max: 1000, currency: 'GBP', match: { score: 80 } }] });
  assert.match(payload.blocks[1].text.text, /A &lt;b&gt; &amp; c/);
});

// --- Web: API, admin, operations -------------------------------------------------------

const token = (html) => html.match(/name="_csrf" value="([^"]+)"/)[1];
async function signedIn() {
  const db = openDb(':memory:');
  const app = createApp(db);
  const agent = request.agent(app);
  const page = await agent.get('/register');
  await agent.post('/register').type('form').send({ _csrf: token(page.text), name: 'Pat', email: 'pat@example.com', password: 'correct horse battery', orgName: 'Northfield' });
  saveOpportunities(db, { key: 'find-a-tender', type: 'tender' }, [opp({ title: 'Test rig controls for depot', external_id: 'a' })]);
  return { db, app, agent };
}

test('API: bearer tokens, filtering, triage, and no access without one', async () => {
  const { db, app, agent } = await signedIn();
  assert.equal((await request(app).get('/api/v1/opportunities')).status, 401);
  assert.equal((await request(app).get('/api/v1/opportunities').set('Authorization', 'Bearer bf_wrong')).status, 401);
  assert.equal((await request(app).get('/api/v1/openapi.json')).body.openapi, '3.1.0');
  const account = await agent.get('/account');
  const made = await agent.post('/account/tokens').type('form').send({ _csrf: token(account.text), name: 'CRM' });
  const secret = made.text.match(/bf_[\w-]+/)[0];
  assert.ok(!db.prepare('SELECT token_hash FROM api_tokens').get().token_hash.includes(secret.slice(3)), 'only a hash is stored');
  const auth = { Authorization: `Bearer ${secret}` };
  const list = await request(app).get('/api/v1/opportunities?view=all&cpv=713').set(auth);
  assert.equal(list.status, 200);
  assert.equal(list.headers['set-cookie'], undefined, 'the API never sets cookies');
  assert.equal(list.body.total, 1);
  const [item] = list.body.items;
  assert.deepEqual([item.title, item.buyer, item.cpv_codes, item.value, item.source], ['Test rig controls for depot', 'Network Rail Ltd', ['71333000'], 500000, 'find-a-tender']);
  const patched = await request(app).patch(`/api/v1/opportunities/${item.id}`).set(auth).send({ starred: true, stage: 'bidding', note: 'Go' });
  assert.deepEqual([patched.body.starred, patched.body.stage, patched.body.note], [true, 'bidding', 'Go']);
  assert.equal((await request(app).patch(`/api/v1/opportunities/${item.id}`).set(auth).send({ stage: 'nope' })).status, 400);
  assert.equal((await request(app).get('/api/v1/opportunities/999').set(auth)).status, 404);
  assert.equal((await request(app).get('/api/v1/sources').set(auth)).body.items.length, connectors.length);
  await agent.post(`/account/tokens/${db.prepare('SELECT id FROM api_tokens').get().id}/revoke`).type('form').send({ _csrf: token(account.text) });
  assert.equal((await request(app).get('/api/v1/opportunities').set(auth)).status, 401, 'a revoked token stops working');
});

test('admin: credentials are write-only, custom sources are validated, actions are audited', async () => {
  const { db, agent } = await signedIn();
  const admin = await agent.get('/admin');
  const csrf = token(admin.text);
  await agent.post('/admin/credentials').type('form').send({ _csrf: csrf, name: 'Acme login', kind: 'login', username: 'pat', password: 'p4ssw0rd-secret' });
  const after = await agent.get('/admin');
  assert.match(after.text, /Acme login/);
  assert.doesNotMatch(after.text, /p4ssw0rd-secret/);
  const cred = db.prepare('SELECT id FROM credentials').get().id;

  const bad = await agent.post('/admin/sources').type('form').send({ _csrf: csrf, kind: 'portal', name: 'Internal', listUrl: 'http://192.168.0.10/opps', itemSelector: 'tr' });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /private network/);
  const good = await agent.post('/admin/sources').type('form').send({ _csrf: csrf, kind: 'portal', name: 'Acme Portal', listUrl: 'https://93.184.216.34/opps', itemSelector: 'tr.opp', loginUrl: 'https://93.184.216.34/login', credential_id: cred, interval_minutes: 5 });
  assert.equal(good.status, 302);
  const row = db.prepare(`SELECT * FROM sources WHERE kind = 'portal'`).get();
  assert.match(row.key, /^custom-acme-portal-[0-9a-f]{4}$/);
  assert.equal(row.interval_minutes, 15, 'intervals have a floor');
  assert.equal(row.credential_id, cred);
  assert.equal((await agent.get(`/admin/sources/${row.key}`)).status, 200);
  await agent.post(`/admin/sources/${row.key}/delete`).type('form').send({ _csrf: csrf });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM sources WHERE kind = 'portal'`).get().n, 0);
  await agent.post('/admin/sources/find-a-tender/delete').type('form').send({ _csrf: csrf });
  assert.ok(db.prepare(`SELECT 1 FROM sources WHERE key = 'find-a-tender'`).get(), 'built-in sources cannot be deleted');
  assert.deepEqual(db.prepare('SELECT action FROM audit_log ORDER BY id').all().map((a) => a.action), ['credential.created', 'source.created', 'source.deleted']);
});

test('saved searches: created from the UI, secrets stay write-only', async () => {
  const { db, agent } = await signedIn();
  const form = await agent.get('/searches/new?q=rig&cpv=713');
  assert.match(form.text, /value="rig"/);
  const csrf = token(form.text);
  const badHook = await agent.post('/searches').type('form').send({ _csrf: csrf, name: 'Rigs', q: 'rig', slack_webhook: 'https://example.com/not-slack' });
  assert.equal(badHook.status, 400);
  const made = await agent.post('/searches').type('form').send({ _csrf: csrf, name: 'Rigs', q: 'rig', cpv: '71300000', frequency: 'daily', emails: 'a@example.com, nope', slack_webhook: 'https://hooks.slack.com/services/T/B/secretpart' });
  assert.equal(made.headers.location, '/searches/1');
  const row = db.prepare('SELECT * FROM saved_searches').get();
  assert.deepEqual(JSON.parse(row.filters), { q: 'rig', type: '', source: '', cpv: '713', country: '', min_value: null, min_score: null });
  assert.deepEqual([row.frequency, row.emails], ['daily', 'a@example.com']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM alert_deliveries').get().n, 1, 'existing matches are the baseline');
  const edit = await agent.get('/searches/1/edit');
  assert.doesNotMatch(edit.text, /secretpart/);
  assert.match((await agent.get('/searches/1')).text, /Test rig controls for depot/);
  for (const page of ['/dashboard', '/pipeline', '/searches', '/team', '/api', '/profile', '/o/1']) assert.equal((await agent.get(page)).status, 200, page);
});

test('operations: health, readiness, guarded metrics, security headers', async () => {
  const { app } = await signedIn();
  assert.deepEqual((await request(app).get('/healthz')).body, { ok: true });
  assert.equal((await request(app).get('/readyz')).body.ok, true);
  const metrics = await request(app).get('/metrics');
  assert.equal(metrics.status, 200, 'local callers may read metrics');
  assert.match(metrics.text, /bidfinder_opportunities_open\{source="find-a-tender"\} 1/);
  assert.match(metrics.text, /bidfinder_http_requests_total\{status="2xx"\} \d+/);
  app.set('trust proxy', true);
  assert.equal((await request(app).get('/metrics').set('X-Forwarded-For', '203.0.113.9')).status, 404, 'public callers may not');
  const home = await request(app).get('/login');
  assert.match(home.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(home.headers['x-frame-options'], 'SAMEORIGIN');
  assert.ok(home.headers['x-request-id']);
});

test('backups are real SQLite files and old ones are rotated out', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-backup-'));
  const db = openDb(path.join(dir, 'live.db'));
  db.prepare(`INSERT INTO orgs (name) VALUES ('Kept')`).run();
  for (const d of ['2026-10-01', '2026-10-02', '2026-10-03']) await backup(db, { dir, keep: 2, now: new Date(`${d}T03:00:00Z`) });
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('bidfinder-')), ['bidfinder-2026-10-02.db', 'bidfinder-2026-10-03.db']);
  assert.equal(openDb(path.join(dir, 'bidfinder-2026-10-03.db')).prepare('SELECT name FROM orgs').get().name, 'Kept');
  fs.rmSync(dir, { recursive: true });
});

test('a busy port moves on to the next free one, unless told to be strict', async () => {
  const blocker = http.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  const busy = blocker.address().port;
  const app = http.createServer();
  const got = await listen({ listen: (p, h) => http.createServer().listen(p, h) }, { port: busy, host: '127.0.0.1' });
  assert.ok(got.port > busy && got.port <= busy + 19, `moved from ${busy} to ${got.port}`);
  await assert.rejects(listen({ listen: (p, h) => http.createServer().listen(p, h) }, { port: busy, host: '127.0.0.1', strict: true }), /already in use/);
  got.server.close(); blocker.close(); app.close?.();
});

test('an existing v3 database is upgraded in place', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-migrate-'));
  const file = path.join(dir, 'old.db');
  const schema = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
  const Database = openDb(':memory:').constructor;
  const old = new Database(file);
  old.exec(schema);
  old.exec(`INSERT INTO sources (key, name) VALUES ('contracts-finder', 'CF');
    INSERT INTO opportunities (source_key, external_id, type, title, url) VALUES ('contracts-finder', 'e1', 'tender', 'Kept through upgrade', 'https://e.example');`);
  old.close();
  const db = openDb(file);
  assert.equal(db.pragma('user_version', { simple: true }), 1);
  const row = db.prepare('SELECT title, cpv_codes, currency, duplicate_of FROM opportunities').get();
  assert.deepEqual(row, { title: 'Kept through upgrade', cpv_codes: '', currency: 'GBP', duplicate_of: null });
  db.close();
  assert.equal(openDb(file).pragma('user_version', { simple: true }), 1, 'migrations run once');
  fs.rmSync(dir, { recursive: true });
});
