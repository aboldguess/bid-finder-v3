// Grants.gov: every US federal grant (NASA, DoT, NSF, DoE, NIH and the rest),
// via the official search2 API. No key needed. Posted and forecast
// opportunities; the agency setting narrows it to one or more agencies.
import { fetchText, htmlText, opportunity, parseUsDate } from './util.js';

const API = 'https://api.grants.gov/v1/api/search2';
const ROWS = 250;

export function parsePage(json) {
  const data = (typeof json === 'string' ? JSON.parse(json) : json).data || {};
  const items = (data.oppHits || []).map((o) => opportunity({
    external_id: String(o.id),
    title: htmlText(o.title),
    summary: [o.number && `Funding opportunity ${o.number}`, o.cfdaList?.length && `Assistance listing ${o.cfdaList.join(', ')}`].filter(Boolean).join(' · '),
    url: `https://www.grants.gov/search-results-detail/${o.id}`,
    funder: htmlText(o.agency || o.agencyCode),
    location: 'United States',
    status: o.oppStatus || '',
    opens_at: parseUsDate(o.openDate, { endOfDay: false }),
    closes_at: parseUsDate(o.closeDate),
    country: 'US',
    currency: 'USD',
    notice_type: o.docType === 'forecast' ? 'Forecast' : 'Grant opportunity',
  })).filter((i) => i.external_id && i.title);
  return { items, total: Number(data.hitCount) || 0 };
}

// "NASA, DOT" or "NASA|DOT-FHWA" -> "NASA|DOT-FHWA". Agency codes are letters, digits and hyphens.
export const agencyParam = (value) => String(value || '').split(/[,|\s]+/).filter((a) => /^[A-Z0-9-]{2,20}$/i.test(a)).map((a) => a.toUpperCase()).join('|');

export function grantsGovConnector({ key = 'grants-gov', name = 'Grants.gov (US federal grants)', agencies = '', enabledByDefault = false } = {}) {
  return {
    key,
    name,
    type: 'grant',
    homepage: 'https://www.grants.gov',
    access: 'Official search API',
    intervalMinutes: 720,
    minDelayMs: 1000,
    enabledByDefault,
    settings: [
      { key: 'agencies', label: 'Agencies', placeholder: agencies || 'NASA, DOT, DOE, NSF', help: 'Grants.gov agency codes, comma-separated. A parent code (DOT) does not include its sub-agencies (DOT-FHWA), so list both. Empty means every agency.' },
      { key: 'keyword', label: 'Keyword', placeholder: 'engineering', help: 'Optional search words.' },
    ],
    async fetch({ maxPages = 20, get = fetchText, now = Date.now(), config = {} } = {}) {
      const all = new Map();
      for (let page = 0; page < maxPages; page++) {
        const body = { rows: ROWS, startRecordNum: page * ROWS, oppStatuses: 'forecasted|posted', agencies: agencyParam(config.agencies || agencies), keyword: String(config.keyword || '').slice(0, 200) };
        const { items, total } = parsePage(await get(API, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, accept: 'application/json' }));
        items.forEach((i) => all.set(i.external_id, i));
        if (!items.length || (page + 1) * ROWS >= total) break;
      }
      return [...all.values()].filter((i) => !i.closes_at || Date.parse(i.closes_at) > now);
    },
  };
}

export default grantsGovConnector();
