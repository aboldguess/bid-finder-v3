// Scores how well an opportunity fits an organisation's profile, 0-100,
// with plain-English reasons so users can see why something was ranked.

export const splitList = (text) =>
  (text || '').split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);

// Regions that a nationwide opportunity covers.
const NATIONAL = /\b(uk|united kingdom|uk-wide|national|great britain|nationwide|any)\b/i;
const ENGLAND_REGIONS = ['north east', 'north west', 'yorkshire', 'east midlands', 'west midlands', 'midlands', 'east of england', 'london', 'south east', 'south west'];

function regionMatches(location, regions) {
  if (!location || NATIONAL.test(location)) return true;
  const parts = location.toLowerCase().split(/[,;]/).map((p) => p.trim()).filter(Boolean);
  return regions.some((r) => {
    const reg = r.toLowerCase();
    if (parts.some((p) => p.includes(reg) || reg.includes(p))) return true;
    // An England-wide scheme covers every English region.
    return parts.includes('england') && ENGLAND_REGIONS.some((e) => reg.includes(e));
  });
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (kw) => new RegExp(`\\b${escape(kw)}`, 'i');

export function scoreOpportunity(opp, profile, now = Date.now()) {
  const reasons = [];
  const types = splitList(profile.types || 'grant');
  if (types.length && !types.includes(opp.type)) return { score: 0, excluded: true, reasons: ['Not an opportunity type you follow'] };
  if (opp.closes_at && Date.parse(opp.closes_at) < now) return { score: 0, excluded: true, reasons: ['Closed'] };

  const text = `${opp.title} ${opp.summary} ${opp.eligibility} ${opp.funder}`;
  const excluded = splitList(profile.exclude_keywords).find((kw) => wordRe(kw).test(text));
  if (excluded) return { score: 0, excluded: true, reasons: [`Mentions "${excluded}", which you excluded`] };

  let score = 0;
  const keywords = splitList(profile.keywords);
  const inTitle = keywords.filter((kw) => wordRe(kw).test(opp.title));
  const inBody = keywords.filter((kw) => !inTitle.includes(kw) && wordRe(kw).test(text));
  score += Math.min(45, inTitle.length * 20) + Math.min(25, inBody.length * 8);
  if (inTitle.length) reasons.push(`Title mentions ${inTitle.map((k) => `"${k}"`).join(', ')}`);
  if (inBody.length) reasons.push(`Description mentions ${inBody.map((k) => `"${k}"`).join(', ')}`);
  if (!keywords.length) score += 30; // unpersonalised profiles still see everything

  const regions = splitList(profile.regions);
  if (regions.length) {
    if (regionMatches(opp.location, regions)) {
      score += 10;
      if (opp.location) reasons.push(`Open in your area (${opp.location})`);
    } else {
      score -= 25;
      reasons.push(`Location may not cover you (${opp.location})`);
    }
  }

  const applicantTypes = splitList(profile.applicant_types);
  if (applicantTypes.length && opp.eligibility) {
    const hit = applicantTypes.find((a) => wordRe(a).test(opp.eligibility));
    if (hit) {
      score += 10;
      reasons.push(`Open to ${hit}`);
    }
  } else if (applicantTypes.length) {
    score += 5;
  }

  const { min_award: lo, max_award: hi } = profile;
  const oppMax = opp.award_max ?? opp.award_min;
  const oppMin = opp.award_min ?? 0;
  if (oppMax != null && (lo != null || hi != null)) {
    const fits = (lo == null || oppMax >= lo) && (hi == null || oppMin <= hi);
    if (fits) {
      score += 10;
      reasons.push('Award size is in your range');
    } else {
      score -= 15;
      reasons.push('Award size is outside your range');
    }
  }

  if (opp.closes_at) {
    const days = (Date.parse(opp.closes_at) - now) / 864e5;
    if (days < 7) reasons.push(`Closes in ${Math.max(0, Math.ceil(days))} day${Math.ceil(days) === 1 ? '' : 's'}`);
    else score += 5;
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), excluded: false, reasons };
}
