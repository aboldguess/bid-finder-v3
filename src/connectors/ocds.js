// Maps an OCDS release (Open Contracting Data Standard) to our opportunity
// shape. Contracts Finder, Find a Tender, Public Contracts Scotland and
// Sell2Wales all publish OCDS, each with its own quirks, so this reads
// defensively: values may sit on the tender or its lots, CPV codes on the
// tender, its items or their additional classifications.
import { clean, countryCode, cpvCode, isoOrNull, uniq } from './util.js';

const CLOSED = new Set(['complete', 'cancelled', 'unsuccessful', 'withdrawn']);

// Some portals emit numbers JSON cannot hold (seen on Find a Tender).
export const parseOcdsJson = (text) =>
  (typeof text === 'string' ? JSON.parse(text.replace(/\b1e9999\b/g, '9999999')) : text);

export const isOpenRelease = (r) => !CLOSED.has(String(r.tender?.status || '').toLowerCase());

// Several releases can describe one procurement; keep the newest of each.
export function latestByOcid(releases) {
  const byOcid = new Map();
  for (const r of releases) {
    const key = r.ocid || r.id;
    const seen = byOcid.get(key);
    if (!seen || String(r.date || '') >= String(seen.date || '')) byOcid.set(key, r);
  }
  return [...byOcid.values()];
}

function classifications(t) {
  const out = [];
  const add = (c) => { if (c && /cpv/i.test(c.scheme || 'CPV') && cpvCode(c.id)) out.push({ code: cpvCode(c.id), description: clean(c.description) }); };
  add(t.classification);
  for (const c of t.additionalClassifications || []) add(c);
  for (const item of t.items || []) {
    add(item.classification);
    for (const c of item.additionalClassifications || []) add(c);
  }
  const seen = new Set();
  return out.filter((c) => !seen.has(c.code) && seen.add(c.code));
}

function tenderValue(t) {
  const direct = t.value?.amount ?? t.value?.amountGross;
  if (Number.isFinite(direct)) return { amount: direct, currency: t.value.currency };
  const lots = (t.lots || []).map((l) => l.value).filter((v) => Number.isFinite(v?.amount ?? v?.amountGross));
  if (lots.length) return { amount: lots.reduce((sum, v) => sum + (v.amount ?? v.amountGross), 0), currency: lots[0].currency };
  return { amount: null, currency: t.minValue?.currency };
}

export function mapRelease(r, { noticeUrl }) {
  const t = r.tender || {};
  const buyerParty = (r.parties || []).find((p) => (p.roles || []).includes('buyer') || (p.roles || []).includes('procuringEntity'));
  const buyer = r.buyer?.name || buyerParty?.name || '';
  const addresses = (t.items || []).flatMap((i) => i.deliveryAddresses || (i.deliveryAddress ? [i.deliveryAddress] : []));
  const regions = uniq(addresses.map((a) => clean(a.region || a.locality)));
  const country = uniq([...addresses.map((a) => countryCode(a.country || a.countryName)), countryCode(buyerParty?.address?.country || buyerParty?.address?.countryName)])[0] || '';
  const cpv = classifications(t);
  const value = tenderValue(t);
  const smeNote = t.suitability?.sme ? 'Suitable for SMEs' : '';
  const closes = t.tenderPeriod?.endDate || t.enquiryPeriod?.endDate || t.expressionOfInterestDeadline;
  return {
    external_id: r.ocid || r.id,
    title: clean(t.title || r.title),
    summary: clean(t.description || r.description),
    url: noticeUrl(r),
    funder: clean(buyer),
    location: regions.join(', '),
    eligibility: [smeNote, ...cpv.map((c) => `${c.code} ${c.description}`.trim())].filter(Boolean).join('; '),
    status: clean(t.status),
    award_min: t.minValue?.amount ?? null,
    award_max: value.amount,
    total_fund: null,
    award_text: '',
    opens_at: isoOrNull(t.tenderPeriod?.startDate),
    closes_at: isoOrNull(closes),
    published_at: isoOrNull(r.date),
    cpv_codes: cpv.map((c) => c.code).join(' '),
    country,
    currency: value.currency || 'GBP',
    notice_type: clean((r.tag || []).join(', ')),
  };
}

// The notice's own web page, where a release carries one.
export function documentUrl(r, hostPattern) {
  const docs = [...(r.tender?.documents || []), ...(r.planning?.documents || [])];
  return docs.map((d) => d.url).find((u) => u && hostPattern.test(u)) || null;
}
