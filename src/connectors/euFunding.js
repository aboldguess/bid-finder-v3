// EU Funding & Tenders Portal (SEDIA): Horizon Europe, Digital Europe, EIC,
// LIFE, CEF and every other centrally managed EU programme, plus calls for
// third-party ("cascade") funding and the EU institutions' own tenders.
// Read through the portal's own public search API, which the portal's search
// page uses. It needs no account; "SEDIA" is the portal's public key.
import { clean, cpvCode, fetchText, htmlText, isoOrNull, opportunity, uniq } from './util.js';

const API = 'https://api.tech.ec.europa.eu/search-api/prod/rest/search';
const PAGE_SIZE = 100;
const OPEN_STATUSES = ['31094501', '31094502']; // forthcoming, open
const TYPES = { 0: 'Tender', 1: 'Call topic', 2: 'Call for proposals', 8: 'Cascade funding call' };

const all = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]).map((x) => String(x));
const first = (v) => clean(all(v)[0]);
const json = (v) => { try { return JSON.parse(first(v)); } catch { return null; } };
// SEDIA dates look like "2026-12-31T23:59:00.000+0000".
const date = (v) => isoOrNull(String(v || '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));

// The next deadline still ahead, for calls with several cut-offs; else the last one.
export function nextDeadline(values, now = Date.now()) {
  const dates = all(values).map(date).filter(Boolean).sort();
  return dates.find((d) => Date.parse(d) > now) || dates.at(-1) || null;
}

export function parsePage(body, { now = Date.now() } = {}) {
  const data = typeof body === 'string' ? JSON.parse(body) : body;
  const items = (data.results || []).map((r) => {
    const m = r.metadata || {};
    const type = first(m.type);
    const isTender = type === '0';
    const identifier = first(m.identifier) || r.reference;
    const title = htmlText(first(m.callTitle) && type === '8' ? first(m.callTitle) : first(m.title) || r.summary);
    const budget = Number(first(m.budget));
    const value = Number((first(m.cftEstimatedTotalProcedureValue).match(/[\d.]+/) || [])[0]);
    const authorities = json(m.cftLeadContractingAuthorityCode) || [];
    const cpv = uniq(all(m.mainCpv).map(cpvCode));
    return opportunity({
      external_id: r.reference || identifier,
      title,
      summary: htmlText(first(m.description)).slice(0, 4000),
      url: r.url || `https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/${identifier}`,
      funder: isTender ? clean(authorities.map((a) => a.name).join(', ')) || 'EU institutions' : type === '8' ? clean(first(m.title)) || 'EU-funded project' : 'European Commission',
      location: 'European Union',
      eligibility: [identifier && identifier !== title ? identifier : '', first(m.callIdentifier), first(m.deadlineModel)].filter(Boolean).join(' · '),
      status: first(m.status) === '31094501' ? 'Forthcoming' : 'Open',
      award_max: isTender ? (Number.isFinite(value) && value > 0 ? value : null) : null,
      total_fund: !isTender && Number.isFinite(budget) && budget > 0 ? budget : null,
      opens_at: date(first(m.startDate)),
      closes_at: nextDeadline(m.deadlineDate, now),
      published_at: date(first(m.startDate)),
      cpv_codes: cpv.join(' '),
      country: '',
      currency: first(m.cftEstimatedOverallContractCurrency) || 'EUR',
      notice_type: TYPES[type] || '',
    });
  }).filter((i) => i.external_id && i.title);
  return { items, total: Number(data.totalResults) || 0 };
}

function formBody(types, keyword) {
  const form = new FormData();
  const part = (name, value) => form.append(name, new Blob([JSON.stringify(value)], { type: 'application/json' }));
  part('query', { bool: { must: [{ terms: { type: types } }, { terms: { status: OPEN_STATUSES } }] } });
  part('languages', ['en']);
  part('sort', { field: 'sortStatus', order: 'ASC' });
  return form;
}

function sediaConnector({ key, name, type, types, homepage, settingsHelp }) {
  return {
    key,
    name,
    type,
    homepage,
    access: 'Portal search API',
    intervalMinutes: 720,
    minDelayMs: 1500,
    enabledByDefault: false,
    settings: [{ key: 'keyword', label: 'Keyword', placeholder: 'hydrogen', help: settingsHelp }],
    async fetch({ maxPages = 30, get = fetchText, now = Date.now(), config = {} } = {}) {
      const text = encodeURIComponent(clean(config.keyword).slice(0, 200) || '***');
      const found = new Map();
      for (let page = 1; page <= maxPages; page++) {
        const url = `${API}?apiKey=SEDIA&text=${text}&pageSize=${PAGE_SIZE}&pageNumber=${page}`;
        const { items, total } = parsePage(await get(url, { method: 'POST', body: formBody(types), accept: 'application/json' }), { now });
        items.forEach((i) => found.set(i.external_id, i));
        if (!items.length || page * PAGE_SIZE >= total) break;
      }
      // "Open" on the portal includes calls whose last deadline has passed.
      return [...found.values()].filter((i) => !i.closes_at || Date.parse(i.closes_at) > now);
    },
  };
}

export const euFunding = sediaConnector({
  key: 'eu-funding',
  name: 'EU Funding & Tenders: grants',
  type: 'grant',
  types: ['1', '2', '8'],
  homepage: 'https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/calls-for-proposals',
  settingsHelp: 'Optional search words. Covers Horizon Europe, Digital Europe, EIC, LIFE, CEF and the rest, plus third-party (cascade) funding calls.',
});

export const euTenders = sediaConnector({
  key: 'eu-tenders',
  name: 'EU Funding & Tenders: EU institution tenders',
  type: 'tender',
  types: ['0'],
  homepage: 'https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/calls-for-tenders',
  settingsHelp: 'Optional search words. Tenders run by the Commission, EU agencies and EU delegations worldwide.',
});
