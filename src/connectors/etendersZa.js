// South Africa eTenders: the National Treasury's central portal for national,
// provincial and municipal tenders, via its official OCDS API. No key.
import { clean, fetchText, stillOpen } from './util.js';
import { isOpenRelease, latestByOcid, mapRelease, parseOcdsJson } from './ocds.js';

const API = 'https://ocds-api.etenders.gov.za/api/OCDSReleases';
const SITE = 'https://www.etenders.gov.za/Home/opportunities?id=1';
// Large pages and future end dates make the API fail with HTTP 500.
const SIZE = 100;

// Titles are often only a reference number ("RFQJW094KM26"); the description says what it is.
const looksLikeReference = (s) => /^[A-Z0-9/\-_.\s]{4,40}$/.test(s) && /\d/.test(s) && !/\s\w{4,}\s/.test(s);

export function parsePage(json) {
  const data = parseOcdsJson(json);
  const releases = data.releases || [];
  const items = latestByOcid(releases).filter(isOpenRelease).map((r) => {
    const o = mapRelease(r, { noticeUrl: () => SITE });
    const t = r.tender || {};
    const ref = clean(t.title);
    const desc = clean(t.description);
    const title = looksLikeReference(ref) && desc ? desc : ref || desc;
    return {
      ...o,
      title,
      summary: [desc !== title && desc, ref !== title && `Reference ${ref}`, clean(t.procurementMethodDetails), clean(t.mainProcurementCategory)].filter(Boolean).join(' · '),
      funder: o.funder || clean(t.procuringEntity?.name),
      award_max: o.award_max > 0 ? o.award_max : null,
      location: o.location || clean(t.deliveryLocation || t.province) || 'South Africa',
      country: 'ZA',
      currency: 'ZAR',
    };
  }).filter((i) => i.title && i.external_id);
  return { items, count: releases.length };
}

export default {
  key: 'etenders-za',
  name: 'eTenders (South Africa)',
  type: 'tender',
  homepage: 'https://www.etenders.gov.za',
  access: 'Official OCDS API',
  intervalMinutes: 720,
  minDelayMs: 2000,
  enabledByDefault: false,
  async fetch({ maxPages = 20, get = fetchText, days = 14, since, now = Date.now() } = {}) {
    const day = (ms) => new Date(ms).toISOString().slice(0, 10);
    const from = since ? Date.parse(since) - 864e5 : now - days * 864e5;
    const all = new Map();
    for (let page = 1; page <= maxPages; page++) {
      const { items, count } = parsePage(await get(`${API}?PageNumber=${page}&PageSize=${SIZE}&dateFrom=${day(from)}&dateTo=${day(now)}`, { accept: 'application/json' }));
      items.forEach((i) => all.set(i.external_id, i));
      if (count < SIZE) break;
    }
    return stillOpen([...all.values()], now);
  },
};
