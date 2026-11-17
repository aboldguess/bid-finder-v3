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
const probes = [
  P('r3-esa-main', 'https://esastar-publication-ext.sso.esa.int/main-es2015.77d9349f2f8a727790df.js', { keep: 2000000 }),
  P('r3-esa-api-tenders', 'https://esastar-publication-ext.sso.esa.int/api/tenders'),
  P('r3-esa-api-faq', 'https://esastar-publication-ext.sso.esa.int/api/Faq'),
  P('r3-jetro', 'https://www.jetro.go.jp/en/database/procurement.html'),
  P('r3-sam-q', 'https://sam.gov/api/prod/sgs/v1/search/?index=opp&page=0&size=2&sort=-modifiedDate&mode=search&is_active=true&q=%22NATIONAL%20AERONAUTICS%20AND%20SPACE%20ADMINISTRATION%22&qMode=ALL'),
  P('r3-sam-org', 'https://sam.gov/api/prod/sgs/v1/search/?index=opp&page=0&size=2&sort=-modifiedDate&mode=search&is_active=true&organization_id=100006568'),
  P('r3-sam-size', 'https://sam.gov/api/prod/sgs/v1/search/?index=opp&page=0&size=100&sort=-modifiedDate&mode=search&is_active=true', { keep: 20000 }),
  P('r3-sam-fh', 'https://sam.gov/api/prod/federalorganizations/v1/organizations/hierarchy?q=national%20aeronautics&searchBy=name'),
  P('r3-nr-procurement', 'https://www.networkrail.co.uk/industry-and-commercial/supply-chain/procurement/'),
  P('r3-s2w-download', 'https://www.sell2wales.gov.wales/Notice/Download/Download.aspx'),
  P('r3-s2w-api-home', 'https://api.sell2wales.gov.wales/v1'),
  P('r3-s2w-oct', 'https://api.sell2wales.gov.wales/v1/Notices?dateFrom=10-2026&noticeType=2&outputType=0'),
  P('r3-s2w-2025', 'https://api.sell2wales.gov.wales/v1/Notices?dateFrom=01-2025&noticeType=2&outputType=0'),
  P('r3-india', 'https://eprocure.gov.in/cppp/'),
  P('r3-placsp', 'https://contrataciondelestado.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom', { keep: 2000000 }),
  P('r3-gebiz-p1', 'https://www.gebiz.gov.sg/ptn/opportunity/BOListing.xhtml?origin=opportunities', { keep: 400000 }),
  P('r3-nspires-js', 'https://nspires.nasaprs.com/external/solicitations/solicitations.do?method=openJson'),
  P('r3-ccgp-http', 'http://www.ccgp.gov.cn/'),
  P('r3-austender-cn', 'https://api.tenders.gov.au/ocds/findById/CN4289232'),
  P('r3-za', `https://ocds-api.etenders.gov.za/api/OCDSReleases?PageNumber=1&PageSize=50&dateFrom=${iso(ago(7))}&dateTo=${iso(today)}`, { keep: 400000 }),
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
