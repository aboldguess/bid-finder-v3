// GETS (New Zealand Government Electronic Tender Service): every open tender
// from NZ government agencies, councils and Crown entities. Read from the
// public "current tenders" listing, which states each closing time with its
// UTC offset.
import * as cheerio from 'cheerio';
import { clean, fetchText, isoOrNull, opportunity, sleep, stillOpen } from './util.js';

const BASE = 'https://www.gets.govt.nz';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// "12:00 PM 18 Nov 2026 (Pacific/Auckland UTC+13:00)" -> ISO.
export function parseGetsDate(text) {
  const m = clean(text).match(/(\d{1,2}):(\d{2})\s*(AM|PM)\s+(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4})(?:.*UTC([+-]\d{2}:\d{2}))?/i);
  if (!m) return null;
  const month = MONTHS.indexOf(m[5].toLowerCase());
  if (month < 0) return null;
  const hour = (Number(m[1]) % 12) + (m[3].toUpperCase() === 'PM' ? 12 : 0);
  return isoOrNull(`${m[6]}-${String(month + 1).padStart(2, '0')}-${m[4].padStart(2, '0')}T${String(hour).padStart(2, '0')}:${m[2]}:00${m[7] || '+12:00'}`);
}

export function parsePage(html) {
  const $ = cheerio.load(html);
  const items = [];
  $('tr[id^="tender-"]').each((_, tr) => {
    const cells = $(tr).children('td').toArray().map((td) => clean($(td).text()));
    const href = $(tr).find('a[href*="ExternalTenderDetails"]').first().attr('href');
    if (!href || cells.length < 6) return;
    const ref = cells[1] === '[None]' ? '' : cells[1];
    items.push(opportunity({
      external_id: cells[0],
      title: cells[2],
      summary: [$(tr).find('abbr').attr('title') || cells[3], ref && `Reference ${ref}`].filter(Boolean).join(' · '),
      url: new URL(href, `${BASE}/`).href,
      funder: cells[5],
      location: 'New Zealand',
      status: 'Open',
      closes_at: parseGetsDate(cells[4]),
      country: 'NZ',
      currency: 'NZD',
      notice_type: cells[3],
    }));
  });
  const pages = $('a[href*="ExternalIndex.htm?page="]').toArray().map((a) => Number(($(a).attr('href').match(/page=(\d+)/) || [])[1])).filter(Number.isFinite);
  return { items: items.filter((i) => i.external_id && i.title), lastPage: Math.max(1, ...pages) };
}

export default {
  key: 'gets-nz',
  name: 'GETS (New Zealand)',
  type: 'tender',
  homepage: BASE,
  access: 'Public listing pages',
  respectRobots: true,
  intervalMinutes: 720,
  minDelayMs: 2000,
  enabledByDefault: false,
  async fetch({ maxPages = 30, get = fetchText, delayMs = 500, now = Date.now() } = {}) {
    const all = new Map();
    let last = 1;
    for (let page = 1; page <= Math.min(last, maxPages); page++) {
      const { items, lastPage } = parsePage(await get(`${BASE}/ExternalIndex.htm?page=${page}&orderBy=date`));
      last = Math.max(last, lastPage);
      const before = all.size;
      items.forEach((i) => all.set(i.external_id, i));
      if (all.size === before) break;
      await sleep(delayMs);
    }
    return stillOpen([...all.values()], now);
  },
};
