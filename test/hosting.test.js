// Running on a Pi behind a Cloudflare Tunnel: the visitor's real address, the
// email set-up script, and backups that can be copied offsite as one file.
import './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import Database from 'better-sqlite3';
import { config } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { backup } from '../src/scheduler.js';
import { createApp } from '../src/web/app.js';
import { applyDns, findZone, fullName, setEnv, setupMail, smtpUrl, wantedRecords } from '../deploy/pi/setup-mail.js';

const token = (html) => html.match(/name="_csrf" value="([^"]+)"/)[1];

async function failedLoginIp(app, headers = {}) {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  await agent.post('/login').set(headers).type('form').send({ _csrf: token(page.text), email: 'nobody@example.com', password: 'wrong' });
}
const lastIp = (db) => db.prepare(`SELECT ip FROM audit_log WHERE action = 'login.failed' ORDER BY id DESC`).get().ip;

test('client address: CF-Connecting-IP is used only when configured and sent by a trusted proxy', async (t) => {
  const before = { header: config.clientIpHeader, trust: config.trustProxy };
  t.after(() => { config.clientIpHeader = before.header; config.trustProxy = before.trust; });
  const cf = { 'CF-Connecting-IP': '203.0.113.9' };

  const db = openDb(':memory:');
  config.clientIpHeader = '';
  await failedLoginIp(createApp(db), cf);
  assert.match(lastIp(db), /127\.0\.0\.1/, 'not configured: the header is ignored');

  config.clientIpHeader = 'cf-connecting-ip';
  const app = createApp(db);
  await failedLoginIp(app, cf);
  assert.equal(lastIp(db), '203.0.113.9', 'from cloudflared on this machine: the visitor address');
  await failedLoginIp(app, { 'CF-Connecting-IP': 'not-an-ip' });
  assert.match(lastIp(db), /127\.0\.0\.1/, 'rubbish is ignored');
  assert.equal((await request(app).get('/metrics').set(cf)).status, 404, 'metrics stay private through the tunnel');

  config.trustProxy = false;
  const direct = openDb(':memory:');
  await failedLoginIp(createApp(direct), cf);
  assert.match(lastIp(direct), /127\.0\.0\.1/, 'from an untrusted address the header could be forged, so it is ignored');
});

test('client address: rate limits count each visitor separately behind the tunnel', async (t) => {
  const before = config.clientIpHeader;
  t.after(() => { config.clientIpHeader = before; });
  config.clientIpHeader = 'cf-connecting-ip';
  const app = createApp(openDb(':memory:'));
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const attempt = (ip, i) => agent.post('/login').set('CF-Connecting-IP', ip).type('form').send({ _csrf: token(page.text), email: `p${i}@example.com`, password: 'wrong' });
  for (let i = 0; i < 30; i++) await attempt('198.51.100.1', i);
  assert.equal((await attempt('198.51.100.1', 99)).status, 429, 'the noisy visitor is blocked');
  assert.equal((await attempt('198.51.100.2', 100)).status, 401, 'everyone else still gets in');
});

// A stand-in for the Resend and Cloudflare APIs.
function fakeApis({ existingDomain = false, existingDns = [] } = {}) {
  const calls = [];
  const dns = [...existingDns];
  const resendDomain = {
    id: 'dom_1', name: 'bids.example.co.uk', status: 'not_started',
    records: [
      { record: 'SPF', name: 'send.bids', type: 'MX', value: 'feedback-smtp.eu-west-1.amazonses.com', priority: 10 },
      { record: 'SPF', name: 'send.bids', type: 'TXT', value: '"v=spf1 include:amazonses.com ~all"' },
      { record: 'DKIM', name: 'resend._domainkey.bids', type: 'TXT', value: 'p=NEWKEY' },
    ],
  };
  const json = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  const fetchFn = async (url, { method, body }) => {
    const u = new URL(url);
    calls.push(`${method} ${u.host} ${u.pathname}${u.search}`);
    const data = body ? JSON.parse(body) : null;
    if (u.host === 'api.resend.com') {
      if (method === 'GET' && u.pathname === '/domains') return json({ data: existingDomain ? [{ id: 'dom_1', name: 'bids.example.co.uk' }] : [] });
      if (method === 'GET' && u.pathname === '/domains/dom_1') return json(resendDomain);
      if (method === 'POST' && u.pathname === '/domains') { assert.equal(data.region, 'eu-west-1'); return json(resendDomain, 201); }
      if (method === 'POST' && u.pathname === '/domains/dom_1/verify') return json({ object: 'domain', id: 'dom_1' });
    }
    if (u.host === 'api.cloudflare.com') {
      if (u.pathname === '/client/v4/zones') {
        const name = u.searchParams.get('name');
        return json({ success: true, result: name === 'example.co.uk' ? [{ id: 'z1', name }] : [] });
      }
      if (method === 'GET') {
        const type = u.searchParams.get('type');
        const name = u.searchParams.get('name');
        return json({ success: true, result: dns.filter((r) => r.type === type && r.name === name) });
      }
      if (method === 'POST') { dns.push({ id: `r${dns.length}`, ...data }); return json({ success: true, result: {} }); }
      if (method === 'PUT') {
        const i = dns.findIndex((r) => u.pathname.endsWith(`/${r.id}`));
        dns[i] = { ...dns[i], ...data };
        return json({ success: true, result: {} });
      }
    }
    return json({ message: `unexpected ${method} ${url}` }, 404);
  };
  return { fetchFn, calls, dns };
}

test('email set-up: adds the domain to Resend, its DNS records to Cloudflare, and SMTP settings to the env file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-mail-'));
  const envFile = path.join(dir, 'bidfinder.env');
  fs.writeFileSync(envFile, 'HOSTED=true\n# SMTP_URL=smtps://resend:re_...@smtp.resend.com:465\n# MAIL_FROM=Bid Finder <alerts@x>\n');
  const apis = fakeApis({ existingDns: [{ id: 'old', type: 'TXT', name: '_dmarc.example.co.uk', content: 'v=DMARC1; p=quarantine;' }] });
  const lines = [];
  await setupMail({ fetchFn: apis.fetchFn, apiKey: 're_abc/123', cfToken: 'cf', domain: 'bids.example.co.uk', envFile, log: (l) => lines.push(l) });

  const names = apis.dns.map((r) => `${r.type} ${r.name}`).sort();
  assert.deepEqual(names, ['MX send.bids.example.co.uk', 'TXT _dmarc.example.co.uk', 'TXT resend._domainkey.bids.example.co.uk', 'TXT send.bids.example.co.uk']);
  assert.equal(apis.dns.find((r) => r.type === 'MX').priority, 10);
  assert.ok(apis.dns.every((r) => r.id === 'old' || r.proxied === false), 'mail records are never proxied');
  assert.equal(apis.dns.find((r) => r.id === 'old').content, 'v=DMARC1; p=quarantine;', 'an existing DMARC policy is left alone');
  assert.ok(apis.calls.includes('POST api.resend.com /domains/dom_1/verify'));

  const env = fs.readFileSync(envFile, 'utf8');
  assert.match(env, /^HOSTED=true$/m);
  assert.match(env, /^SMTP_URL=smtps:\/\/resend:re_abc%2F123@smtp\.resend\.com:465$/m, 'the key is escaped inside the URL');
  assert.match(env, /^MAIL_FROM=Bid Finder <alerts@bids\.example\.co\.uk>$/m);
  assert.equal(env.match(/SMTP_URL/g).length, 1, 'the commented example is replaced, not duplicated');

  // Running it again changes nothing in DNS, except a rotated DKIM key.
  const again = fakeApis({ existingDomain: true, existingDns: apis.dns.map((r) => (r.name.startsWith('resend.') ? { ...r, content: 'p=OLDKEY' } : r)) });
  await setupMail({ fetchFn: again.fetchFn, apiKey: 're_abc', cfToken: 'cf', domain: 'bids.example.co.uk', log: () => {} });
  assert.equal(again.dns.length, 4);
  assert.equal(again.dns.find((r) => r.name.startsWith('resend.')).content, 'p=NEWKEY');
  assert.ok(!again.calls.some((c) => c.startsWith('POST api.cloudflare.com')), 'nothing added twice');
});

test('email set-up: without a Cloudflare token the records are printed to add by hand', async () => {
  const apis = fakeApis();
  const lines = [];
  const { values } = await setupMail({ fetchFn: apis.fetchFn, apiKey: 're_abc', domain: 'bids.example.co.uk', log: (l) => lines.push(l) });
  assert.ok(lines.some((l) => /add these DNS records by hand/.test(l)));
  assert.ok(lines.some((l) => /resend\._domainkey\.bids .*p=NEWKEY/.test(l)));
  assert.ok(!apis.calls.some((c) => c.includes('cloudflare')));
  assert.equal(values.SMTP_URL, smtpUrl('re_abc'));
  await assert.rejects(setupMail({ fetchFn: apis.fetchFn, apiKey: '', domain: 'bids.example.co.uk', log: () => {} }), /RESEND_API_KEY/);
  await assert.rejects(setupMail({ fetchFn: apis.fetchFn, apiKey: 'x', domain: 'not a domain', log: () => {} }), /domain name/);
});

test('email set-up helpers: zone lookup, record names and env editing', async () => {
  const { fetchFn } = fakeApis();
  assert.equal((await findZone({ fetchFn, token: 'cf', domain: 'bids.example.co.uk' })).name, 'example.co.uk');
  await assert.rejects(findZone({ fetchFn, token: 'cf', domain: 'other.org' }), /No Cloudflare zone/);
  assert.equal(fullName('@', 'example.com'), 'example.com');
  assert.equal(fullName('send', 'example.com'), 'send.example.com');
  assert.equal(fullName('send.example.com', 'example.com'), 'send.example.com');
  assert.deepEqual(wantedRecords([{ record: 'SPF', name: 'send', type: 'MX', value: 'x', priority: '10' }], 'e.com'), [{ kind: 'SPF', type: 'MX', name: 'send.e.com', content: 'x', priority: 10 }]);
  assert.equal(setEnv('A=1\n#B=old\n', { B: '2', C: '$3' }), 'A=1\nB=2\nC=$3\n');
  const calls = [];
  await applyDns({ fetchFn: async (u, o) => { calls.push(o.method); return { ok: true, status: 200, text: async () => '{"success":true,"result":[]}' }; }, token: 't', zone: { id: 'z', name: 'e.com' }, records: [], log: () => {} });
  assert.deepEqual(calls, ['GET', 'POST'], 'adds a starter DMARC record when there is none');
});

test('backups are one self-contained file, ready to copy offsite', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-backup-'));
  const db = openDb(path.join(dir, 'live.db'));
  db.prepare(`INSERT INTO orgs (name) VALUES ('Kept')`).run();
  const file = await backup(db, { dir: path.join(dir, 'backups') });
  db.close();
  assert.deepEqual(fs.readdirSync(path.join(dir, 'backups')), [path.basename(file)], 'no -wal or -shm files beside it');
  const copy = new Database(file, { readonly: true });
  assert.equal(copy.pragma('journal_mode', { simple: true }), 'delete');
  assert.equal(copy.prepare('SELECT name FROM orgs').get().name, 'Kept');
  copy.close();
});
