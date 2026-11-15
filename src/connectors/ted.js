// TED (Tenders Electronic Daily): EU-wide public procurement notices, via the
// official Search API. Anonymous access, expert-query syntax, and "iteration"
// paging with a token. Off by default: add a query filter first, because
// every contract notice in Europe is a lot of noise for one firm.
import { clean, countryCode, cpvCode, fetchText, isoOrNull, uniq } from './util.js';

const API = 'https://api.ted.europa.eu/v3/notices/search';
const FIELDS = ['publication-number', 'notice-title', 'buyer-name', 'buyer-country', 'classification-cpv', 'publication-date', 'notice-type',
  'deadline-receipt-tender-date-lot', 'place-of-performance', 'estimated-value-proc', 'estimated-value-cur-proc', 'description-proc'];
// If TED renames an optional field the whole request fails, so fall back to these.
const CORE_FIELDS = FIELDS.slice(0, 7);

// TED values come as strings, arrays, or objects keyed by language ("eng").
function text(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return clean(uniq(value.map(text)).join(', '));
  if (typeof value === 'object') return text(value.eng ?? value.ENG ?? value.en ?? Object.values(value)[0]);
  return clean(String(value));
}
const list = (value) => (value == null ? [] : Array.isArray(value) ? value.flatMap(list) : typeof value === 'object' ? Object.values(value).flatMap(list) : [String(value)]);
// "2026-11-30+01:00" and "2026-11-30T12:00:00+01:00" both appear.
const date = (value) => {
  const first = list(value)[0];
  if (!first) return null;
  const m = first.match(/^(\d{4}-\d{2}-\d{2})([+-]\d{2}:\d{2}|Z)?$/);
  return isoOrNull(m ? `${m[1]}T23:59:00${m[2] || 'Z'}` : first);
};

export function parsePage(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const items = (data.notices || []).map((n) => {
    const number = text(n['publication-number']);
    const cpv = uniq(list(n['classification-cpv']).map(cpvCode));
    const value = Number(list(n['estimated-value-proc'])[0]);
    const countries = uniq(list(n['place-of-performance']).concat(list(n['buyer-country'])).map((c) => countryCode(c.slice(0, 3)) || countryCode(c)));
    return {
      external_id: number,
      title: text(n['notice-title']),
      summary: text(n['description-proc']),
      url: `https://ted.europa.eu/en/notice/-/detail/${number}`,
      funder: text(n['buyer-name']),
      location: text(n['place-of-performance']) || text(n['buyer-country']),
      eligibility: cpv.length ? `CPV ${cpv.join(', ')}` : '',
      status: '',
      award_min: null,
      award_max: Number.isFinite(value) && value > 0 ? value : null,
      total_fund: null,
      award_text: '',
      opens_at: null,
      closes_at: date(n['deadline-receipt-tender-date-lot']),
      published_at: date(n['publication-date']),
      cpv_codes: cpv.join(' '),
      country: countries[0] || '',
      currency: text(n['estimated-value-cur-proc']) || 'EUR',
      notice_type: text(n['notice-type']),
    };
  }).filter((i) => i.external_id && i.title);
  return { items, next: data.iterationNextToken || null };
}

export default {
  key: 'ted',
  name: 'TED (EU tenders)',
  type: 'tender',
  homepage: 'https://ted.europa.eu',
  access: 'Official Search API',
  intervalMinutes: 360,
  minDelayMs: 2000,
  enabledByDefault: false,
  settings: [{ key: 'query', label: 'Extra query filter', placeholder: 'classification-cpv IN (71000000 42000000) AND buyer-country IN (IRL NLD DEU)', help: 'TED expert-search syntax, ANDed with "open contract notices from the last 14 days". Leave empty for everything.' }],
  async fetch({ maxPages = 40, get = fetchText, days = 14, since, now = Date.now(), config = {} } = {}) {
    const from = new Date(since ? Date.parse(since) - 864e5 : now - days * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
    const query = `notice-type IN (cn-standard cn-social) AND publication-date>=${from}${config.query ? ` AND (${config.query})` : ''}`;
    const all = new Map();
    let token;
    let fields = FIELDS;
    for (let page = 0; page < maxPages; page++) {
      const body = JSON.stringify({ query, fields, limit: 250, scope: 'ACTIVE', paginationMode: 'ITERATION', ...(token ? { iterationNextToken: token } : {}) });
      let textBody;
      try {
        textBody = await get(API, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, accept: 'application/json' });
      } catch (err) {
        if (err.status === 400 && fields === FIELDS && page === 0) { fields = CORE_FIELDS; page--; continue; }
        throw err;
      }
      const { items, next } = parsePage(textBody);
      items.forEach((i) => all.set(i.external_id, i));
      if (!next || !items.length) break;
      token = next;
    }
    return [...all.values()].filter((i) => !i.closes_at || Date.parse(i.closes_at) > now);
  },
};
