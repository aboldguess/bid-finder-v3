#!/usr/bin/env node
// TEMPORARY: prints what candidate portal endpoints return, so connectors can
// be written against real responses. Removed before merge.
import { createHttp } from '../src/http/client.js';

const today = new Date();
const iso = (d) => d.toISOString().slice(0, 10);
const ago = (n) => new Date(Date.now() - n * 864e5);
const P = (name, url, opts = {}) => ({ name, url, ...opts });
const FT = new FormData();
const probes = [
  P('grants.gov search2', 'https://api.grants.gov/v1/api/search2', { method: 'POST', json: { rows: 2, oppStatuses: 'forecasted|posted', keyword: '' } }),
  P('grants.gov NASA', 'https://api.grants.gov/v1/api/search2', { method: 'POST', json: { rows: 2, oppStatuses: 'posted', agencies: 'NASA' } }),
  P('eu f&t sedia', 'https://api.tech.ec.europa.eu/search-api/prod/rest/search?apiKey=SEDIA&text=***&pageSize=2&pageNumber=1', { method: 'POST', form: { query: JSON.stringify({ bool: { must: [{ terms: { type: ['1', '2', '8'] } }, { terms: { status: ['31094501', '31094502'] } }] } }), languages: JSON.stringify(['en']), sort: JSON.stringify({ field: 'sortStatus', order: 'ASC' }) } }),
  P('canadabuys csv', 'https://canadabuys.canada.ca/opendata/pub/openTenderNotice-ouvertAvisAppelOffres.csv', { head: 3000 }),
  P('austender rss', 'https://www.tenders.gov.au/public_data/rss/rss.xml'),
  P('austender atm list', 'https://www.tenders.gov.au/atm'),
  P('nz gets rss', 'https://www.gets.govt.nz/ExternalRSS.htm'),
  P('nz gets list', 'https://www.gets.govt.nz/ExternalIndex.htm'),
  P('sg gebiz rss', 'https://www.gebiz.gov.sg/rss/'),
  P('sg gebiz home', 'https://www.gebiz.gov.sg/'),
  P('jetro procurement', 'https://www.jetro.go.jp/en/database/procurement/'),
  P('jp p-portal', 'https://www.p-portal.go.jp/pps-web-biz/UAA01/OAA0101'),
  P('china ccgp central', 'http://www.ccgp.gov.cn/cggg/zygg/'),
  P('china ccgp search', 'https://search.ccgp.gov.cn/bxsearch?searchtype=1&page_index=1&bidSort=0&pinMu=0&bidType=1&kw=&timeType=2'),
  P('sam internal search', 'https://sam.gov/api/prod/sgs/v1/search/?index=opp&page=0&size=2&sort=-modifiedDate&mode=search&is_active=true'),
  P('esa emits', 'https://emits.sso.esa.int/emits/owa/emits_online.showall'),
  P('esa emits rss', 'https://emits.sso.esa.int/emits/owa/emits_online.rss'),
  P('esa-star', 'https://esastar-publication.sso.esa.int/'),
  P('nasa nspires', 'https://nspires.nasaprs.com/external/solicitations/solicitations.do?method=open&stack=push'),
  P('boamp ods', `https://boamp-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/boamp/records?limit=2&order_by=dateparution%20desc&where=nature%3D%22APPEL_OFFRE%22`),
  P('de service.bund rss', 'https://www.service.bund.de/Content/DE/Ausschreibungen/Suche/Formular.html?nn=4641482&view=renderRSS'),
  P('de service.bund rss2', 'https://www.service.bund.de/SiteGlobals/Functions/RSSFeed/RSSGenerator_Ausschreibungen.xml'),
  P('nl tenderned papi', 'https://www.tenderned.nl/papi/tenderned-rs-tns/v2/publicaties?page=0&size=2'),
  P('es placsp atom', 'https://contrataciondelestado.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom', { head: 3000 }),
  P('za etenders ocds', `https://ocds-api.etenders.gov.za/api/OCDSReleases?PageNumber=1&PageSize=2&dateFrom=${iso(ago(7))}&dateTo=${iso(today)}`),
  P('worldbank procnotices', 'https://search.worldbank.org/api/v2/procnotices?format=json&rows=2&os=0&srt=submission_date&order=desc'),
  P('adb tenders rss', 'https://www.adb.org/projects/tenders/feed'),
  P('india cppp', 'https://eprocure.gov.in/cppp/latestactivetendersnew/cpppdata'),
  P('ungm', 'https://www.ungm.org/Public/Notice'),
  P('ie etenders', 'https://www.etenders.gov.ie/epps/quickSearchAction.do?searchSelect=1'),
  P('network rail', 'https://www.networkrail.co.uk/industry-and-commercial/supply-chain/current-procurement-opportunities/'),
  P('dot grants via grants.gov', 'https://api.grants.gov/v1/api/search2', { method: 'POST', json: { rows: 1, oppStatuses: 'posted', agencies: 'DOT' } }),
];

const http = createHttp({ minDelayMs: 500, retries: 0 });
for (const p of probes) {
  const opts = { accept: '*/*' };
  if (p.json) Object.assign(opts, { method: 'POST', body: JSON.stringify(p.json), headers: { 'Content-Type': 'application/json' } });
  if (p.form) { const f = new FormData(); for (const [k, v] of Object.entries(p.form)) f.append(k, new Blob([v], { type: 'application/json' })); Object.assign(opts, { method: 'POST', body: f }); }
  const started = Date.now();
  try {
    const body = await http.get(p.url, opts);
    console.log(`\n===== ${p.name} OK ${Date.now() - started}ms len=${body.length}\n${body.slice(0, p.head || 1800)}`);
  } catch (err) {
    console.log(`\n===== ${p.name} FAIL ${err.status || ''} ${err.message.slice(0, 300)}`);
  }
}
