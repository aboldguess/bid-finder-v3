// GeBIZ (Singapore): the Singapore Government's procurement portal. Read from
// the public business-opportunities listing. The portal pages with form
// postbacks, so we read the first listing page on each run; run it often and
// it accumulates every new opportunity as it is published.
import * as cheerio from 'cheerio';
import { clean, fetchText, isoOrNull, opportunity, stillOpen } from './util.js';

const BASE = 'https://www.gebiz.gov.sg';
const LISTING = `${BASE}/ptn/opportunity/BOListing.xhtml?origin=menu`;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// "07 Dec 2026" + "01:00PM" (Singapore time, UTC+8) -> ISO.
export function parseSgDate(date, time = '') {
  const d = clean(date).match(/(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4})/);
  if (!d) return null;
  const month = MONTHS.indexOf(d[2].toLowerCase());
  if (month < 0) return null;
  const t = clean(time).match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  const hour = t ? (Number(t[1]) % 12) + (t[3].toUpperCase() === 'PM' ? 12 : 0) : 23;
  return isoOrNull(`${d[3]}-${String(month + 1).padStart(2, '0')}-${d[1].padStart(2, '0')}T${String(hour).padStart(2, '0')}:${t ? t[2] : '59'}:00+08:00`);
}

export function parsePage(html) {
  const $ = cheerio.load(html);
  const items = [];
  $('a[href*="directlink.xhtml?docCode="]').each((_, a) => {
    const code = ($(a).attr('href').match(/docCode=([A-Z0-9]+)/) || [])[1];
    if (!code || items.some((i) => i.external_id === code)) return;
    // Each item's elements share an id prefix, e.g. "contentForm:j_idt744:j_id22:".
    const owner = $(a).closest('[id^="contentForm:"]').attr('id') || '';
    const prefix = (owner.match(/^contentForm:[^:]+:[^:]+:/) || [])[0];
    const box = prefix ? $(`[id^="${prefix}"]`).filter((__, el) => !$(el).parents(`[id^="${prefix}"]`).length) : $(a).parent();
    const field = (label) => {
      const lab = box.find('label').filter((__, el) => clean($(el).text()) === label).first();
      return clean(lab.closest('.row').find('.formOutputText_VALUE-DIV').first().text());
    };
    const text = clean(box.toArray().map((el) => $(el).text()).join(' '));
    const closing = text.match(/Closing on\s*(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})\s*(\d{1,2}:\d{2}\s*[AP]M)?/i);
    const header = clean(box.find('.formSectionHeader6_TEXT').first().text());
    items.push(opportunity({
      external_id: code,
      title: clean($(a).text()),
      summary: [header, field('Procurement Category')].filter(Boolean).join(' · '),
      url: `${BASE}/ptn/opportunity/directlink.xhtml?docCode=${code}`,
      funder: field('Agency'),
      location: 'Singapore',
      eligibility: field('Procurement Category'),
      status: clean(box.find('.label_MAIN').first().text()),
      closes_at: closing ? parseSgDate(closing[1], closing[2]) : null,
      published_at: (() => { const p = field('Published').match(/(\d{1,2}\s+\w{3}\s+\d{4})\s+(\d{1,2}:\d{2}\s*[AP]M)/i); return p ? parseSgDate(p[1], p[2]) : null; })(),
      country: 'SG',
      currency: 'SGD',
      notice_type: header.split(' - ')[0],
    }));
  });
  return items.filter((i) => i.title);
}

export default {
  key: 'gebiz',
  name: 'GeBIZ (Singapore)',
  type: 'tender',
  homepage: BASE,
  access: 'Public listing page',
  respectRobots: true,
  intervalMinutes: 180,
  minDelayMs: 3000,
  enabledByDefault: false,
  async fetch({ get = fetchText, now = Date.now() } = {}) {
    return stillOpen(parsePage(await get(LISTING)), now);
  },
};
