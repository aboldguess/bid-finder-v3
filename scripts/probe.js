#!/usr/bin/env node
// TEMPORARY: prints what candidate portal endpoints return, so connectors can
// be written against real responses. Removed before merge.
import fs from 'node:fs';
import { createHttp } from '../src/http/client.js';

const today = new Date();
const iso = (d) => d.toISOString().slice(0, 10);
const ago = (n) => new Date(Date.now() - n * 864e5);
const P = (name, url, opts = {}) => ({ name, url, ...opts });
const sedia = (types, status = ['31094501', '31094502']) => ({ query: JSON.stringify({ bool: { must: [{ terms: { type: types } }, { terms: { status } }] } }), languages: JSON.stringify(['en']), sort: JSON.stringify({ field: 'sortStatus', order: 'ASC' }) });
const ESA = 'https://esastar-publication-ext.sso.esa.int/api';
const probes = [
  P('r5-jetro-central', 'https://www.jetro.go.jp/XiProcurementSearch/xi_proc_central_en.json', { keep: 300000 }),
  P('r5-jetro-local', 'https://www.jetro.go.jp/XiProcurementSearch/xi_proc_local_en.json', { keep: 300000 }),
  P('r5-esa-filter', `${ESA}/tenderAction/filter`),
  P('r5-esa-filter-20-0', `${ESA}/tenderAction/filter/20/0`),
  P('r5-esa-filter-0-1', `${ESA}/tenderAction/filter/0/1`),
  P('r5-esa-last', `${ESA}/tenderAction/last/10`),
  P('r5-esa-status', `${ESA}/app/status`),
  P('r5-esa-type', `${ESA}/app/tendertype`),
  P('r5-esa-user', `${ESA}/user`),
  P('r5-esa-nonesa', `${ESA}/nonESATA/filter`),
];

fs.mkdirSync('probe-out', { recursive: true });
const http = createHttp({ minDelayMs: 500, retries: 0 });
for (const p of probes) {
  const opts = { accept: '*/*' };
  if (p.json) Object.assign(opts, { method: 'POST', body: JSON.stringify(p.json), headers: { 'Content-Type': 'application/json' } });
  if (p.form) { const f = new FormData(); for (const [k, v] of Object.entries(p.form)) f.append(k, new Blob([v], { type: 'application/json' })); Object.assign(opts, { method: 'POST', body: f }); }
  const started = Date.now();
  try {
    const body = await http.get(p.url, opts);
    console.log(`===== ${p.name} OK ${Date.now() - started}ms len=${body.length}`);
    fs.writeFileSync(`probe-out/${p.name}.txt`, body.slice(0, p.keep || 400000));
  } catch (err) {
    console.log(`===== ${p.name} FAIL ${err.status || ''} ${err.message.slice(0, 300)}`);
    fs.writeFileSync(`probe-out/${p.name}.FAIL.txt`, `${err.status || ''} ${err.message}`);
  }
}
