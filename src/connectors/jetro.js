// JETRO Japanese Government Procurement: the Japanese government's
// designated single point of access (under the WTO GPA and the Japan-EU and
// Japan-UK agreements) for procurement notices of national ministries,
// agencies and incorporated administrative agencies, and of prefectures and
// designated cities. Read from the JSON data files behind JETRO's English
// search pages. No key.
import { clean, fetchText, isoOrNull, opportunity, stillOpen } from './util.js';

const BASE = 'https://www.jetro.go.jp';
const FILES = { central: `${BASE}/XiProcurementSearch/xi_proc_central_en.json`, local: `${BASE}/XiProcurementSearch/xi_proc_local_en.json` };
// Columns of each row, as the search page reads them.
const X = { xid: 0, aid: 1, title: 2, date: 3, agency: 4, location: 5, cats: 6, deadline: 7, type: 8 };

// "20270201" -> end of that day in Japan (UTC+9).
const jpDay = (v, { endOfDay = true } = {}) => {
  const m = String(v || '').match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? isoOrNull(`${m[1]}-${m[2]}-${m[3]}T${endOfDay ? '23:59' : '00:00'}:00+09:00`) : null;
};

export function parseFile(json, kind = 'central') {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const masters = data.masters || {};
  const agencies = masters.agencies || {};
  const places = masters.prefectures || {};
  const types = masters.paKinds || {};
  const isCentral = (data.govKind || kind) === 'central';
  const place = (code) => places[code] || places[String(code).slice(0, 2)] || '';
  return (data.rows || []).map((row) => {
    const path = isCentral ? `national/articles/${encodeURIComponent(row[X.xid])}/${encodeURIComponent(row[X.aid])}` : `local/articles/${encodeURIComponent(row[X.aid])}`;
    const where = place(row[X.location]);
    return opportunity({
      external_id: `${isCentral ? 'n' : 'l'}-${row[X.aid]}`,
      title: clean(row[X.title]),
      summary: [types[row[X.type]] || (isCentral ? '' : 'Local government call for tender'), isCentral && `Notice ${row[X.aid]}`].filter(Boolean).join(' · '),
      url: `${BASE}/en/database/procurement/${path}.html`,
      funder: clean(agencies[row[X.agency]] || row[X.agency]),
      location: where ? `${where}, Japan` : 'Japan',
      closes_at: jpDay(row[X.deadline]),
      published_at: jpDay(row[X.date], { endOfDay: false }),
      country: 'JP',
      currency: 'JPY',
      notice_type: clean(types[row[X.type]]),
    });
  }).filter((i) => i.title && i.external_id);
}

// Notices of procurement and of planned procurement are opportunities; notices
// of single tendering, requests for comments and the like are not.
const OPEN_TYPES = new Set(['01', '02', '04', '07', '09', '10']);

export default {
  key: 'jetro-japan',
  name: 'Japanese Government Procurement (JETRO)',
  type: 'tender',
  homepage: `${BASE}/en/database/procurement/`,
  access: 'Public data files',
  intervalMinutes: 720,
  minDelayMs: 3000,
  enabledByDefault: false,
  settings: [{ key: 'scope', label: 'Scope', placeholder: 'central,local', help: 'central (national government and agencies), local (prefectures and designated cities), or both.' }],
  async fetch({ get = fetchText, now = Date.now(), config = {} } = {}) {
    const kinds = String(config.scope || 'central,local').split(',').map((s) => clean(s)).filter((s) => FILES[s]);
    const all = new Map();
    for (const kind of kinds.length ? kinds : ['central', 'local']) {
      const data = JSON.parse(await get(FILES[kind], { accept: 'application/json', timeoutMs: 120000 }));
      // Local notices carry no type; they are all calls for tender.
      data.rows = (data.rows || []).filter((row) => !row[X.type] || OPEN_TYPES.has(row[X.type]));
      for (const item of parseFile(data, kind)) all.set(item.external_id, item);
    }
    return stillOpen([...all.values()], now);
  },
};
