// SAM.gov: US federal contract opportunities (every agency: NASA, DoT, DoD,
// DoE and the rest). Two ways in:
//  - with an API key from a SAM.gov account (credential vault): the official
//    Get Opportunities API, limited to a few requests a day;
//  - without a key: the public search service that SAM.gov's own search page
//    uses, which needs no account. This is the default.
import { clean, fetchText, htmlText, isoOrNull, opportunity } from './util.js';

const API = 'https://api.sam.gov/opportunities/v2/search';
const usDate = (ms) => { const d = new Date(ms); return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`; };

export function parsePage(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const items = (data.opportunitiesData || []).filter((o) => String(o.active ?? 'Yes').toLowerCase() !== 'no' && !/award|justification/i.test(o.type || '')).map((o) => {
    const place = o.placeOfPerformance || {};
    const location = [place.city?.name, place.state?.name || place.state?.code, place.country?.name || place.country?.code].filter(Boolean).join(', ');
    return {
      external_id: o.noticeId,
      title: clean(o.title),
      summary: [o.type, o.solicitationNumber && `Solicitation ${o.solicitationNumber}`].filter(Boolean).join(' · '),
      url: o.uiLink || `https://sam.gov/opp/${o.noticeId}/view`,
      funder: clean((o.fullParentPathName || '').split('.').slice(0, 2).join(' · ')),
      location,
      eligibility: [o.naicsCode && `NAICS ${o.naicsCode}`, o.classificationCode && `PSC ${o.classificationCode}`, o.typeOfSetAsideDescription].filter(Boolean).join('; '),
      status: '',
      award_min: null,
      award_max: null,
      total_fund: null,
      award_text: '',
      opens_at: null,
      closes_at: isoOrNull(o.responseDeadLine),
      published_at: isoOrNull(o.postedDate),
      cpv_codes: '',
      country: 'US',
      currency: 'USD',
      notice_type: clean(o.type),
    };
  }).filter((i) => i.external_id && i.title);
  return { items, total: Number(data.totalRecords) || items.length };
}

const SEARCH = 'https://sam.gov/api/prod/sgs/v1/search/';
const SEARCH_SIZE = 100;
// Award, justification and surplus-sale notices are not opportunities to bid.
const NOT_OPEN = new Set(['a', 'u', 'j', 'g']);
const TYPE_CODES = /^[a-z](,[a-z])*$/;

export function parseSearchPage(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const raw = data._embedded?.results || [];
  const items = raw.filter((o) => o.isActive !== false && !o.isCanceled && !NOT_OPEN.has(o.type?.code)).map((o) => {
    const orgs = [...(o.organizationHierarchy || [])].sort((a, b) => a.level - b.level);
    const office = orgs.at(-1)?.address || {};
    return opportunity({
      external_id: o._id,
      title: htmlText(o.title),
      summary: htmlText(o.descriptions?.[0]?.content).slice(0, 4000),
      url: `https://sam.gov/opp/${o._id}/view`,
      funder: clean(orgs.slice(0, 2).map((x) => x.name).filter((n, i, a) => a.indexOf(n) === i).join(' · ')),
      location: [office.city, office.state].filter(Boolean).join(', ') || 'United States',
      eligibility: [o.solicitationNumber && `Solicitation ${o.solicitationNumber}`, orgs.at(-1)?.name].filter(Boolean).join(' · '),
      closes_at: isoOrNull(o.responseDateActual || o.responseDate),
      published_at: isoOrNull(o.publishDate),
      country: 'US',
      currency: 'USD',
      notice_type: clean(o.type?.value),
    });
  }).filter((i) => i.external_id && i.title);
  return { items, raw, totalPages: Number(data.page?.totalPages) || 0 };
}

// Public search: newest first, back to the last run.
async function fetchPublic({ maxPages, get, from, now, config }) {
  const all = new Map();
  for (let page = 0; page < Math.min(maxPages, Math.floor(10000 / SEARCH_SIZE)); page++) {
    const params = new URLSearchParams({ index: 'opp', page: String(page), size: String(SEARCH_SIZE), sort: '-modifiedDate', mode: 'search', is_active: 'true' });
    const q = clean(config.keyword).slice(0, 200);
    if (q) params.set('q', q);
    if (TYPE_CODES.test(config.ptype || '')) params.set('notice_type', config.ptype);
    const { items, raw, totalPages } = parseSearchPage(await get(`${SEARCH}?${params}`, { accept: 'application/hal+json, application/json;q=0.9, */*;q=0.8' }));
    items.forEach((i) => all.set(i.external_id, i));
    const oldest = raw.map((o) => Date.parse(o.modifiedDate)).filter(Number.isFinite).sort((a, b) => a - b)[0];
    if (!raw.length || page + 1 >= totalPages || oldest < from) break;
  }
  return [...all.values()].filter((i) => !i.closes_at || Date.parse(i.closes_at) > now);
}

export default {
  key: 'sam-gov',
  name: 'SAM.gov (US federal)',
  type: 'tender',
  homepage: 'https://sam.gov',
  access: 'Public search, or the official API with a key',
  auth: 'api-key',
  intervalMinutes: 720,
  minDelayMs: 2000,
  enabledByDefault: false,
  settings: [
    { key: 'ncode', label: 'NAICS code', placeholder: '541330', help: 'Optional. 541330 is Engineering Services.' },
    { key: 'ptype', label: 'Notice type', placeholder: 'o', help: 'Optional single code: o solicitation, k combined synopsis, p presolicitation, r sources sought. Empty means all except awards.' },
    { key: 'keyword', label: 'Keyword', placeholder: 'NATIONAL AERONAUTICS AND SPACE ADMINISTRATION', help: 'Optional search words, used without a key. An agency\'s full name finds its notices.' },
  ],
  async fetch({ maxPages = 5, get = fetchText, days = 7, since, now = Date.now(), config = {}, credential } = {}) {
    const from = since ? Math.max(Date.parse(since) - 864e5, now - 30 * 864e5) : now - days * 864e5;
    if (!credential?.key) return fetchPublic({ maxPages, get, from, now, config });
    const all = new Map();
    for (let page = 0; page < Math.min(maxPages, 5); page++) {
      const params = new URLSearchParams({ api_key: credential.key, postedFrom: usDate(from), postedTo: usDate(now), limit: '1000', offset: String(page) });
      if (/^[a-z]$/.test(config.ptype || '')) params.set('ptype', config.ptype);
      if (/^\d{2,6}$/.test(config.ncode || '')) params.set('ncode', config.ncode);
      const { items, total } = parsePage(await get(`${API}?${params}`, { accept: 'application/json' }));
      items.forEach((i) => all.set(i.external_id, i));
      if (!items.length || (page + 1) * 1000 >= total) break;
    }
    return [...all.values()].filter((i) => !i.closes_at || Date.parse(i.closes_at) > now);
  },
};
