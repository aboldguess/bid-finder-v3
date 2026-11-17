// TenderNed (Netherlands): every Dutch public tender, national and European,
// via TenderNed's public API (no key). Newest publications first; we read back
// to the last run and keep notices still open for responses.
import { clean, fetchText, htmlText, localToIso, opportunity, stillOpen } from './util.js';

const API = 'https://www.tenderned.nl/papi/tenderned-rs-tns/v2/publicaties';
const SIZE = 100;
// Corrections, award and cancellation notices are not opportunities.
const SKIP = /^(REC|AGO|GUN|AGG|VBE|INT)$/;

export function parsePage(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const items = (data.content || []).filter((p) => !SKIP.test(p.typePublicatie?.code || '')).map((p) => opportunity({
    external_id: String(p.publicatieId),
    title: htmlText(p.aanbestedingNaam),
    summary: htmlText(p.opdrachtBeschrijving),
    url: p.link?.href || `https://www.tenderned.nl/aankondigingen/overzicht/${p.publicatieId}`,
    funder: htmlText(p.opdrachtgeverNaam),
    location: 'Netherlands',
    eligibility: [p.typeOpdracht?.omschrijving, p.procedure?.omschrijving, p.europees ? 'European tender' : 'National tender'].filter(Boolean).join(' · '),
    status: clean(p.publicatiestatus?.omschrijving),
    closes_at: localToIso(p.sluitingsDatum || p.sluitingsDatumMarktconsultatie),
    published_at: localToIso(p.publicatieDatum && `${p.publicatieDatum}T00:00:00`),
    country: 'NL',
    currency: 'EUR',
    notice_type: clean(p.typePublicatie?.omschrijving),
  })).filter((i) => i.external_id && i.title);
  return { items, raw: data.content || [], last: Boolean(data.last ?? !(data.content || []).length) };
}

export default {
  key: 'tenderned',
  name: 'TenderNed (Netherlands)',
  type: 'tender',
  homepage: 'https://www.tenderned.nl',
  access: 'Official public API',
  intervalMinutes: 360,
  minDelayMs: 1500,
  enabledByDefault: false,
  async fetch({ maxPages = 30, get = fetchText, days = 14, since, now = Date.now() } = {}) {
    const from = (since ? Date.parse(since) - 864e5 : now - days * 864e5);
    const all = new Map();
    for (let page = 0; page < maxPages; page++) {
      const { items, raw, last } = parsePage(await get(`${API}?page=${page}&size=${SIZE}`, { accept: 'application/json' }));
      items.forEach((i) => all.set(i.external_id, i));
      const oldest = raw.map((p) => Date.parse(p.publicatieDatum)).filter(Number.isFinite).sort()[0];
      if (last || !raw.length || oldest < from) break;
    }
    return stillOpen([...all.values()], now);
  },
};
