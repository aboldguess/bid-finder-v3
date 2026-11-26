#!/usr/bin/env node
// Sets up outgoing email for a hosted Bid Finder in one go:
//
//   1. adds your domain to Resend (the sending service), in its EU region;
//   2. puts the DNS records Resend asks for (SPF, DKIM, bounce MX) and a
//      starter DMARC record into your Cloudflare zone;
//   3. asks Resend to verify them;
//   4. writes SMTP_URL and MAIL_FROM into the settings file.
//
// A Pi on a home connection cannot deliver mail itself: home IP addresses are
// on spam blocklists, most ISPs block port 25, and there is no reverse DNS.
// So mail goes out through Resend's SMTP relay, signed for your domain.
//
//   sudo RESEND_API_KEY=re_... CLOUDFLARE_API_TOKEN=... node deploy/pi/setup-mail.js \
//        --domain bids.example.co.uk [--env /etc/bidfinder.env] [--from alerts]
//
// The Cloudflare token needs only "Zone > DNS > Edit" on that zone. Without it
// the records are printed for you to add by hand. Safe to run again.
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const RESEND = 'https://api.resend.com';
const CLOUDFLARE = 'https://api.cloudflare.com/client/v4';

async function call(fetchFn, base, token, method, path, body) {
  const res = await fetchFn(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'bidfinder-setup-mail' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!res.ok || data.success === false) {
    const why = data.message || data.errors?.map((e) => e.message).join('; ') || res.status;
    throw new Error(`${method} ${base.includes('resend') ? 'Resend' : 'Cloudflare'} ${path} failed: ${why}`);
  }
  return data;
}

// Adds the domain to Resend, or finds it if it is already there, with its DNS records.
export async function resendDomain({ fetchFn = fetch, apiKey, domain, region = 'eu-west-1' }) {
  const r = (method, path, body) => call(fetchFn, RESEND, apiKey, method, path, body);
  const existing = (await r('GET', '/domains')).data?.find((d) => d.name === domain);
  if (existing) return r('GET', `/domains/${existing.id}`);
  return r('POST', '/domains', { name: domain, region });
}

// The Cloudflare zone holding a name: bids.example.co.uk may live in example.co.uk.
export async function findZone({ fetchFn = fetch, token, domain }) {
  const parts = domain.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const name = parts.slice(i).join('.');
    const { result } = await call(fetchFn, CLOUDFLARE, token, 'GET', `/zones?name=${encodeURIComponent(name)}`);
    if (result?.length) return result[0];
  }
  throw new Error(`No Cloudflare zone found for ${domain}. Add the domain to Cloudflare first, and check the token can see it.`);
}

// Resend gives record names relative to the zone ("send", "resend._domainkey").
export function fullName(name, zoneName) {
  if (!name || name === '@') return zoneName;
  return name === zoneName || name.endsWith(`.${zoneName}`) ? name : `${name}.${zoneName}`;
}

const unquote = (s) => String(s || '').replace(/^"|"$/g, '');

// What should be in DNS: Resend's records plus DMARC if the zone has none.
export function wantedRecords(resendRecords, zoneName) {
  return resendRecords.map((rec) => ({
    kind: rec.record,
    type: rec.type,
    name: fullName(rec.name, zoneName),
    content: rec.value,
    ...(rec.priority !== undefined ? { priority: Number(rec.priority) } : {}),
  }));
}

// Creates each missing record. A DKIM key that has changed is replaced; anything
// else already there is left alone, so a hand-made record is never overwritten.
export async function applyDns({ fetchFn = fetch, token, zone, records, log = console.log }) {
  const cf = (method, path, body) => call(fetchFn, CLOUDFLARE, token, method, path, body);
  const done = [];
  const all = [...records, { kind: 'DMARC', type: 'TXT', name: `_dmarc.${zone.name}`, content: 'v=DMARC1; p=none;', onlyIfAbsent: true }];
  for (const rec of all) {
    const { result: found = [] } = await cf('GET', `/zones/${zone.id}/dns_records?type=${rec.type}&name=${encodeURIComponent(rec.name)}`);
    const same = found.find((f) => unquote(f.content) === unquote(rec.content) && (rec.priority === undefined || f.priority === rec.priority));
    if (same || (rec.onlyIfAbsent && found.length)) { done.push({ ...rec, action: 'kept' }); continue; }
    const body = { type: rec.type, name: rec.name, content: rec.content, ttl: 1, proxied: false, ...(rec.priority !== undefined ? { priority: rec.priority } : {}) };
    if (rec.kind === 'DKIM' && found.length === 1) {
      await cf('PUT', `/zones/${zone.id}/dns_records/${found[0].id}`, body);
      done.push({ ...rec, action: 'updated' });
    } else {
      await cf('POST', `/zones/${zone.id}/dns_records`, body);
      done.push({ ...rec, action: 'added' });
    }
    log(`    ${done.at(-1).action.padEnd(7)} ${rec.type.padEnd(4)} ${rec.name}`);
  }
  return done;
}

// Replaces (or adds) KEY=value lines in an env file's text, keeping everything else.
export function setEnv(text, values) {
  let out = text.endsWith('\n') || !text ? text : `${text}\n`;
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^#?\\s*${key}=.*$`, 'm');
    out = re.test(out) ? out.replace(re, () => line) : `${out}${line}\n`;
  }
  return out;
}

export const smtpUrl = (apiKey) => `smtps://resend:${encodeURIComponent(apiKey)}@smtp.resend.com:465`;

export async function setupMail({ fetchFn = fetch, apiKey, cfToken, domain, from = 'alerts', envFile, log = console.log }) {
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain || '')) throw new Error(`That does not look like a domain name: ${domain}`);
  if (!apiKey) throw new Error('RESEND_API_KEY is needed: create a key with Full access at https://resend.com/api-keys.');
  log(`==> Adding ${domain} to Resend`);
  const dom = await resendDomain({ fetchFn, apiKey, domain });
  const records = dom.records || [];
  let verified = dom.status === 'verified';
  if (cfToken) {
    log('==> DNS records in Cloudflare');
    const zone = await findZone({ fetchFn, token: cfToken, domain });
    await applyDns({ fetchFn, token: cfToken, zone, records: wantedRecords(records, zone.name), log });
    if (!verified) {
      await call(fetchFn, RESEND, apiKey, 'POST', `/domains/${dom.id}/verify`);
      log('    Asked Resend to check them. This usually takes a few minutes; Resend emails you when it is done.');
    }
  } else {
    log('==> No CLOUDFLARE_API_TOKEN, so add these DNS records by hand, then press Verify in Resend:');
    for (const rec of records) log(`    ${rec.type.padEnd(4)} ${rec.name}  ${rec.priority !== undefined ? `${rec.priority} ` : ''}${rec.value}`);
    log(`    TXT  _dmarc  v=DMARC1; p=none;`);
  }
  const values = { SMTP_URL: smtpUrl(apiKey), MAIL_FROM: `Bid Finder <${from}@${domain}>` };
  if (envFile) {
    fs.writeFileSync(envFile, setEnv(fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '', values));
    log(`==> Wrote SMTP_URL and MAIL_FROM to ${envFile}`);
  }
  return { domain: dom, verified, values };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { domain: { type: 'string' }, env: { type: 'string', default: '/etc/bidfinder.env' }, from: { type: 'string', default: 'alerts' } } });
  setupMail({ apiKey: process.env.RESEND_API_KEY, cfToken: process.env.CLOUDFLARE_API_TOKEN, domain: values.domain, from: values.from, envFile: values.env })
    .then(() => console.log('Mail is set up. Restart Bid Finder to use it: sudo systemctl restart bidfinder-web bidfinder-worker'))
    .catch((err) => { console.error(err.message); process.exit(1); });
}
