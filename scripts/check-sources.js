#!/usr/bin/env node
// Fetches one page from every built-in source against the live service and
// checks the results look right. Nothing is saved. CI runs this weekly, and
// on any change to a connector, so a portal changing its API is noticed.
//
// Usage: node scripts/check-sources.js [source-key ...]
// SAM.gov uses the official API when SAM_API_KEY is set, else public search.
import { connectors } from '../src/connectors/index.js';
import { createHttp } from '../src/http/client.js';

const wanted = process.argv.slice(2);

// Sources whose service is broken at their end. They are still checked, so we
// notice when they recover, but they do not fail the run.
const KNOWN_ISSUES = {
  sell2wales: 'the API answers every request with HTTP 500 "Error converting data type nvarchar to float" (seen November 2026)',
};
const isoOk = (v) => v == null || (typeof v === 'string' && !Number.isNaN(Date.parse(v)));

function problems(items) {
  const out = [];
  if (!items.length) out.push('no opportunities returned');
  items.forEach((o, i) => {
    const where = `item ${i + 1}`;
    if (!o.external_id) out.push(`${where}: no external_id`);
    if (!String(o.title || '').trim()) out.push(`${where}: no title`);
    if (!/^https?:\/\//.test(o.url || '')) out.push(`${where}: bad url ${o.url}`);
    for (const f of ['closes_at', 'opens_at', 'published_at']) if (!isoOk(o[f])) out.push(`${where}: bad ${f} ${o[f]}`);
    for (const f of ['award_min', 'award_max']) if (o[f] != null && !(Number.isFinite(o[f]) && o[f] >= 0)) out.push(`${where}: bad ${f} ${o[f]}`);
  });
  return [...new Set(out)].slice(0, 5);
}

const rows = [];
let failed = 0;
for (const c of connectors) {
  if (wanted.length && !wanted.includes(c.key)) continue;
  const credential = c.key === 'sam-gov' ? (process.env.SAM_API_KEY ? { key: process.env.SAM_API_KEY } : null) : null;
  const http = createHttp({ minDelayMs: c.minDelayMs ?? 1000, respectRobots: Boolean(c.respectRobots), robotsOffsiteError: c.robotsOffsiteError, retries: 2 });
  const started = Date.now();
  try {
    const items = await c.fetch({ maxPages: 1, get: http.get, request: http.request, since: null, config: {}, credential, days: 7 });
    const issues = problems(items);
    const withDeadline = items.filter((o) => o.closes_at).length;
    const withValue = items.filter((o) => o.award_max != null).length;
    const withCpv = items.filter((o) => o.cpv_codes).length;
    rows.push({ source: c.key, result: issues.length ? 'FAIL' : 'ok', found: items.length, deadline: withDeadline, value: withValue, cpv: withCpv, seconds: Math.round((Date.now() - started) / 1000) });
    if (issues.length) { failed++; console.error(`\n${c.key}:\n  ${issues.join('\n  ')}`); }
    if (!issues.length && KNOWN_ISSUES[c.key]) console.log(`\n${c.key} works again: remove it from KNOWN_ISSUES and switch it back on by default.`);
    if (items[0]) console.log(`\n${c.key} sample: ${items[0].title} | ${items[0].funder} | closes ${items[0].closes_at} | ${items[0].award_max ?? '-'} ${items[0].currency || ''} | ${items[0].url}`);
  } catch (err) {
    const known = KNOWN_ISSUES[c.key];
    if (!known) failed++;
    rows.push({ source: c.key, result: known ? 'known issue' : 'ERROR', seconds: Math.round((Date.now() - started) / 1000) });
    if (known) console.log(`\n${c.key}: ${known}`);
    console.error(`\n${c.key}: ${err.message}`);
  }
}
console.log();
console.table(rows);
process.exitCode = failed ? 1 : 0;
