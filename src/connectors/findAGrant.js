// GOV.UK Find a Grant: every central-government grant scheme in England/UK.
// There is no public API, so we read the logged-out listing pages
// (10 per page). The site is a Next.js app: we prefer the structured data in
// its __NEXT_DATA__ blob and fall back to reading the rendered HTML.
import * as cheerio from 'cheerio';
import { clean, extractLabelled, fetchText, itemContainer, parseAwardRange, parseAmounts, parseUkDate, isoOrNull, sleep } from './util.js';

const BASE = 'https://www.find-government-grants.service.gov.uk';
const LABELS = ['Location', 'Funding organisation', 'Who can apply', 'How much you can get', 'Total size of grant scheme', 'Opening date', 'Closing date'];

const pageUrl = (page) => `${BASE}/grants?page=${page}&skip=${(page - 1) * 10}&limit=10`;

function fromJson(g) {
  const label = g.label || g.grantLabel;
  const list = (v) => (Array.isArray(v) ? v.join(', ') : clean(v));
  return {
    external_id: label || String(g.grantId ?? g.id),
    title: clean(g.grantName),
    summary: clean(g.grantShortDescription),
    url: `${BASE}/grants/${label}`,
    funder: clean(g.grantFunder),
    location: list(g.grantLocation),
    eligibility: list(g.grantApplicantType),
    status: '',
    award_min: Number.isFinite(g.grantMinimumAward) ? g.grantMinimumAward : null,
    award_max: Number.isFinite(g.grantMaximumAward) ? g.grantMaximumAward : null,
    total_fund: Number.isFinite(g.grantTotalAwardAmount) ? g.grantTotalAwardAmount : null,
    award_text: clean(g.grantMaximumAwardDisplay || g.grantTotalAwardDisplay),
    opens_at: isoOrNull(g.grantApplicationOpenDate),
    closes_at: isoOrNull(g.grantApplicationCloseDate),
    published_at: null,
  };
}

// Depth-first search of the Next.js payload for objects that look like grants.
function grantsInJson(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => grantsInJson(n, out));
  else if (node && typeof node === 'object') {
    if (typeof node.grantName === 'string') out.push(node);
    else Object.values(node).forEach((n) => grantsInJson(n, out));
  }
  return out;
}

const isDetailHref = (href) => /^(https:\/\/www\.find-government-grants\.service\.gov\.uk)?\/grants\/[^/?#]+$/.test(href || '');

export function parsePage(html) {
  const $ = cheerio.load(html);
  const blob = $('script#__NEXT_DATA__').text();
  if (blob) {
    try {
      const grants = grantsInJson(JSON.parse(blob)).map(fromJson).filter((g) => g.title && g.external_id);
      if (grants.length) return grants;
    } catch {
      // Malformed payload: fall through to the HTML.
    }
  }

  const seen = new Set();
  const items = [];
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href');
    if (!isDetailHref(href) || seen.has(href)) return;
    seen.add(href);
    const box = itemContainer($, a, isDetailHref);
    const f = extractLabelled($, box, LABELS);
    const label = href.split('/').pop();
    const howMuch = f['how much you can get'] || '';
    const range = parseAwardRange(howMuch);
    const summary = clean(box.find('p').first().text());
    items.push({
      external_id: label,
      title: clean($(a).text()),
      summary,
      url: new URL(href, BASE).href,
      funder: f['funding organisation'] || '',
      location: f.location || '',
      eligibility: f['who can apply'] || '',
      status: '',
      award_min: range.min,
      award_max: range.max,
      total_fund: parseAmounts(f['total size of grant scheme'] || '')[0] ?? null,
      award_text: howMuch,
      opens_at: parseUkDate(f['opening date'] || '', { endOfDay: false }),
      closes_at: parseUkDate(f['closing date'] || ''),
      published_at: null,
    });
  });
  return items.filter((g) => g.title);
}

export default {
  key: 'find-a-grant',
  name: 'Find a Grant (GOV.UK)',
  type: 'grant',
  async fetch({ maxPages = 30, get = fetchText, delayMs = 750 } = {}) {
    const all = new Map();
    for (let page = 1; page <= maxPages; page++) {
      const items = parsePage(await get(pageUrl(page)));
      const before = all.size;
      items.forEach((i) => all.set(i.external_id, i));
      if (!items.length || all.size === before) break;
      await sleep(delayMs);
    }
    return [...all.values()];
  },
};
