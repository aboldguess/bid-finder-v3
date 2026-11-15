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

// CPV codes are hierarchical: 71300000 covers everything starting 713.
// A profile entry may be a full code or just the leading digits.
export const cpvPrefix = (code) => String(code).replace(/\D/g, '').slice(0, 8).replace(/0+$/, '').padEnd(2, '0');
export function cpvMatch(oppCodes, prefixes) {
  const codes = String(oppCodes || '').split(/\s+/).filter(Boolean);
  for (const prefix of prefixes) {
    const code = codes.find((c) => c.startsWith(prefix));
    if (code) return { code, prefix };
  }
  return null;
}

// Feeds score thousands of rows against one profile, so parse it once.
const compiled = new WeakMap();
function compile(profile) {
  let c = compiled.get(profile);
  if (!c) {
    const res = (text) => splitList(text).map((kw) => ({ kw, re: wordRe(kw) }));
    c = {
      types: splitList(profile.types || 'grant'),
      keywords: res(profile.keywords),
      excluded: res(profile.exclude_keywords),
      regions: splitList(profile.regions),
      applicantTypes: res(profile.applicant_types),
      cpv: splitList(profile.cpv_codes).map(cpvPrefix).filter((p) => /^\d{2,8}$/.test(p)),
      countries: splitList(profile.countries).map((x) => x.toUpperCase()),
    };
    compiled.set(profile, c);
  }
  return c;
}

export function scoreOpportunity(opp, profile, now = Date.now()) {
  const p = compile(profile);
  const reasons = [];
  if (p.types.length && !p.types.includes(opp.type)) return { score: 0, excluded: true, reasons: ['Not an opportunity type you follow'] };
  if (opp.closes_at && Date.parse(opp.closes_at) < now) return { score: 0, excluded: true, reasons: ['Closed'] };

  const text = `${opp.title} ${opp.summary} ${opp.eligibility} ${opp.funder}`;
  const excluded = p.excluded.find((k) => k.re.test(text));
  if (excluded) return { score: 0, excluded: true, reasons: [`Mentions "${excluded.kw}", which you excluded`] };

  let score = 0;
  const inTitle = p.keywords.filter((k) => k.re.test(opp.title));
  const inBody = p.keywords.filter((k) => !inTitle.includes(k) && k.re.test(text));
  score += Math.min(45, inTitle.length * 20) + Math.min(25, inBody.length * 8);
  if (inTitle.length) reasons.push(`Title mentions ${inTitle.map((k) => `"${k.kw}"`).join(', ')}`);
  if (inBody.length) reasons.push(`Description mentions ${inBody.map((k) => `"${k.kw}"`).join(', ')}`);

  const cpv = p.cpv.length ? cpvMatch(opp.cpv_codes, p.cpv) : null;
  if (cpv) {
    score += 30;
    reasons.push(`CPV ${cpv.code} is in your category ${cpv.prefix}`);
  }
  if (!p.keywords.length && !p.cpv.length) score += 30; // unpersonalised profiles still see everything

  if (p.countries.length && opp.country) {
    if (p.countries.includes(opp.country)) score += 5;
    else {
      score -= 30;
      reasons.push(`Outside your countries (${opp.country})`);
    }
  }

  if (p.regions.length) {
    if (regionMatches(opp.location, p.regions)) {
      score += 10;
      if (opp.location) reasons.push(`Open in your area (${opp.location})`);
    } else {
      score -= 25;
      reasons.push(`Location may not cover you (${opp.location})`);
    }
  }

  if (p.applicantTypes.length && opp.eligibility) {
    const hit = p.applicantTypes.find((a) => a.re.test(opp.eligibility));
    if (hit) {
      score += 10;
      reasons.push(`Open to ${hit.kw}`);
    }
  } else if (p.applicantTypes.length) {
    score += 5;
  }

  const { min_award: lo, max_award: hi } = profile;
  const oppMax = opp.award_max ?? opp.award_min;
  const oppMin = opp.award_min ?? 0;
  if (oppMax != null && (lo != null || hi != null)) {
    const fits = (lo == null || oppMax >= lo) && (hi == null || oppMin <= hi);
    if (fits) {
      score += 10;
      reasons.push(opp.type === 'tender' ? 'Contract value is in your range' : 'Award size is in your range');
    } else {
      score -= 15;
      reasons.push(opp.type === 'tender' ? 'Contract value is outside your range' : 'Award size is outside your range');
    }
  }

  if (opp.closes_at) {
    const days = (Date.parse(opp.closes_at) - now) / 864e5;
    if (days < 7) reasons.push(`Closes in ${Math.max(0, Math.ceil(days))} day${Math.ceil(days) === 1 ? '' : 's'}`);
    else score += 5;
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), excluded: false, reasons };
}
