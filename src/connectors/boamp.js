// BOAMP (France): the official bulletin of French public procurement notices,
// national and European, via its open-data API (Opendatasoft, no key).
// Reads contract notices ("avis de marché") whose deadline has not passed.
import { clean, fetchText, htmlText, localToIso, opportunity } from './util.js';

const API = 'https://boamp-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/boamp/records';
const LIMIT = 100;
const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]).map((x) => clean(String(x))).filter(Boolean);

export function parsePage(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const items = (data.results || []).map((r) => opportunity({
    external_id: r.idweb || r.id,
    title: htmlText(r.objet),
    summary: [list(r.type_marche).join(', '), list(r.descripteur_libelle).join(', '), r.procedure_libelle].filter(Boolean).join(' · '),
    url: `https://www.boamp.fr/pages/avis/?q=idweb:%22${encodeURIComponent(r.idweb || r.id)}%22`,
    funder: htmlText(r.nomacheteur),
    location: list(r.code_departement).length ? `France (département ${list(r.code_departement).join(', ')})` : 'France',
    eligibility: list(r.descripteur_libelle).join(', '),
    status: clean(r.etat),
    closes_at: localToIso(r.datelimitereponse),
    published_at: localToIso(r.dateparution && `${r.dateparution}T00:00:00`),
    country: 'FR',
    currency: 'EUR',
    notice_type: clean(r.nature_libelle || r.nature),
  })).filter((i) => i.external_id && i.title);
  return { items, total: Number(data.total_count) || 0 };
}

export default {
  key: 'boamp',
  name: 'BOAMP (France)',
  type: 'tender',
  homepage: 'https://www.boamp.fr',
  access: 'Official open-data API',
  intervalMinutes: 360,
  minDelayMs: 1000,
  enabledByDefault: false,
  settings: [{ key: 'keyword', label: 'Keyword', placeholder: 'ingénierie', help: 'Optional. Only notices whose subject contains this word (French).' }],
  async fetch({ maxPages = 40, get = fetchText, days = 14, since, now = Date.now(), config = {} } = {}) {
    const from = new Date(since ? Date.parse(since) - 864e5 : now - days * 864e5).toISOString().slice(0, 10);
    const keyword = clean(config.keyword).replace(/["\\]/g, '').slice(0, 100);
    const where = [`nature="APPEL_OFFRE"`, `dateparution>=date'${from}'`, `datelimitereponse>now()`, keyword && `search(objet, "${keyword}")`].filter(Boolean).join(' AND ');
    const all = new Map();
    // Opendatasoft caps offset + limit at 10,000.
    for (let page = 0; page < Math.min(maxPages, 100); page++) {
      const params = new URLSearchParams({ where, order_by: 'dateparution desc', limit: String(LIMIT), offset: String(page * LIMIT) });
      const { items, total } = parsePage(await get(`${API}?${params}`, { accept: 'application/json' }));
      items.forEach((i) => all.set(i.external_id, i));
      if (!items.length || (page + 1) * LIMIT >= total) break;
    }
    return [...all.values()].filter((i) => !i.closes_at || Date.parse(i.closes_at) > now);
  },
};
