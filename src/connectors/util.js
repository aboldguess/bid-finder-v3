// Shared helpers for connectors: polite HTTP, and parsers for the money,
// date and "Label: value" formats that UK funding sites use.
import { config } from '../config.js';

export async function fetchText(url, { timeoutMs = 20000, accept = 'text/html' } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': config.userAgent, Accept: accept },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

const MULTIPLIERS = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, mn: 1e6, bn: 1e9, billion: 1e9 };

// Every £/€ amount in a string, e.g. "From £1,500 to £2 million" -> [1500, 2000000].
export function parseAmounts(text) {
  const out = [];
  const re = /[£€]\s?(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|m|million|mn|bn|billion)?\b/gi;
  for (const m of clean(text).matchAll(re)) {
    const n = Number(m[1].replace(/,/g, ''));
    const mult = m[2] ? MULTIPLIERS[m[2].toLowerCase()] : 1;
    if (Number.isFinite(n)) out.push(Math.round(n * mult));
  }
  return out;
}

// Award range from free text. "Up to £5m" is a max; "Minimum award: £1m" a min.
export function parseAwardRange(text, hint = '') {
  const amounts = parseAmounts(text);
  if (!amounts.length) return { min: null, max: null };
  if (amounts.length >= 2) return { min: Math.min(...amounts), max: Math.max(...amounts) };
  const t = `${hint} ${text}`.toLowerCase();
  if (/\b(min(imum)?|at least|from)\b/.test(t) && !/\bup to\b|\bmax/.test(t)) return { min: amounts[0], max: null };
  return { min: null, max: amounts[0] };
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// Is a UTC instant inside British Summer Time (last Sunday of March 01:00 UTC
// to last Sunday of October 01:00 UTC)?
function isBst(utcMs) {
  const y = new Date(utcMs).getUTCFullYear();
  const lastSunday = (month) => {
    const d = new Date(Date.UTC(y, month + 1, 0, 1));
    d.setUTCDate(d.getUTCDate() - d.getUTCDay());
    return d.getTime();
  };
  return utcMs >= lastSunday(2) && utcMs < lastSunday(9);
}

// "1 December 2015, 12:01am (Midnight)", "21 October 2026", "8 Dec 2026 11:00am"
// -> ISO 8601 UTC string, reading the wall-clock time as UK local time.
// A date with no time is taken as the end of that day, which is the safe
// reading for a deadline. Returns null for "To be confirmed" and the like.
export function parseUkDate(text, { endOfDay = true } = {}) {
  const m = clean(text).match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})(?:[,\s]+(?:at\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?)?/i);
  if (!m) return null;
  const month = MONTHS.findIndex((name) => name.startsWith(m[2].toLowerCase().slice(0, 3)));
  if (month < 0) return null;
  let hour = endOfDay ? 23 : 0;
  let minute = endOfDay ? 59 : 0;
  if (m[4] !== undefined) {
    hour = Number(m[4]) % 12;
    if ((m[6] || '').toLowerCase() === 'pm') hour += 12;
    if (!m[6] && Number(m[4]) >= 12) hour = Number(m[4]);
    minute = Number(m[5] || 0);
  }
  let ms = Date.UTC(Number(m[3]), month, Number(m[1]), hour, minute);
  if (isBst(ms)) ms -= 3600e3;
  return new Date(ms).toISOString();
}

export function isoOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Finds the element wrapping one listing item: climbs from a detail link
// while the ancestor still holds only that one item's detail link.
export function itemContainer($, link, isDetailHref) {
  const own = $(link).attr('href');
  let node = $(link);
  for (let parent = node.parent(); parent.length && !parent.is('body'); parent = parent.parent()) {
    const hrefs = new Set(
      parent.find('a[href]').toArray().map((a) => $(a).attr('href')).filter(isDetailHref),
    );
    if (hrefs.size > 1 || (hrefs.size === 1 && !hrefs.has(own))) break;
    node = parent;
  }
  return node;
}

// Pulls "Label: value" pairs out of an item, whether they are marked up as
// <dt>/<dd>, table cells, a label element followed by a value element, or
// plain text lines. Returns a map keyed by lower-case label without colon.
export function extractLabelled($, el, labels) {
  const wanted = labels.map((l) => l.toLowerCase());
  const out = {};
  const norm = (s) => clean(s).replace(/:$/, '').toLowerCase();
  const take = (label, value) => {
    const key = norm(label);
    if (wanted.includes(key) && !(key in out) && clean(value)) out[key] = clean(value);
  };

  $(el).find('dt').each((_, dt) => take($(dt).text(), $(dt).nextAll('dd').first().text()));
  $(el).find('th').each((_, th) => take($(th).text(), $(th).nextAll('td').first().text()));
  $(el).find('*').each((_, node) => {
    const own = norm($(node).text());
    if (!wanted.includes(own) || own in out) return;
    const next = $(node).next();
    if (next.length) return take(own, next.text());
    const parentText = clean($(node).parent().text());
    const label = clean($(node).text());
    take(own, parentText.slice(parentText.indexOf(label) + label.length));
  });

  // Fallback: plain text with labels inline, e.g. "Closing date: 3 March 2027".
  const text = clean($(el).text());
  const pattern = new RegExp(`(${labels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}):?\\s`, 'gi');
  const hits = [...text.matchAll(pattern)];
  hits.forEach((hit, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].index : text.length;
    take(hit[1], text.slice(hit.index + hit[0].length, end));
  });
  return out;
}
