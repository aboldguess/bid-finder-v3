// Shared helpers for connectors: polite HTTP, and parsers for the money,
// date and "Label: value" formats that UK funding sites use.
import * as cheerio from 'cheerio';
import { createHttp } from '../http/client.js';

const defaultHttp = createHttp();
export const fetchText = (url, opts) => defaultHttp.get(url, opts);

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
export function isBst(utcMs) {
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

// CPV codes are 8 digits, sometimes written with a check digit ("71300000-4").
export function cpvCode(value) {
  const m = String(value ?? '').match(/\b(\d{8})(?:-\d)?\b/);
  return m ? m[1] : null;
}

export const uniq = (list) => [...new Set(list.filter(Boolean))];

// ISO 3166 alpha-3 to alpha-2 for the countries that publish on TED.
const ALPHA3 = { AUT: 'AT', BEL: 'BE', BGR: 'BG', HRV: 'HR', CYP: 'CY', CZE: 'CZ', DNK: 'DK', EST: 'EE', FIN: 'FI', FRA: 'FR', DEU: 'DE', GRC: 'GR', HUN: 'HU', IRL: 'IE', ITA: 'IT', LVA: 'LV', LTU: 'LT', LUX: 'LU', MLT: 'MT', NLD: 'NL', POL: 'PL', PRT: 'PT', ROU: 'RO', SVK: 'SK', SVN: 'SI', ESP: 'ES', SWE: 'SE', NOR: 'NO', ISL: 'IS', LIE: 'LI', CHE: 'CH', GBR: 'GB', USA: 'US', MKD: 'MK', SRB: 'RS', TUR: 'TR' };
export function countryCode(value) {
  const v = clean(String(value ?? '')).toUpperCase();
  if (/^[A-Z]{2}$/.test(v)) return v === 'UK' ? 'GB' : v;
  if (ALPHA3[v]) return ALPHA3[v];
  if (/^UNITED KINGDOM|^ENGLAND|^SCOTLAND|^WALES|^NORTHERN IRELAND/.test(v)) return 'GB';
  return '';
}

// Every opportunity field, empty, so a connector only states what it knows.
export const blankOpportunity = () => ({
  external_id: '', title: '', summary: '', url: '', funder: '', location: '', eligibility: '', status: '',
  award_min: null, award_max: null, total_fund: null, award_text: '', opens_at: null, closes_at: null, published_at: null,
  cpv_codes: '', country: '', currency: '', notice_type: '',
});
export const opportunity = (fields) => ({ ...blankOpportunity(), ...fields });

// Plain text from an HTML fragment, with entities decoded ("&ndash;" -> "–").
export function htmlText(html) {
  const s = String(html ?? '');
  if (!/[<&]/.test(s)) return clean(s);
  return clean(cheerio.load(`<div>${s.replace(/<\/(p|li|div|h\d)>|<br\s*\/?>/gi, '$& ')}</div>`).text());
}

// "MM/DD/YYYY" (US) -> ISO. A date with no time is the end of that day in
// US Eastern time, the safe reading for a deadline.
export function parseUsDate(text, { endOfDay = true } = {}) {
  const m = clean(text).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return isoOrNull(text);
  return isoOrNull(`${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}T${endOfDay ? '23:59:00' : '00:00:00'}-05:00`);
}

// "2026-12-10" -> end of that day in the given UTC offset; full timestamps pass through.
export function dayOrInstant(value, offset = 'Z', { endOfDay = true } = {}) {
  const v = clean(String(value ?? ''));
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return isoOrNull(`${v}T${endOfDay ? '23:59:00' : '00:00:00'}${offset}`);
  return isoOrNull(v);
}

// Minimal RFC 4180 CSV parser: quoted fields, doubled quotes, newlines in quotes.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header = [], ...body] = rows;
  return body.filter((r) => r.length > 1 || r[0]).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

// UTC offset of Central European Time on a local wall-clock date: "+02:00" in
// summer time (which starts and ends at the same instants as in the UK).
export const cetOffset = (localIso) => (isBst(Date.parse(`${String(localIso).slice(0, 10)}T12:00:00Z`)) ? '+02:00' : '+01:00');

// A local timestamp with no zone ("2026-12-09T16:00:00") read in the given
// zone function; a bare date is the end of that day.
export function localToIso(value, offsetFor = cetOffset) {
  const v = clean(String(value ?? ''));
  if (!v) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(v)) return isoOrNull(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return isoOrNull(`${v}T23:59:00${offsetFor(v)}`);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?/.test(v)) return isoOrNull(`${v.slice(0, 19)}${offsetFor(v)}`);
  return isoOrNull(v);
}

// Only items whose deadline has not passed.
export const stillOpen = (items, now = Date.now()) => items.filter((i) => !i.closes_at || Date.parse(i.closes_at) > now);

// UTC offset of North American Eastern time on a local date: daylight time
// runs from the second Sunday of March to the first Sunday of November.
export function easternOffset(localIso) {
  const d = new Date(`${String(localIso).slice(0, 10)}T12:00:00Z`);
  const y = d.getUTCFullYear();
  const nthSunday = (month, n) => { const x = new Date(Date.UTC(y, month, 1)); x.setUTCDate(1 + ((7 - x.getUTCDay()) % 7) + 7 * (n - 1)); return x.getTime(); };
  return d.getTime() >= nthSunday(2, 2) && d.getTime() < nthSunday(10, 1) ? '-04:00' : '-05:00';
}
