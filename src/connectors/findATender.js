// Find a Tender (GOV.UK): the UK's central service for higher-value public
// contracts under the Procurement Act 2023. Uses the official OCDS release
// package API, which is cursor-paginated and limited to roughly 12 requests
// in two minutes, so requests are spaced 11 seconds apart.
import { fetchText } from './util.js';
import { documentUrl, isOpenRelease, latestByOcid, mapRelease, parseOcdsJson } from './ocds.js';

const BASE = 'https://www.find-tender.service.gov.uk';

const noticeUrl = (r) =>
  documentUrl(r, /find-tender\.service\.gov\.uk\/Notice\//i) || (/^\d{6}-\d{4}$/.test(r.id || '') ? `${BASE}/Notice/${r.id}` : `${BASE}/Search`);

export function parsePage(json) {
  const data = parseOcdsJson(json);
  return { releases: data.releases || [], next: data.links?.next || null };
}

export const mapReleases = (releases) =>
  latestByOcid(releases).filter(isOpenRelease)
    .map((r) => { const o = mapRelease(r, { noticeUrl }); return { ...o, country: o.country || 'GB' }; })
    .filter((i) => i.title && i.external_id);

const stamp = (ms) => new Date(ms).toISOString().slice(0, 19);

export default {
  key: 'find-a-tender',
  name: 'Find a Tender (GOV.UK)',
  type: 'tender',
  homepage: BASE,
  access: 'Official OCDS API',
  intervalMinutes: 180,
  minDelayMs: 11000,
  settings: [{ key: 'stages', label: 'Stages', placeholder: 'tender', help: 'Comma-separated: tender, planning. Planning adds pipeline and market-engagement notices.' }],
  async fetch({ maxPages = 40, get = fetchText, days = 14, since, now = Date.now(), config = {} } = {}) {
    const stages = /^[a-z,]+$/.test(config.stages || '') ? config.stages : 'tender';
    const from = since ? Date.parse(since) - 3600e3 : now - days * 864e5;
    let url = `${BASE}/api/1.0/ocdsReleasePackages?stages=${stages}&limit=100&updatedFrom=${stamp(from)}&updatedTo=${stamp(now)}`;
    const releases = [];
    for (let page = 0; url && page < maxPages; page++) {
      const data = parsePage(await get(url, { accept: 'application/json' }));
      releases.push(...data.releases);
      url = data.next;
    }
    return mapReleases(releases).filter((i) => !i.closes_at || Date.parse(i.closes_at) > now);
  },
};
