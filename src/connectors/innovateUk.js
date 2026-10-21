// Innovate UK competitions on the Innovation Funding Service (IFS).
// Listing pages are 0-indexed: ?page=0 is results 1-10, ?page=1 is 11-20.
import * as cheerio from 'cheerio';
import { clean, extractLabelled, fetchText, itemContainer, parseAwardRange, parseUkDate, sleep } from './util.js';

const BASE = 'https://apply-for-innovation-funding.service.gov.uk';
const isDetailHref = (href) => /\/competition\/\d+\/overview\b/.test(href || '');

export function parsePage(html) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const items = [];
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href');
    if (!isDetailHref(href)) return;
    const id = href.match(/\/competition\/(\d+)\//)[1];
    if (seen.has(id)) return;
    seen.add(id);
    const box = itemContainer($, a, isDetailHref);
    const f = extractLabelled($, box, ['Opened', 'Opens', 'Closes', 'Closed']);
    const paragraphs = box.find('p').toArray().map((p) => clean($(p).text())).filter(Boolean);
    const summary = paragraphs.find((p) => !/^(opened|opens|closes|closed)\b/i.test(p)) || '';
    const eligibility = clean(box.find('h2, h3, h4').filter((_, h) => /eligib/i.test($(h).text())).first().next().text());
    const status = clean(box.find('h2, h3, h4, strong, span').filter((_, h) => /^(open now|opening soon|upcoming|closed)$/i.test(clean($(h).text()))).first().text());
    const range = parseAwardRange(summary);
    items.push({
      external_id: id,
      title: clean($(a).text()),
      summary,
      url: new URL(href, BASE).href,
      funder: 'Innovate UK',
      location: 'UK',
      eligibility,
      status,
      award_min: range.min,
      award_max: range.max,
      total_fund: null,
      award_text: '',
      opens_at: parseUkDate(f.opened || f.opens || '', { endOfDay: false }),
      closes_at: parseUkDate(f.closes || f.closed || ''),
      published_at: null,
    });
  });
  return items.filter((i) => i.title);
}

export default {
  key: 'innovate-uk',
  name: 'Innovate UK competitions',
  type: 'grant',
  async fetch({ maxPages = 30, get = fetchText, delayMs = 750 } = {}) {
    const all = new Map();
    for (let page = 0; page < maxPages; page++) {
      const items = parsePage(await get(`${BASE}/competition/search?page=${page}`));
      const before = all.size;
      items.forEach((i) => all.set(i.external_id, i));
      if (!items.length || all.size === before) break;
      await sleep(delayMs);
    }
    return [...all.values()];
  },
};
