// Connector for portals with no API or feed, including ones behind a login.
// An administrator describes the portal once (where to sign in, which page
// lists opportunities, and CSS selectors for each field) and attaches a
// credential from the vault. We sign in with a normal form post, keep the
// session cookies for the run, and read the listing pages.
//
// This handles classic server-rendered portals. It will not get past CAPTCHA,
// multi-factor prompts or logins that only work with JavaScript.
import * as cheerio from 'cheerio';
import { createJar } from '../http/client.js';
import { clean, parseAmounts, parseUkDate, isoOrNull, sleep } from './util.js';
import { authHeaders, deadlineFromText } from './rss.js';

const lines = (text) => String(text || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);

// Finds the login form on a page and fills it in, carrying over hidden
// fields such as CSRF tokens and ASP.NET view state.
export function buildLogin(html, pageUrl, { username, password }, cfg = {}) {
  const $ = cheerio.load(html);
  const form = $('form').filter((_, f) => $(f).find('input[type=password]').length > 0).first();
  if (!form.length) throw new Error('No login form with a password field was found at the login URL');
  const fields = new URLSearchParams();
  form.find('input, select, textarea').each((_, el) => {
    const input = $(el);
    const name = input.attr('name');
    const type = (input.attr('type') || '').toLowerCase();
    if (!name || ['submit', 'button', 'image', 'file', 'reset'].includes(type)) return;
    if ((type === 'checkbox' || type === 'radio') && input.attr('checked') === undefined) return;
    fields.set(name, input.val() ?? '');
  });
  const passwordField = cfg.passwordField || form.find('input[type=password]').first().attr('name');
  const usernameField = cfg.usernameField
    || form.find('input[type=email], input[type=text], input:not([type])').filter((_, el) => $(el).attr('name')).first().attr('name');
  if (!usernameField || !passwordField) throw new Error('Could not work out the username and password fields. Set them in the source settings.');
  fields.set(usernameField, username);
  fields.set(passwordField, password);
  const submit = form.find('button[type=submit][name], input[type=submit][name]').first();
  if (submit.length) fields.set(submit.attr('name'), submit.attr('value') || '');
  return { action: new URL(form.attr('action') || pageUrl, pageUrl).href, method: (form.attr('method') || 'post').toUpperCase(), fields };
}

export function parseListing(html, pageUrl, cfg) {
  const $ = cheerio.load(html);
  const pick = (el, selector) => (selector ? clean($(el).find(selector).first().text()) : '');
  const items = [];
  $(cfg.itemSelector).each((_, el) => {
    const linkEl = cfg.linkSelector ? $(el).find(cfg.linkSelector).first() : ($(el).is('a') ? $(el) : $(el).find('a[href]').first());
    const href = linkEl.attr('href');
    let url;
    try { url = new URL(href, pageUrl).href; } catch { return; }
    if (!href || !/^https?:/.test(url)) return;
    const title = pick(el, cfg.titleSelector) || clean(linkEl.text());
    const whole = clean($(el).text());
    const deadlineText = pick(el, cfg.deadlineSelector);
    const amounts = parseAmounts(pick(el, cfg.valueSelector) || whole);
    items.push({
      external_id: url,
      title,
      summary: pick(el, cfg.summarySelector).slice(0, 2000),
      url,
      funder: pick(el, cfg.buyerSelector),
      location: '',
      eligibility: '',
      status: '',
      award_min: null,
      award_max: amounts.length ? Math.max(...amounts) : null,
      total_fund: null,
      award_text: '',
      opens_at: null,
      closes_at: (deadlineText && (parseUkDate(deadlineText) || deadlineFromText(`closes ${deadlineText}`) || isoOrNull(deadlineText))) || deadlineFromText(whole),
      published_at: null,
    });
  });
  const nextHref = cfg.nextSelector ? $(cfg.nextSelector).first().attr('href') : null;
  let next = null;
  try { next = nextHref ? new URL(nextHref, pageUrl).href : null; } catch { /* ignore a malformed link */ }
  return { items: items.filter((i) => i.title), next, hasLoginForm: $('input[type=password]').length > 0 };
}

export function portalConnector(source) {
  const cfg = source.config || {};
  return {
    key: source.key,
    name: source.name,
    type: source.type || 'tender',
    homepage: lines(cfg.listUrl)[0],
    access: cfg.loginUrl ? 'Web portal (signed in)' : 'Web page',
    custom: true,
    guard: true,
    // A portal you hold an account on is used under its own terms; public pages follow robots.txt.
    respectRobots: !cfg.loginUrl,
    minDelayMs: 3000,
    intervalMinutes: 720,
    async fetch({ request, maxPages = 10, delayMs = 0, now = Date.now(), credential } = {}) {
      if (!cfg.itemSelector || !lines(cfg.listUrl).length) throw new Error('This source needs a listing URL and an item selector');
      const jar = createJar();
      let headers = {};
      if (cfg.loginUrl) {
        if (credential?.kind !== 'login') throw new Error('This portal needs a username and password credential attached');
        const page = await request(cfg.loginUrl, { jar });
        const login = buildLogin(page.text, page.url, credential, cfg);
        const after = await request(login.action, {
          method: login.method, jar, body: login.fields.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: page.url }, okStatuses: [200, 201, 204],
        });
        if (cheerio.load(after.text)('input[type=password]').length) throw new Error('Sign-in was rejected. Check the username and password in the credential vault.');
      } else {
        headers = authHeaders(credential);
      }
      const all = new Map();
      for (const start of lines(cfg.listUrl)) {
        let url = start;
        for (let page = 0; url && page < maxPages; page++) {
          const res = await request(url, { jar, headers });
          const { items, next, hasLoginForm } = parseListing(res.text, res.url, cfg);
          if (cfg.loginUrl && hasLoginForm && !items.length) throw new Error('The portal showed its sign-in page instead of the listing. The session did not stick.');
          const before = all.size;
          items.forEach((i) => all.set(i.external_id, i));
          url = next && all.size > before ? next : null;
          await sleep(delayMs);
        }
      }
      return [...all.values()].filter((i) => !i.closes_at || Date.parse(i.closes_at) > now);
    },
  };
}
