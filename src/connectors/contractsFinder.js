// Contracts Finder (GOV.UK): public-sector contract opportunities, via its
// OCDS search API. Cursor-paginated through links.next.
import { fetchText, sleep } from './util.js';
import { mapRelease } from './ocds.js';

const BASE = 'https://www.contractsfinder.service.gov.uk';

const noticeUrl = (r) => {
  const id = (r.id || '').replace(/-\d+$/, '').split('-').slice(-5).join('-');
  return /^[0-9a-f-]{36}$/i.test(id) ? `${BASE}/Notice/${id}` : `${BASE}/Search`;
};

export function parsePage(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const releases = data.releases || [];
  return {
    items: releases.map((r) => mapRelease(r, { noticeUrl })).filter((i) => i.title && i.external_id),
    next: data.links?.next || null,
  };
}

export default {
  key: 'contracts-finder',
  name: 'Contracts Finder (GOV.UK)',
  type: 'tender',
  async fetch({ maxPages = 30, get = fetchText, delayMs = 500, days = 14 } = {}) {
    const from = new Date(Date.now() - days * 864e5).toISOString().slice(0, 19);
    let url = `${BASE}/Published/Notices/OCDS/Search?stages=tender&publishedFrom=${from}&limit=100`;
    const all = new Map();
    for (let page = 0; url && page < maxPages; page++) {
      const { items, next } = parsePage(await get(url, { accept: 'application/json' }));
      items.forEach((i) => all.set(i.external_id, i));
      url = next;
      await sleep(delayMs);
    }
    const now = Date.now();
    return [...all.values()].filter((i) => !i.closes_at || Date.parse(i.closes_at) > now);
  },
};
