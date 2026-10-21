// Maps an OCDS release (Open Contracting Data Standard) to our opportunity
// shape. Used by Contracts Finder today, and Find a Tender later.
import { clean, isoOrNull } from './util.js';

export function mapRelease(r, { noticeUrl }) {
  const t = r.tender || {};
  const buyer = r.buyer?.name || (r.parties || []).find((p) => (p.roles || []).includes('buyer'))?.name || '';
  const regions = new Set();
  for (const item of t.items || []) {
    for (const addr of item.deliveryAddresses || []) if (addr.region) regions.add(addr.region);
  }
  const cpv = [t.classification, ...(t.items || []).map((i) => i.classification)]
    .filter((c) => c?.scheme === 'CPV' && c.id)
    .map((c) => `${c.id} ${c.description || ''}`.trim());
  const suitability = t.suitability || {};
  const smeNote = suitability.sme ? 'Suitable for SMEs' : '';
  const value = t.value?.amount ?? t.minValue?.amount ?? null;
  return {
    external_id: r.ocid || r.id,
    title: clean(t.title || r.title),
    summary: clean(t.description),
    url: noticeUrl(r),
    funder: clean(buyer),
    location: [...regions].join(', '),
    eligibility: [smeNote, ...cpv].filter(Boolean).join('; '),
    status: clean(t.status),
    award_min: t.minValue?.amount ?? null,
    award_max: value,
    total_fund: null,
    award_text: '',
    opens_at: isoOrNull(t.tenderPeriod?.startDate),
    closes_at: isoOrNull(t.tenderPeriod?.endDate),
    published_at: isoOrNull(r.date),
  };
}
