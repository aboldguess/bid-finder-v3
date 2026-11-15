// Contracts Finder (GOV.UK): public-sector contract opportunities in England
// and for non-devolved bodies, mostly below the Find a Tender thresholds.
// Uses the official OCDS search API, cursor-paginated through links.next.
import { fetchText, sleep } from './util.js';
import { isOpenRelease, mapRelease, parseOcdsJson } from './ocds.js';

const BASE = 'https://www.contractsfinder.service.gov.uk';

const noticeUrl = (r) => {
  const id = (r.id || '').replace(/-\d+$/, '').split('-').slice(-5).join('-');
  return /^[0-9a-f-]{36}$/i.test(id) ? `${BASE}/Notice/${id}` : `${BASE}/Search`;
};

export function parsePage(json) {
  const data = parseOcdsJson(json);
  const releases = (data.releases || []).filter(isOpenRelease);
  return {
    items: releases.map((r) => ({ ...mapRelease(r, { noticeUrl }), country: 'GB' })).filter((i) => i.title && i.external_id),
    next: data.links?.next || null,
  };
}

export default {
  key: 'contracts-finder',
  name: 'Contracts Finder (GOV.UK)',
  type: 'tender',
  homepage: BASE,
  access: 'Official OCDS API',
  intervalMinutes: 180,
  minDelayMs: 1000,
  async fetch({ maxPages = 40, get = fetchText, delayMs = 500, days = 14, since, now = Date.now() } = {}) {
    const from = new Date(since ? Date.parse(since) - 3600e3 : now - days * 864e5).toISOString().slice(0, 19);
    let url = `${BASE}/Published/Notices/OCDS/Search?stages=tender&publishedFrom=${from}&limit=100`;
    const all = new Map();
    for (let page = 0; url && page < maxPages; page++) {
      const { items, next } = parsePage(await get(url, { accept: 'application/json' }));
      items.forEach((i) => all.set(i.external_id, i));
      url = next;
      await sleep(delayMs);
    }
    return [...all.values()].filter((i) => !i.closes_at || Date.parse(i.closes_at) > now);
  },
};
