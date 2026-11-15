// Public Contracts Scotland and Sell2Wales run on the same platform and share
// an official API: one OCDS release package per month and notice type.
// We read contract notices for this month and last.
import { fetchText, sleep } from './util.js';
import { documentUrl, isOpenRelease, latestByOcid, mapRelease, parseOcdsJson } from './ocds.js';

// 2 = above-threshold contract notice, 102 = website (below-threshold) contract notice.
const NOTICE_TYPES = [2, 102];

const monthParam = (d) => `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;

export function parsePackage(json, { site, hostPattern }) {
  const data = parseOcdsJson(json);
  const noticeUrl = (r) => documentUrl(r, hostPattern) || r.tender?.submissionMethodDetails?.match?.(/https?:\/\/\S+/)?.[0] || site;
  return latestByOcid(data.releases || []).filter(isOpenRelease)
    .map((r) => { const o = mapRelease(r, { noticeUrl }); return { ...o, country: o.country || 'GB' }; })
    .filter((i) => i.title && i.external_id);
}

export function proactisConnector({ key, name, api, site, hostPattern, region }) {
  return {
    key,
    name,
    type: 'tender',
    homepage: site,
    access: 'Official OCDS API',
    intervalMinutes: 360,
    minDelayMs: 2000,
    settings: [{ key: 'noticeTypes', label: 'Notice types', placeholder: NOTICE_TYPES.join(','), help: 'Comma-separated notice type numbers from the portal\'s API page.' }],
    async fetch({ get = fetchText, delayMs = 500, now = Date.now(), config = {} } = {}) {
      const types = (config.noticeTypes || '').split(',').map((n) => Number(n.trim())).filter((n) => Number.isInteger(n) && n > 0);
      const thisMonth = new Date(now);
      const lastMonth = new Date(Date.UTC(thisMonth.getUTCFullYear(), thisMonth.getUTCMonth() - 1, 1));
      const all = new Map();
      for (const month of [lastMonth, thisMonth]) {
        for (const type of types.length ? types : NOTICE_TYPES) {
          const text = await get(`${api}/v1/Notices?dateFrom=${monthParam(month)}&noticeType=${type}&outputType=0`, { accept: 'application/json' });
          for (const item of parsePackage(text, { site, hostPattern })) all.set(item.external_id, { ...item, location: item.location || region });
          await sleep(delayMs);
        }
      }
      return [...all.values()].filter((i) => !i.closes_at || Date.parse(i.closes_at) > now);
    },
  };
}

export const publicContractsScotland = proactisConnector({
  key: 'public-contracts-scotland',
  name: 'Public Contracts Scotland',
  api: 'https://api.publiccontractsscotland.gov.uk',
  site: 'https://www.publiccontractsscotland.gov.uk',
  hostPattern: /publiccontractsscotland\.gov\.uk/i,
  region: 'Scotland',
});

// Off by default: in November 2026 its API answered every request with HTTP 500.
// Above-threshold Welsh notices also appear on Find a Tender, so little is lost.
export const sell2Wales = { ...proactisConnector({
  key: 'sell2wales',
  name: 'Sell2Wales',
  api: 'https://api.sell2wales.gov.wales',
  site: 'https://www.sell2wales.gov.wales',
  hostPattern: /sell2wales\.gov\.wales/i,
  region: 'Wales',
}), enabledByDefault: false };
