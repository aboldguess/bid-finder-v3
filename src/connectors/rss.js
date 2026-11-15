// Generic RSS/Atom connector for portals that publish a feed of notices.
// Created from a source row an administrator adds; nothing is hard-coded.
import * as cheerio from 'cheerio';
import { clean, isoOrNull, parseAmounts, parseUkDate } from './util.js';

const stripHtml = (html) => clean(cheerio.load(`<div>${html || ''}</div>`).text());

// Feeds rarely carry a deadline field, so look for one in the text.
export function deadlineFromText(text) {
  const m = clean(text).match(/(?:clos(?:ing|es?)|deadline|submission|return|expires?|due)[^.\d]{0,40}(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\.?,?\s+\d{4}(?:[,\s]+(?:at\s+)?\d{1,2}[:.]\d{2}\s*(?:am|pm)?)?|\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/i);
  if (!m) return null;
  const slash = m[1].match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) return isoOrNull(`${slash[3]}-${slash[2].padStart(2, '0')}-${slash[1].padStart(2, '0')}T23:59:00Z`);
  return /^\d{4}-/.test(m[1]) ? isoOrNull(`${m[1]}T23:59:00Z`) : parseUkDate(m[1]);
}

export function parseFeed(xml, { baseUrl = '' } = {}) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const items = [];
  $('item, entry').each((_, el) => {
    const node = $(el);
    const first = (...names) => { for (const n of names) { const t = node.children(n).first().text(); if (clean(t)) return t; } return ''; };
    const linkEl = node.children('link').filter((_, l) => !$(l).attr('rel') || $(l).attr('rel') === 'alternate').first();
    let link = clean(linkEl.attr('href') || linkEl.text() || first('guid', 'id'));
    if (!link) return;
    try { link = new URL(link, baseUrl || undefined).href; } catch { return; }
    if (!/^https?:/.test(link)) return;
    const body = stripHtml(first('description', 'summary', 'content', 'content\\:encoded'));
    const title = stripHtml(first('title'));
    const amounts = parseAmounts(body);
    items.push({
      external_id: clean(first('guid', 'id')) || link,
      title,
      summary: body.slice(0, 2000),
      url: link,
      funder: stripHtml(first('author > name', 'dc\\:creator', 'author')),
      location: '',
      eligibility: node.children('category').toArray().map((c) => clean($(c).attr('term') || $(c).text())).filter(Boolean).join('; '),
      status: '',
      award_min: null,
      award_max: amounts.length ? Math.max(...amounts) : null,
      total_fund: null,
      award_text: '',
      opens_at: null,
      closes_at: deadlineFromText(`${title}. ${body}`),
      published_at: isoOrNull(first('pubDate', 'published', 'updated', 'dc\\:date')),
    });
  });
  return items.filter((i) => i.title);
}

export function rssConnector(source) {
  const cfg = source.config || {};
  return {
    key: source.key,
    name: source.name,
    type: source.type || 'tender',
    homepage: cfg.url,
    access: 'RSS/Atom feed',
    custom: true,
    guard: true,
    respectRobots: true,
    minDelayMs: 2000,
    intervalMinutes: 360,
    async fetch({ get, now = Date.now(), credential } = {}) {
      if (!cfg.url) throw new Error('This source has no feed URL');
      const headers = authHeaders(credential);
      const items = parseFeed(await get(cfg.url, { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml', headers }), { baseUrl: cfg.url });
      return items.filter((i) => !i.closes_at || Date.parse(i.closes_at) > now);
    },
  };
}

// A feed or page may sit behind HTTP Basic auth or a token header.
export function authHeaders(credential) {
  if (!credential) return {};
  if (credential.kind === 'header' && credential.header && credential.value) return { [credential.header]: credential.value };
  if (credential.kind === 'api-key' && credential.key) return { Authorization: `Bearer ${credential.key}` };
  if (credential.kind === 'login') return { Authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString('base64')}` };
  return {};
}
