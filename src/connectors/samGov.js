// SAM.gov: US federal contract opportunities, via the official Get
// Opportunities API. Needs a free API key from a SAM.gov account, stored in
// the credential vault. Personal keys allow very few requests a day, so this
// runs once a day and asks for 1,000 notices per request.
import { clean, fetchText, isoOrNull } from './util.js';

const API = 'https://api.sam.gov/opportunities/v2/search';
const usDate = (ms) => { const d = new Date(ms); return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`; };

export function parsePage(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const items = (data.opportunitiesData || []).filter((o) => String(o.active ?? 'Yes').toLowerCase() !== 'no' && !/award|justification/i.test(o.type || '')).map((o) => {
    const place = o.placeOfPerformance || {};
    const location = [place.city?.name, place.state?.name || place.state?.code, place.country?.name || place.country?.code].filter(Boolean).join(', ');
    return {
      external_id: o.noticeId,
      title: clean(o.title),
      summary: [o.type, o.solicitationNumber && `Solicitation ${o.solicitationNumber}`].filter(Boolean).join(' · '),
      url: o.uiLink || `https://sam.gov/opp/${o.noticeId}/view`,
      funder: clean((o.fullParentPathName || '').split('.').slice(0, 2).join(' · ')),
      location,
      eligibility: [o.naicsCode && `NAICS ${o.naicsCode}`, o.classificationCode && `PSC ${o.classificationCode}`, o.typeOfSetAsideDescription].filter(Boolean).join('; '),
      status: '',
      award_min: null,
      award_max: null,
      total_fund: null,
      award_text: '',
      opens_at: null,
      closes_at: isoOrNull(o.responseDeadLine),
      published_at: isoOrNull(o.postedDate),
      cpv_codes: '',
      country: 'US',
      currency: 'USD',
      notice_type: clean(o.type),
    };
  }).filter((i) => i.external_id && i.title);
  return { items, total: Number(data.totalRecords) || items.length };
}

export default {
  key: 'sam-gov',
  name: 'SAM.gov (US federal)',
  type: 'tender',
  homepage: 'https://sam.gov',
  access: 'Official API (key required)',
  auth: 'api-key',
  intervalMinutes: 1440,
  minDelayMs: 2000,
  enabledByDefault: false,
  settings: [
    { key: 'ncode', label: 'NAICS code', placeholder: '541330', help: 'Optional. 541330 is Engineering Services.' },
    { key: 'ptype', label: 'Notice type', placeholder: 'o', help: 'Optional single code: o solicitation, k combined synopsis, p presolicitation, r sources sought. Empty means all except awards.' },
  ],
  async fetch({ maxPages = 5, get = fetchText, days = 7, since, now = Date.now(), config = {}, credential } = {}) {
    if (!credential?.key) throw new Error('SAM.gov needs an API key. Add one under Admin, Credentials, then attach it to this source.');
    const from = since ? Math.max(Date.parse(since) - 864e5, now - 30 * 864e5) : now - days * 864e5;
    const all = new Map();
    for (let page = 0; page < Math.min(maxPages, 5); page++) {
      const params = new URLSearchParams({ api_key: credential.key, postedFrom: usDate(from), postedTo: usDate(now), limit: '1000', offset: String(page) });
      if (/^[a-z]$/.test(config.ptype || '')) params.set('ptype', config.ptype);
      if (/^\d{2,6}$/.test(config.ncode || '')) params.set('ncode', config.ncode);
      const { items, total } = parsePage(await get(`${API}?${params}`, { accept: 'application/json' }));
      items.forEach((i) => all.set(i.external_id, i));
      if (!items.length || (page + 1) * 1000 >= total) break;
    }
    return [...all.values()].filter((i) => !i.closes_at || Date.parse(i.closes_at) > now);
  },
};
