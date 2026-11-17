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
  P('grants-gov', 'https://api.grants.gov/v1/api/search2', { method: 'POST', json: { rows: 5, oppStatuses: 'forecasted|posted', keyword: '' } }),
  P('grants-gov-agencies', 'https://api.grants.gov/v1/api/search2', { method: 'POST', json: { rows: 1, oppStatuses: 'posted|forecasted', agencies: 'DOT-FHWA|DOT-FTA|DOT-FAA|DOT', keyword: '' } }),
  P('grants-gov-fetch', 'https://api.grants.gov/v1/api/fetchOpportunity', { method: 'POST', json: { opportunityId: 355824 } }),
  P('sedia-calls', 'https://api.tech.ec.europa.eu/search-api/prod/rest/search?apiKey=SEDIA&text=***&pageSize=5&pageNumber=1', { form: sedia(['1', '2', '8']) }),
  P('sedia-tenders', 'https://api.tech.ec.europa.eu/search-api/prod/rest/search?apiKey=SEDIA&text=***&pageSize=5&pageNumber=1', { form: sedia(['0']) }),
  P('sedia-facets', 'https://api.tech.ec.europa.eu/search-api/prod/rest/facet?apiKey=SEDIA&text=***', { form: { query: JSON.stringify({ bool: { must: [{ terms: { status: ['31094501', '31094502'] } }] } }), languages: JSON.stringify(['en']) } }),
  P('canadabuys', 'https://canadabuys.canada.ca/opendata/pub/openTenderNotice-ouvertAvisAppelOffres.csv', { keep: 60000 }),
  P('austender-ocds', `https://api.tenders.gov.au/ocds/findByDates/contractPublished/${iso(ago(3))}T00:00:00Z/${iso(today)}T00:00:00Z`),
  P('austender-home', 'https://www.tenders.gov.au/'),
  P('nz-gets', 'https://www.gets.govt.nz/ExternalIndex.htm'),
  P('nz-gets-rss', 'https://www.gets.govt.nz/ExternalTenderRss.htm'),
  P('sg-gebiz-opps', 'https://www.gebiz.gov.sg/ptn/opportunity/BOListing.xhtml?origin=menu'),
  P('sg-gebiz-rss-list', 'https://www.gebiz.gov.sg/ptn/rss/RSSFeeds.xhtml'),
  P('jetro', 'https://www.jetro.go.jp/en/database/procurement/'),
  P('jetro-list', 'https://www.jetro.go.jp/en/database/procurement/national/'),
  P('ccgp-home', 'https://www.ccgp.gov.cn/'),
  P('sam-search', 'https://sam.gov/api/prod/sgs/v1/search/?index=opp&page=0&size=3&sort=-modifiedDate&mode=search&is_active=true&notice_type=o,k,p,r'),
  P('emits', 'https://emits.sso.esa.int/emits/owa/emits_online.showall'),
  P('esa-star', 'https://esastar-publication.sso.esa.int/'),
  P('esa-star-tenders', 'https://esastar-publication-ext.sso.esa.int/ESATenderActions/filter/open'),
  P('nspires', 'https://nspires.nasaprs.com/external/solicitations/solicitations.do?method=open&stack=push'),
  P('boamp', 'https://boamp-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/boamp/records?limit=3&order_by=dateparution%20desc&where=nature%3D%22APPEL_OFFRE%22'),
  P('bund-rss', 'https://www.service.bund.de/SiteGlobals/Functions/RSSFeed/RSSGenerator_Ausschreibungen.xml', { keep: 60000 }),
  P('tenderned', 'https://www.tenderned.nl/papi/tenderned-rs-tns/v2/publicaties?page=0&size=3'),
  P('placsp', 'https://contrataciondelestado.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom', { keep: 60000 }),
  P('za-etenders', `https://ocds-api.etenders.gov.za/api/OCDSReleases?PageNumber=1&PageSize=3&dateFrom=${iso(ago(7))}&dateTo=${iso(today)}`),
  P('worldbank', 'https://search.worldbank.org/api/v2/procnotices?format=json&rows=3&os=0&srt=submission_date&order=desc&fl=id,notice_type,noticedate,submission_deadline_date,project_ctry_name,project_name,bid_reference_no,bid_description,procurement_group,procurement_method_name,contact_organization,submission_date,notice_status'),
  P('india-cppp', 'https://eprocure.gov.in/cppp/latestactivetendersnew'),
  P('india-cppp-rss', 'https://eprocure.gov.in/cppp/rss/latesttenders'),
  P('ie-etenders', 'https://www.etenders.gov.ie/epps/quickSearchAction.do?searchSelect=1&selectedItem=quickSearchAction.do%3FsearchSelect%3D1'),
  P('network-rail', 'https://www.networkrail.co.uk/supply-chain/'),
  P('ukri-iuk', 'https://www.ukri.org/opportunity/?org=innovate-uk'),
  P('ifs-robots', 'https://apply-for-innovation-funding.service.gov.uk/robots.txt'),
  P('ifs-search', 'https://apply-for-innovation-funding.service.gov.uk/competition/search'),
  P('s2w-2', `https://api.sell2wales.gov.wales/v1/Notices?dateFrom=${String(today.getUTCMonth() + 1).padStart(2, '0')}-${today.getUTCFullYear()}&noticeType=2&outputType=0&locale=2057`),
  P('s2w-51', `https://api.sell2wales.gov.wales/v1/Notices?dateFrom=${String(today.getUTCMonth() + 1).padStart(2, '0')}-${today.getUTCFullYear()}&noticeType=51&outputType=0&locale=2057`),
  P('s2w-default', 'https://api.sell2wales.gov.wales/v1/Notices'),
  P('s2w-ted', 'https://api.sell2wales.gov.wales/v1/Notices?noticeType=51&outputType=1'),
  P('s2w-rss', 'https://www.sell2wales.gov.wales/Search/Search_RSS.aspx'),
  P('pcs-2', `https://api.publiccontractsscotland.gov.uk/v1/Notices?dateFrom=${String(today.getUTCMonth() + 1).padStart(2, '0')}-${today.getUTCFullYear()}&noticeType=2&outputType=0`),
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
