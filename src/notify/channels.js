// Delivery channels for alerts: email (SMTP), Slack incoming webhooks and
// generic JSON webhooks. Each returns nothing on success and throws on failure.
import path from 'node:path';
import ejs from 'ejs';
import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { createHttp } from '../http/client.js';

const template = path.join(config.root, 'src/web/views/digest-email.ejs');
let transport;
export const mailer = () => (transport ??= config.smtp.url ? nodemailer.createTransport(config.smtp.url) : null);
export const emailConfigured = () => Boolean(config.smtp.url);

export const renderEmail = (data) => ejs.renderFile(template, { baseUrl: config.baseUrl, heading: null, intro: null, manageUrl: `${config.baseUrl}/profile`, ...data });

export async function sendEmail({ to, subject, html }) {
  const t = mailer();
  if (!t) throw new Error('Email is not set up on this server (SMTP_URL)');
  await t.sendMail({ from: config.smtp.from, to: to.join(', '), subject, html });
}

const money = (o) => (o.award_max ? `${{ GBP: '£', EUR: '€', USD: '$' }[o.currency] || ''}${Number(o.award_max).toLocaleString('en-GB')}` : '');
const day = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' });
const mrkdwn = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function slackPayload({ title, items, link }) {
  const blocks = [{ type: 'header', text: { type: 'plain_text', text: title.slice(0, 150) } }];
  for (const o of items.slice(0, 10)) {
    const facts = [`Fit ${o.match.score}`, o.funder, money(o), o.closes_at && `closes ${day(o.closes_at)}`].filter(Boolean).map(mrkdwn).join(' · ');
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*<${config.baseUrl}/o/${o.id}|${mrkdwn(o.title).slice(0, 250)}>*\n${facts}`.slice(0, 2900) } });
  }
  if (items.length > 10) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `And ${items.length - 10} more. <${link}|See them all>` }] });
  return { text: `${title}: ${items.length} new`, blocks };
}

// Webhook URLs are set by users, so they go through the private-network guard.
const http = createHttp({ guard: true, minDelayMs: 0, retries: 2 });
const postJson = (url, payload, request = http.request) =>
  request(url, { method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' }, timeoutMs: 15000 });

export async function sendSlack(url, message, request) {
  if (!/^https:\/\/hooks\.slack(-gov)?\.com\//.test(url)) throw new Error('Slack webhook URLs start with https://hooks.slack.com/');
  await postJson(url, slackPayload(message), request);
}

export function webhookPayload({ title, search, items }) {
  return {
    event: 'opportunities.matched',
    search: search ? { id: search.id, name: search.name } : null,
    title,
    count: items.length,
    opportunities: items.map((o) => ({
      id: o.id, title: o.title, buyer: o.funder, source: o.source_key, type: o.type, score: o.match.score, reasons: o.match.reasons,
      value: o.award_max, currency: o.currency, closes_at: o.closes_at, cpv_codes: (o.cpv_codes || '').split(' ').filter(Boolean),
      url: o.url, app_url: `${config.baseUrl}/o/${o.id}`,
    })),
  };
}

export const sendWebhook = (url, message, request) => postJson(url, webhookPayload(message), request);
