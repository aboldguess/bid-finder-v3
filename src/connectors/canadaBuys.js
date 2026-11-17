// CanadaBuys: every open Government of Canada tender (federal departments,
// Crown corporations such as VIA Rail, and many provinces' notices), from the
// official open-data file of open tender notices, refreshed daily. No key.
import { clean, easternOffset, fetchText, htmlText, localToIso, opportunity, parseCsv, stillOpen, uniq } from './util.js';

const CSV = 'https://canadabuys.canada.ca/opendata/pub/openTenderNotice-ouvertAvisAppelOffres.csv';
const col = (row, prefix) => clean(row[Object.keys(row).find((k) => k.startsWith(prefix)) ?? ''] ?? '');
const lines = (s) => uniq(String(s || '').split(/\r?\n/).map((x) => clean(x.replace(/^\*/, ''))));

export function parseCsvFile(text) {
  return parseCsv(text).map((r) => {
    const ref = col(r, 'referenceNumber-');
    const closes = col(r, 'tenderClosingDate-');
    return opportunity({
      external_id: ref,
      title: htmlText(col(r, 'title-titre-eng')),
      summary: htmlText(col(r, 'tenderDescription-descriptionAppelOffres-eng')).slice(0, 4000),
      url: col(r, 'noticeURL-URLavis-eng') || `https://canadabuys.canada.ca/en/tender-opportunities/tender-notice/${encodeURIComponent(ref.toLowerCase())}`,
      funder: col(r, 'contractingEntityName-nomEntitContractante-eng'),
      location: lines(col(r, 'regionsOfDelivery-regionsLivraison-eng')).join(', ') || 'Canada',
      eligibility: [lines(col(r, 'gsinDescription-nibsDescription-eng')).join(', '), lines(col(r, 'unspscDescription-eng')).join(', '), col(r, 'procurementMethod-methodeApprovisionnement-eng')].filter(Boolean).join(' · '),
      status: col(r, 'tenderStatus-appelOffresStatut-eng'),
      closes_at: localToIso(closes, easternOffset),
      published_at: localToIso(col(r, 'publicationDate-datePublication') && `${col(r, 'publicationDate-datePublication')}T00:00:00`, easternOffset),
      country: 'CA',
      currency: 'CAD',
      notice_type: col(r, 'noticeType-avisType-eng'),
    });
  }).filter((i) => i.external_id && i.title);
}

export default {
  key: 'canadabuys',
  name: 'CanadaBuys (Canada)',
  type: 'tender',
  homepage: 'https://canadabuys.canada.ca/en/tender-opportunities',
  access: 'Official open-data file',
  intervalMinutes: 720,
  minDelayMs: 2000,
  enabledByDefault: false,
  async fetch({ get = fetchText, now = Date.now() } = {}) {
    const items = parseCsvFile(await get(CSV, { accept: 'text/csv', timeoutMs: 120000 }));
    return stillOpen([...new Map(items.map((i) => [i.external_id, i])).values()], now);
  },
};
