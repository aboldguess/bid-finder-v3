// service.bund.de (Germany): the federal government's portal, which gathers
// tenders from federal, state and municipal contracting authorities. Read
// from its official RSS feed of current calls for tender.
import * as cheerio from 'cheerio';
import { cetOffset, clean, fetchText, isoOrNull, opportunity, stillOpen } from './util.js';

const FEED = 'https://www.service.bund.de/SiteGlobals/Functions/RSSFeed/RSSGenerator_Ausschreibungen.xml';

// "13.01.2027 00:00" (German local time) -> ISO. Midnight means the end of the previous day.
export function parseGermanDate(text) {
  const m = clean(text).match(/(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const day = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return isoOrNull(`${day}T${m[4] ? `${m[4].padStart(2, '0')}:${m[5]}` : '23:59'}:00${cetOffset(day)}`);
}

export function parseFeed(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  return $('item').toArray().map((el) => {
    const item = $(el);
    const link = clean(item.children('guid').text() || item.children('link').text()).replace(/#.*$/, '');
    const body = cheerio.load(`<div>${item.children('description').text()}</div>`);
    const field = (label) => {
      const text = body('div').html() || '';
      const m = text.match(new RegExp(`${label}[^:]*:\\s*<strong>([\\s\\S]*?)</strong>`, 'i'));
      return m ? clean(cheerio.load(`<i>${m[1]}</i>`)('i').text()) : '';
    };
    const buyer = field('Vergabestelle').split(',')[0];
    return opportunity({
      external_id: link.replace(/^https?:\/\/[^/]+/, ''),
      title: clean(item.children('title').text()),
      summary: [field('Erf') && `Place of performance: ${field('Erf')}`, buyer && `Contracting authority: ${buyer}`].filter(Boolean).join(' · '),
      url: link,
      funder: buyer,
      location: field('Erf') || 'Germany',
      closes_at: parseGermanDate(field('Veröffentlichungsende') || field('Ver&ouml;ffentlichungsende')),
      published_at: isoOrNull(item.children('pubDate').text()),
      country: 'DE',
      currency: 'EUR',
      notice_type: 'Ausschreibung',
    });
  }).filter((i) => i.external_id && i.title && /^https?:/.test(i.url));
}

export default {
  key: 'service-bund',
  name: 'service.bund.de (Germany)',
  type: 'tender',
  homepage: 'https://www.service.bund.de/Content/DE/Ausschreibungen/Suche/Formular.html',
  access: 'Official RSS feed',
  intervalMinutes: 360,
  minDelayMs: 2000,
  enabledByDefault: false,
  async fetch({ get = fetchText, now = Date.now() } = {}) {
    return stillOpen(parseFeed(await get(FEED, { accept: 'application/rss+xml, application/xml' })), now);
  },
};
