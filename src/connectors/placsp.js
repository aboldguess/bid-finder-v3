// Plataforma de Contratación del Sector Público (Spain): the national
// procurement platform, via its official Atom syndication feed (CODICE
// format). Each feed file links to the next, older one; we read back to the
// last run and keep tenders still open for bids (status PUB).
import * as cheerio from 'cheerio';
import { cetOffset, clean, cpvCode, fetchText, isoOrNull, opportunity, stillOpen, uniq } from './util.js';

const FEED = 'https://contrataciondelestado.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom';
const TYPES = { 1: 'Supplies', 2: 'Services', 3: 'Works', 21: 'Public service management', 31: 'Concession of works', 40: 'Concession of services', 50: 'Special administrative', 7: 'Public-private', 8: 'Private' };
const tag = (name) => name.replace(':', '\\:');

export function parseFeed(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const find = (el, ...path) => path.reduce((node, name) => node.find(tag(name)).first(), $(el));
  const text = (el, ...path) => clean(find(el, ...path).text());
  const entries = $('entry').toArray();
  const items = entries.map((el) => {
    const status = text(el, 'cbc-place-ext:ContractFolderStatusCode');
    const project = find(el, 'cac:ProcurementProject');
    const endDate = text(el, 'cac:TenderSubmissionDeadlinePeriod', 'cbc:EndDate');
    const endTime = text(el, 'cac:TenderSubmissionDeadlinePeriod', 'cbc:EndTime');
    const closes = endDate ? isoOrNull(`${endDate}T${/^\d{2}:\d{2}(:\d{2})?$/.test(endTime) ? endTime.padEnd(8, ':00').slice(0, 8) : '23:59:00'}${cetOffset(endDate)}`) : null;
    const value = Number(text(project, 'cac:BudgetAmount', 'cbc:EstimatedOverallContractAmount') || text(project, 'cac:BudgetAmount', 'cbc:TaxExclusiveAmount'));
    const currency = find(project, 'cac:BudgetAmount', 'cbc:TaxExclusiveAmount').attr('currencyID') || 'EUR';
    const cpv = uniq(project.find(tag('cbc:ItemClassificationCode')).toArray().map((c) => cpvCode($(c).text())));
    const region = text(project, 'cac:RealizedLocation', 'cbc:CountrySubentity');
    const link = $(el).children('link').attr('href') || '';
    return {
      status,
      item: opportunity({
        external_id: clean($(el).children('id').text()).split('/').pop() || text(el, 'cbc:ContractFolderID'),
        title: clean($(el).children('title').text()) || text(project, 'cbc:Name'),
        summary: [text(el, 'cbc:ContractFolderID') && `Expediente ${text(el, 'cbc:ContractFolderID')}`, TYPES[text(project, 'cbc:TypeCode')]].filter(Boolean).join(' · '),
        url: link,
        funder: text(el, 'cac-place-ext:LocatedContractingParty', 'cac:Party', 'cac:PartyName', 'cbc:Name'),
        location: region ? `${region}, Spain` : 'Spain',
        eligibility: cpv.length ? `CPV ${cpv.join(', ')}` : '',
        status: status === 'PUB' ? 'Open' : status,
        award_max: Number.isFinite(value) && value > 0 ? value : null,
        closes_at: closes,
        published_at: isoOrNull($(el).children('updated').text()),
        cpv_codes: cpv.join(' '),
        country: 'ES',
        currency,
        notice_type: TYPES[text(project, 'cbc:TypeCode')] || '',
      }),
    };
  });
  return {
    items: items.filter((x) => x.status === 'PUB' && x.item.external_id && x.item.title && /^https?:/.test(x.item.url)).map((x) => x.item),
    oldest: Math.min(...entries.map((el) => Date.parse($(el).children('updated').text())).filter(Number.isFinite)),
    next: $('feed > link[rel="next"]').attr('href') || null,
  };
}

export default {
  key: 'placsp',
  name: 'Plataforma de Contratación (Spain)',
  type: 'tender',
  homepage: 'https://contrataciondelestado.es',
  access: 'Official Atom feed',
  intervalMinutes: 360,
  minDelayMs: 2000,
  enabledByDefault: false,
  async fetch({ maxPages = 15, get = fetchText, days = 3, since, now = Date.now() } = {}) {
    const from = since ? Date.parse(since) - 3600e3 : now - days * 864e5;
    const all = new Map();
    let url = FEED;
    for (let page = 0; url && page < maxPages; page++) {
      const { items, oldest, next } = parseFeed(await get(url, { accept: 'application/atom+xml', timeoutMs: 120000 }));
      // Newer entries come first; keep the first (newest) copy of each.
      items.forEach((i) => { if (!all.has(i.external_id)) all.set(i.external_id, i); });
      if (oldest < from) break;
      url = next;
    }
    return stillOpen([...all.values()], now);
  },
};
