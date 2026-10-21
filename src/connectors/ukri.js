// UKRI Funding Finder (research councils and Innovate UK). The RSS feed lacks
// deadlines and award sizes, so we read the listing pages, which show them.
import * as cheerio from 'cheerio';
import { clean, extractLabelled, fetchText, itemContainer, parseAmounts, parseAwardRange, parseUkDate, sleep } from './util.js';

const BASE = 'https://www.ukri.org';
const LABELS = ['Opportunity status', 'Funders', 'Co-funders', 'Funding type', 'Total fund', 'Maximum award', 'Minimum award', 'Award range', 'Award', 'Publication date', 'Opening date', 'Closing date'];

const isDetailHref = (href) => /^(https:\/\/www\.ukri\.org)?\/opportunity\/(?!page\/)[^/?#]+\/?(\?.*)?$/.test(href || '');
const pageUrl = (page) => (page === 1 ? `${BASE}/opportunity/` : `${BASE}/opportunity/page/${page}/`);

export function parsePage(html) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const items = [];
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href');
    if (!isDetailHref(href)) return;
    const slug = new URL(href, BASE).pathname.split('/').filter(Boolean).pop();
    if (seen.has(slug)) return;
    const box = itemContainer($, a, isDetailHref);
    const f = extractLabelled($, box, LABELS);
    // Navigation links to /opportunity/... carry no fields; skip them.
    if (!f['closing date'] && !f['opportunity status']) return;
    seen.add(slug);
    const awardText = f['award range'] || f['maximum award'] || f['minimum award'] || f.award || '';
    const range = parseAwardRange(awardText, f['minimum award'] ? 'minimum' : '');
    const status = (f['opportunity status'] || '').split(' ')[0];
    items.push({
      external_id: slug,
      title: clean($(a).text()),
      summary: clean(box.find('p').first().text()),
      url: new URL(href, BASE).href.replace(/\?.*$/, ''),
      funder: f.funders || 'UKRI',
      location: 'UK',
      eligibility: '',
      status,
      award_min: range.min,
      award_max: range.max,
      total_fund: parseAmounts(f['total fund'] || '')[0] ?? null,
      award_text: awardText,
      opens_at: parseUkDate(f['opening date'] || '', { endOfDay: false }),
      closes_at: parseUkDate(f['closing date'] || ''),
      published_at: parseUkDate(f['publication date'] || '', { endOfDay: false }),
    });
  });
  return items.filter((i) => i.title);
}

export default {
  key: 'ukri',
  name: 'UKRI Funding Finder',
  type: 'grant',
  async fetch({ maxPages = 30, get = fetchText, delayMs = 750 } = {}) {
    const all = new Map();
    for (let page = 1; page <= maxPages; page++) {
      let html;
      try {
        html = await get(pageUrl(page));
      } catch (err) {
        if (page > 1 && /HTTP 404/.test(err.message)) break; // ran past the last page
        throw err;
      }
      const items = parsePage(html);
      const before = all.size;
      items.forEach((i) => all.set(i.external_id, i));
      if (page > 1 && all.size === before) break;
      await sleep(delayMs);
    }
    return [...all.values()].filter((i) => !/^closed$/i.test(i.status));
  },
};
