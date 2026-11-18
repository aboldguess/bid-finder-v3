// Connectors for portals beyond the UK, each against a trimmed copy of what
// the live service returned (contact details replaced).
import { fixture } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import grantsGov, { parsePage as parseGrantsGov, agencyParam } from '../src/connectors/grantsGov.js';
import { euFunding, euTenders, parsePage as parseSedia, nextDeadline } from '../src/connectors/euFunding.js';
import boamp, { parsePage as parseBoamp } from '../src/connectors/boamp.js';
import tenderNed, { parsePage as parseTenderNed } from '../src/connectors/tenderNed.js';
import serviceBund, { parseFeed as parseBund, parseGermanDate } from '../src/connectors/serviceBund.js';
import placsp, { parseFeed as parsePlacsp } from '../src/connectors/placsp.js';
import canadaBuys, { parseCsvFile } from '../src/connectors/canadaBuys.js';
import getsNz, { parsePage as parseGets, parseGetsDate } from '../src/connectors/getsNz.js';
import gebiz, { parsePage as parseGebiz } from '../src/connectors/gebiz.js';
import jetro, { parseFile as parseJetro } from '../src/connectors/jetro.js';
import esaStar, { parsePage as parseEsa } from '../src/connectors/esaStar.js';
import etendersZa, { parsePage as parseZa } from '../src/connectors/etendersZa.js';
import worldBank, { parsePage as parseWorldBank } from '../src/connectors/worldBank.js';
import samGov, { parseSearchPage } from '../src/connectors/samGov.js';
import { watchConnector } from '../src/connectors/watch.js';
import { connectors } from '../src/connectors/index.js';
import { parseCsv, localToIso, easternOffset, cetOffset } from '../src/connectors/util.js';

const now = Date.parse('2026-11-17T21:00:00Z');
const looksRight = (items) => {
  for (const i of items) {
    assert.ok(i.external_id && i.title, 'id and title');
    assert.match(i.url, /^https:\/\//);
    for (const f of ['closes_at', 'opens_at', 'published_at']) assert.ok(i[f] == null || !Number.isNaN(Date.parse(i[f])), `${f} ${i[f]}`);
  }
};

test('time zone helpers', () => {
  assert.equal(cetOffset('2026-07-01'), '+02:00');
  assert.equal(cetOffset('2026-12-01'), '+01:00');
  assert.equal(easternOffset('2026-07-01'), '-04:00');
  assert.equal(easternOffset('2026-12-15'), '-05:00');
  assert.equal(localToIso('2026-12-09T16:00:00'), '2026-12-09T15:00:00.000Z');
  assert.equal(localToIso('2026-12-09'), '2026-12-09T22:59:00.000Z');
  assert.equal(localToIso('2026-12-14T11:00:00+00:00'), '2026-12-14T11:00:00.000Z');
  assert.deepEqual(parseCsv('a,b\r\n"x, ""y""","line\nbreak"\r\n'), [{ a: 'x, "y"', b: 'line\nbreak' }]);
});

test('Grants.gov: search results, agency filter, paging by hit count', async () => {
  const { items, total } = parseGrantsGov(fixture('grants-gov.json'));
  assert.equal(total, 1403);
  assert.equal(items.length, 3);
  assert.equal(items[0].url, 'https://www.grants.gov/search-results-detail/355824');
  assert.equal(items[0].notice_type, 'Forecast');
  assert.equal(items[0].opens_at, '2024-08-01T05:00:00.000Z');
  looksRight(items);
  assert.equal(agencyParam('nasa, DOT-FHWA|bad agency!'), 'NASA|DOT-FHWA|BAD');
  const bodies = [];
  await grantsGov.fetch({ now, config: { agencies: 'NASA' }, get: async (url, opts) => { bodies.push(JSON.parse(opts.body)); return fixture('grants-gov.json'); }, maxPages: 2 });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].agencies, 'NASA');
  assert.equal(bodies[1].startRecordNum, 250);
});

test('EU Funding & Tenders: calls and tenders, next deadline, past deadlines dropped', async () => {
  const calls = parseSedia(fixture('eu-funding.json'), { now });
  assert.equal(calls.total, 1182);
  assert.equal(calls.items[0].notice_type, 'Cascade funding call');
  assert.equal(calls.items[0].total_fund, 2000000);
  looksRight(calls.items);
  const tenders = parseSedia(fixture('eu-tenders.json'), { now });
  const cloud = tenders.items.find((t) => /CLOUD III/.test(t.title));
  assert.equal(cloud.award_max, 1200000000);
  assert.equal(cloud.funder, 'European Commission, DG DIGIT - Digital Services');
  assert.equal(cloud.cpv_codes, '72000000');
  assert.equal(nextDeadline(['2026-02-15T23:59:00.000+0000', '2027-02-14T23:59:00.000+0000'], now), '2027-02-14T23:59:00.000Z');
  let form;
  const open = await euFunding.fetch({ now, get: async (url, opts) => { form = opts.body; return fixture('eu-funding.json'); }, maxPages: 1 });
  assert.ok(open.every((i) => !i.closes_at || Date.parse(i.closes_at) > now));
  assert.match(await form.get('query').text(), /"type":\["1","2","8"\]/);
  assert.equal(euTenders.type, 'tender');
});

test('BOAMP: contract notices with the deadline from the API', async () => {
  const { items } = parseBoamp(fixture('boamp.json'));
  assert.equal(items[0].external_id, '26-110857');
  assert.equal(items[0].closes_at, '2026-12-14T11:00:00.000Z');
  assert.equal(items[0].country, 'FR');
  assert.match(items[0].funder, /D'ADDUCTION/);
  looksRight(items);
  let url;
  await boamp.fetch({ now, maxPages: 1, config: { keyword: 'route "x"' }, get: async (u) => { url = decodeURIComponent(u.replace(/\+/g, ' ')); return fixture('boamp.json'); } });
  assert.match(url, /nature="APPEL_OFFRE" AND dateparution>=date'2026-11-03' AND datelimitereponse>now\(\) AND search\(objet, "route x"\)/);
});

test('TenderNed: skips corrections, reads Dutch local times', async () => {
  const { items } = parseTenderNed(fixture('tenderned.json'));
  assert.ok(items.every((i) => i.notice_type !== 'Rectificatie'));
  assert.equal(items[0].country, 'NL');
  looksRight(items);
  assert.ok((await tenderNed.fetch({ now, get: async () => fixture('tenderned.json') })).length >= 1);
});

test('service.bund.de: RSS items with buyer, place and end of publication', async () => {
  const items = parseBund(fixture('service-bund.xml'));
  assert.equal(items.length, 3);
  assert.equal(items[0].funder, 'Stadtwerke Ingolstadt Beteiligungen GmbH');
  assert.equal(items[0].location, '85057 Ingolstadt');
  assert.equal(items[0].closes_at, '2027-01-12T23:00:00.000Z');
  assert.doesNotMatch(items[0].summary, /@|Tel\./, 'no contact details');
  assert.equal(parseGermanDate('01.07.2026 12:00'), '2026-07-01T10:00:00.000Z');
  looksRight(items);
  assert.equal((await serviceBund.fetch({ now, get: async () => fixture('service-bund.xml') })).length, 3);
});

test('PLACSP: only tenders open for bids, with deadline, value and CPV', async () => {
  const { items, next } = parsePlacsp(fixture('placsp.atom'));
  assert.equal(items.length, 2);
  assert.match(next, /licitacionesPerfilesContratanteCompleto3_\d+_\d+\.atom$/);
  assert.equal(items[0].status, 'Open');
  assert.ok(items[0].award_max > 0);
  assert.match(items[0].cpv_codes, /^\d{8}/);
  looksRight(items);
  const urls = [];
  await placsp.fetch({ now, maxPages: 3, get: async (u) => { urls.push(u); return fixture('placsp.atom'); } });
  assert.ok(urls.length >= 1);
});

test('CanadaBuys: open tender CSV, Eastern time deadlines', async () => {
  const items = parseCsvFile(fixture('canadabuys.csv'));
  assert.equal(items.length, 2);
  assert.equal(items[0].funder, 'VIA Rail Canada Inc.');
  assert.equal(items[0].closes_at, '2026-12-15T19:00:00.000Z');
  assert.equal(items[0].currency, 'CAD');
  looksRight(items);
  assert.equal((await canadaBuys.fetch({ now, get: async () => fixture('canadabuys.csv') })).length, 2);
});

test('GETS: listing rows with explicit UTC offsets; pages until nothing new', async () => {
  const { items, lastPage } = parseGets(fixture('gets-nz.html'));
  assert.equal(items.length, 3);
  assert.equal(items[0].funder, 'Whangarei District Council');
  assert.equal(items[0].closes_at, '2026-11-17T23:00:00.000Z');
  assert.ok(lastPage >= 2);
  assert.equal(parseGetsDate('9:30 AM 2 Mar 2027 (Pacific/Auckland UTC+13:00)'), '2027-03-01T20:30:00.000Z');
  looksRight(items);
  const pages = [];
  await getsNz.fetch({ now, delayMs: 0, get: async (u) => { pages.push(u); return fixture('gets-nz.html'); } });
  assert.equal(pages.length, 2);
});

test('GeBIZ: opportunities with agency, category and closing time (SGT)', async () => {
  const items = parseGebiz(fixture('gebiz.html'));
  assert.equal(items.length, 2);
  assert.equal(items[0].external_id, 'DEFNGPP7126102230');
  assert.equal(items[0].funder, 'Ministry of Defence 6');
  assert.equal(items[0].closes_at, '2026-12-08T08:00:00.000Z');
  assert.equal(items[0].notice_type, 'Tender Lite');
  looksRight(items);
  assert.equal(gebiz.respectRobots, true);
});

test('JETRO: national and local notices, Japanese deadlines, non-opportunities dropped', async () => {
  const central = parseJetro(fixture('jetro-central.json'), 'central');
  assert.match(central[0].url, /\/national\/articles\/\d+\/\d+\.html$/);
  assert.equal(central[0].closes_at, '2027-02-01T14:59:00.000Z');
  assert.equal(central[0].country, 'JP');
  const local = parseJetro(fixture('jetro-local.json'), 'local');
  assert.match(local[0].url, /\/local\/articles\/[0-9a-f]+\.html$/);
  assert.equal(local[0].location, 'Hokkaido, Japan');
  looksRight([...central, ...local]);
  const items = await jetro.fetch({ now, get: async (u) => fixture(/central/.test(u) ? 'jetro-central.json' : 'jetro-local.json') });
  assert.ok(!items.some((i) => /single tendering/i.test(i.notice_type)));
  assert.ok(items.some((i) => i.external_id.startsWith('l-')));
});

test('ESA: intended and issued tender actions only', async () => {
  const { items, total } = parseEsa(fixture('esa-star.json'));
  assert.equal(total, 1434);
  assert.equal(items.length, 1, 'awarded ones are dropped');
  assert.equal(items[0].status, 'Intended');
  assert.equal(items[0].url, 'https://esastar-publication-ext.sso.esa.int/ESATenderActions/details/199020');
  assert.equal(items[0].published_at, '2026-11-17T15:08:59.000Z');
  const urls = [];
  await esaStar.fetch({ now, get: async (u) => { urls.push(u); return fixture('esa-star.json'); } });
  assert.equal(urls[0], 'https://esastar-publication-ext.sso.esa.int/api/tenderAction/filter/100/0');
});

test('South Africa eTenders: OCDS, reference-only titles replaced by the description', async () => {
  const page = { releases: [{ ocid: 'ocds-9t57fa-178486', id: 'x', date: '2026-11-17T00:00:00Z', tag: ['compiled'], tender: { id: '178486', title: 'RFQJW094KM26', status: '', description: 'Loss adjuster services', mainProcurementCategory: 'services', value: { amount: 0, currency: 'ZAR' }, tenderPeriod: { startDate: '2026-11-17T00:00:00Z', endDate: '2026-11-24T16:00:00Z' }, procuringEntity: { id: '279', name: 'Johannesburg Water' }, procurementMethodDetails: 'Request for Quotation' } }] };
  const { items } = parseZa(JSON.stringify(page));
  assert.equal(items[0].title, 'Loss adjuster services');
  assert.match(items[0].summary, /Reference RFQJW094KM26/);
  assert.equal(items[0].funder, 'Johannesburg Water');
  assert.equal(items[0].award_max, null, 'a zero value means unknown');
  assert.equal(items[0].country, 'ZA');
  const got = await etendersZa.fetch({ now, get: async () => JSON.stringify(page) });
  assert.equal(got.length, 1);
});

test('World Bank: bids and expressions of interest, not awards', async () => {
  const { items } = parseWorldBank(fixture('world-bank.json'));
  assert.ok(items.length >= 1);
  assert.ok(items.every((i) => !/award/i.test(i.notice_type)));
  assert.equal(items[0].location, 'Angola');
  looksRight(items);
  const got = await worldBank.fetch({ now, config: { countries: 'angola' }, get: async () => fixture('world-bank.json') });
  assert.ok(got.every((i) => i.location === 'Angola'));
});

test('SAM.gov without a key: public search, newest first, awards skipped', async () => {
  const { items } = parseSearchPage(fixture('sam-search.json'));
  assert.ok(items.length >= 1);
  assert.match(items[0].url, /^https:\/\/sam\.gov\/opp\/[0-9a-f]{32}\/view$/);
  assert.equal(items[0].country, 'US');
  looksRight(items);
  const urls = [];
  await samGov.fetch({ now, config: { keyword: 'NATIONAL AERONAUTICS' }, get: async (u) => { urls.push(u); return fixture('sam-search.json'); } });
  assert.match(urls[0], /^https:\/\/sam\.gov\/api\/prod\/sgs\/v1\/search\/\?index=opp&page=0&size=100&.*q=NATIONAL\+AERONAUTICS/);
  assert.doesNotMatch(urls[0], /api_key/);
});

test('watch sources: filter by body, keep going when one portal fails', async () => {
  const a = { key: 'a', name: 'A', type: 'tender', fetch: async () => [{ external_id: '1', title: 'Track renewal', funder: 'Network Rail Infrastructure Ltd' }, { external_id: '2', title: 'Other', funder: 'Some Council' }] };
  const b = { key: 'b', name: 'B', type: 'grant', fetch: async () => { throw new Error('down'); } };
  const w = watchConnector({ key: 'w', name: 'W', parts: [{ connector: a }, { connector: b }], match: /network rail/i });
  const items = await w.fetch({});
  assert.deepEqual(items.map((i) => i.external_id), ['a:1']);
  assert.equal(items[0].type, 'tender');
  const dead = watchConnector({ key: 'd', name: 'D', parts: [{ connector: b }] });
  await assert.rejects(dead.fetch({}), /B: down/);
  const keys = connectors.map((c) => c.key);
  for (const k of ['watch-network-rail', 'watch-nasa', 'watch-us-dot']) assert.ok(keys.includes(k), k);
});

test('robots.txt: a server error after a redirect off-site counts as absent only when the source opts in', async () => {
  const { createHttp, resetHttpState } = await import('../src/http/client.js');
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/robots.txt')) return { ok: false, status: 500, redirected: true, url: 'https://auth.example.org/sso', text: async () => '' };
    return new Response('<html>ok</html>', { status: 200 });
  };
  resetHttpState();
  const strict = createHttp({ fetchImpl, respectRobots: true, minDelayMs: 0, retries: 0 });
  await assert.rejects(strict.get('https://site.example.org/list'), /disallows .*HTTP 500 after a redirect to auth\.example\.org/);
  const lenient = createHttp({ fetchImpl, respectRobots: true, robotsOffsiteError: 'allow', minDelayMs: 0, retries: 0 });
  assert.equal(await lenient.get('https://site.example.org/list'), '<html>ok</html>');
  const sameHost = async (url) => (String(url).endsWith('/robots.txt') ? { ok: false, status: 503, redirected: false, url, text: async () => '' } : new Response('ok'));
  resetHttpState();
  await assert.rejects(createHttp({ fetchImpl: sameHost, respectRobots: true, robotsOffsiteError: 'allow', minDelayMs: 0, retries: 0 }).get('https://other.example.org/x'), /disallows/);
});
