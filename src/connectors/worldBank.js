// World Bank procurement notices: invitations for bids and requests for
// expressions of interest on World Bank-financed projects in every borrowing
// country (much of South and South East Asia, Africa and Latin America),
// via the official Procurement Notices API. No key.
import { clean, fetchText, htmlText, opportunity, stillOpen } from './util.js';

const API = 'https://search.worldbank.org/api/v2/procnotices';
const ROWS = 500;
const FIELDS = 'id,notice_type,noticedate,submission_deadline_date,submission_deadline_time,project_ctry_name,project_id,project_name,bid_reference_no,bid_description,procurement_group,procurement_method_name,contact_organization,submission_date,notice_status,notice_lang_name';
const OPEN_TYPES = /invitation|expression of interest|request for (bids|proposals|quotations)|prequalification|general procurement/i;
const GROUPS = { GO: 'Goods', CW: 'Civil works', CS: 'Consulting services', NC: 'Non-consulting services' };

export function parsePage(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const raw = Array.isArray(data.procnotices) ? data.procnotices : Object.values(data.procnotices || {});
  const items = raw.filter((n) => OPEN_TYPES.test(n.notice_type || '')).map((n) => opportunity({
    external_id: n.id,
    title: htmlText(n.bid_description || n.project_name),
    summary: [n.project_name && `Project: ${htmlText(n.project_name)} (${n.project_id})`, n.procurement_method_name, n.bid_reference_no && `Ref ${n.bid_reference_no}`, n.notice_lang_name && n.notice_lang_name !== 'English' && `Notice in ${n.notice_lang_name}`].filter(Boolean).join(' · '),
    url: `https://projects.worldbank.org/en/projects-operations/procurement-detail/${n.id}`,
    funder: htmlText(n.contact_organization) || 'World Bank-financed project',
    location: clean(n.project_ctry_name),
    eligibility: GROUPS[n.procurement_group] || clean(n.procurement_group),
    status: clean(n.notice_status),
    closes_at: n.submission_deadline_date ? new Date(Date.parse(n.submission_deadline_date) + (/^\d{1,2}:\d{2}$/.test(n.submission_deadline_time || '') ? (Number(n.submission_deadline_time.split(':')[0]) * 60 + Number(n.submission_deadline_time.split(':')[1])) * 6e4 : 864e5 - 6e4)).toISOString() : null,
    published_at: n.submission_date ? new Date(Date.parse(n.submission_date)).toISOString() : null,
    currency: 'USD',
    notice_type: clean(n.notice_type),
  })).filter((i) => i.external_id && i.title);
  return { items, raw, total: Number(data.total) || 0 };
}

export default {
  key: 'world-bank',
  name: 'World Bank procurement notices',
  type: 'tender',
  homepage: 'https://projects.worldbank.org/en/projects-operations/procurement',
  access: 'Official API',
  intervalMinutes: 720,
  minDelayMs: 1500,
  enabledByDefault: false,
  settings: [{ key: 'countries', label: 'Countries', placeholder: 'Indonesia, Philippines, Viet Nam', help: 'Optional, comma-separated project countries as the World Bank names them. Empty means all.' }],
  async fetch({ maxPages = 10, get = fetchText, days = 14, since, now = Date.now(), config = {} } = {}) {
    const from = since ? Date.parse(since) - 864e5 : now - days * 864e5;
    const wanted = String(config.countries || '').split(',').map((c) => clean(c).toLowerCase()).filter(Boolean);
    const all = new Map();
    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams({ format: 'json', rows: String(ROWS), os: String(page * ROWS), srt: 'submission_date', order: 'desc', fl: FIELDS });
      const { items, raw } = parsePage(await get(`${API}?${params}`, { accept: 'application/json' }));
      items.forEach((i) => all.set(i.external_id, i));
      const oldest = raw.map((n) => Date.parse(n.submission_date)).filter(Number.isFinite).sort((a, b) => a - b)[0];
      if (raw.length < ROWS || oldest < from) break;
    }
    const items = [...all.values()].filter((i) => !wanted.length || wanted.some((c) => i.location.toLowerCase().includes(c)));
    return stillOpen(items, now);
  },
};
