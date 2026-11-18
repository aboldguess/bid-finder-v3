// ESA (European Space Agency) invitations to tender and calls for proposals,
// from esa-star Publication, ESA's public tender portal, through the same
// public interface its web pages use. No account is needed to read it.
import { clean, fetchText, htmlText, isoOrNull, opportunity, stillOpen } from './util.js';

const BASE = 'https://esastar-publication-ext.sso.esa.int';
const TAKE = 100;
// Status 1 is "Intended" (planned), 2 is "Issued" (open for tenders).
const STATUS = { 1: 'Intended', 2: 'Issued' };
const TYPES = { 5: 'Open competition', 7: 'Call for proposals' };
// ESA's times carry no zone; they are Central European time.
const cet = (v) => {
  const s = clean(v || '');
  if (!s) return null;
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(s)) return isoOrNull(s);
  const month = Number(s.slice(5, 7));
  return isoOrNull(`${s}${month >= 4 && month <= 10 ? '+02:00' : '+01:00'}`);
};

export function parsePage(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const raw = data.items || [];
  const items = raw.filter((t) => STATUS[t.status?.id] && !t.isArchived && !t.isCancelled).map((t) => opportunity({
    external_id: String(t.id),
    title: clean(t.title),
    summary: htmlText(t.description).slice(0, 4000),
    url: `${BASE}/ESATenderActions/details/${t.id}`,
    funder: 'European Space Agency',
    location: 'ESA member states',
    eligibility: [t.tanumber && `Tender action ${t.tanumber}`, t.activityNumber && `Activity ${t.activityNumber}`].filter(Boolean).join(' · '),
    status: STATUS[t.status.id],
    opens_at: cet(t.openDate),
    closes_at: cet(t.closingDate),
    published_at: cet(t.firstPublicationDate),
    currency: 'EUR',
    notice_type: TYPES[t.tenderType?.id] || '',
  })).filter((i) => i.title);
  return { items, count: raw.length, total: Number(data.total) || 0 };
}

export default {
  key: 'esa-star',
  name: 'ESA tenders (esa-star)',
  type: 'tender',
  homepage: `${BASE}/`,
  access: 'Public portal interface',
  intervalMinutes: 720,
  minDelayMs: 2000,
  enabledByDefault: false,
  async fetch({ maxPages = 20, get = fetchText, now = Date.now() } = {}) {
    const all = new Map();
    for (let page = 0; page < maxPages; page++) {
      const { items, count, total } = parsePage(await get(`${BASE}/api/tenderAction/filter/${TAKE}/${page * TAKE}`, { accept: 'application/json' }));
      items.forEach((i) => all.set(i.external_id, i));
      if (count < TAKE || (page + 1) * TAKE >= total) break;
    }
    return stillOpen([...all.values()], now);
  },
};
