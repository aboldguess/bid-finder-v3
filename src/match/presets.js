// Starting points for a firm's profile: keywords and CPV categories (Common
// Procurement Vocabulary, by leading digits) for common disciplines. Picking
// one on the profile or welcome page adds to what is there. Engineering comes
// first; the general sectors after it are for other small firms on a hosted
// service.
export const presets = [
  { id: 'consultancy', label: 'Engineering design and consultancy', cpv: ['713'],
    keywords: ['engineering design', 'engineering services', 'technical consultancy', 'feasibility study', 'detailed design', 'design services'] },
  { id: 'mechanical', label: 'Mechanical and manufacturing', cpv: ['42', '71333', '71334', '5053', '515', '4535'],
    keywords: ['mechanical engineering', 'fabrication', 'machining', 'precision engineering', 'manufacturing', 'welding', 'tooling', 'prototype'] },
  { id: 'electrical', label: 'Electrical, controls and automation', cpv: ['31', '4531', '511', '717', '71321'],
    keywords: ['electrical engineering', 'control system', 'PLC', 'SCADA', 'automation', 'instrumentation', 'switchgear', 'robotics'] },
  { id: 'civil', label: 'Civil and structural', cpv: ['4522', '4523', '4524', '71311', '71312', '442'],
    keywords: ['civil engineering', 'structural engineering', 'bridge', 'highways', 'drainage', 'geotechnical', 'site investigation'] },
  { id: 'software', label: 'Software, data and digital engineering', cpv: ['72', '48'],
    keywords: ['software development', 'embedded software', 'digital twin', 'simulation', 'modelling', 'data platform', 'systems engineering'] },
  { id: 'rd', label: 'Research, development and innovation', cpv: ['73'],
    keywords: ['research and development', 'innovation', 'demonstrator', 'proof of concept', 'SBRI', 'feasibility', 'technology development'] },
  { id: 'test', label: 'Testing, inspection and certification', cpv: ['716', '385'],
    keywords: ['testing', 'inspection', 'calibration', 'non-destructive testing', 'certification', 'condition monitoring'] },
  { id: 'energy', label: 'Energy and net zero', cpv: ['093', '71314', '4525'],
    keywords: ['net zero', 'decarbonisation', 'hydrogen', 'heat pump', 'renewable', 'battery', 'nuclear', 'offshore wind'] },
  { id: 'defence', label: 'Defence and aerospace', cpv: ['35', '347'],
    keywords: ['defence', 'aerospace', 'MOD', 'Dstl', 'naval', 'uncrewed', 'space'] },
  { id: 'transport', label: 'Rail and transport', cpv: ['346', '4523', '349'],
    keywords: ['rail', 'rolling stock', 'signalling', 'electric vehicle', 'charging infrastructure', 'transport'] },
  { id: 'construction', group: 'other', label: 'Construction and refurbishment', cpv: ['45'],
    keywords: ['construction', 'refurbishment', 'building works', 'extension', 'roofing', 'groundworks', 'fit-out'] },
  { id: 'facilities', group: 'other', label: 'Facilities and building maintenance', cpv: ['507', '5070', '797', '909', '4533'],
    keywords: ['facilities management', 'building maintenance', 'planned maintenance', 'reactive maintenance', 'HVAC', 'cleaning services', 'grounds maintenance'] },
  { id: 'it', group: 'other', label: 'IT services and telecoms', cpv: ['72', '48', '302', '322', '642'],
    keywords: ['IT services', 'managed service', 'cyber security', 'cloud', 'network', 'telecommunications', 'software licence'] },
  { id: 'management', group: 'other', label: 'Management and professional consultancy', cpv: ['794', '7941', '7942', '791', '792'],
    keywords: ['consultancy', 'management consultancy', 'business support', 'evaluation', 'strategy', 'programme management'] },
  { id: 'health', group: 'other', label: 'Health and social care', cpv: ['85', '331'],
    keywords: ['health services', 'social care', 'domiciliary care', 'mental health', 'medical equipment', 'community services'] },
  { id: 'training', group: 'other', label: 'Training and education', cpv: ['80'],
    keywords: ['training', 'apprenticeship', 'education', 'learning', 'skills', 'e-learning'] },
  { id: 'environment', group: 'other', label: 'Environmental and waste services', cpv: ['905', '9071', '9072', '904'],
    keywords: ['waste management', 'recycling', 'environmental services', 'ecology', 'contaminated land', 'water treatment'] },
];

// Adds each picked preset's keywords and CPV categories to a profile's lists,
// keeping what is there and never repeating a line.
export function mergePresets(ids, { keywords = '', cpv_codes = '' } = {}) {
  const chosen = presets.filter((p) => ids.includes(p.id));
  const add = (text, items) => {
    const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const seen = new Set(lines.map((l) => l.toLowerCase()));
    for (const item of items) if (!seen.has(item.toLowerCase())) { seen.add(item.toLowerCase()); lines.push(item); }
    return lines.join('\n');
  };
  return {
    keywords: add(keywords, chosen.flatMap((p) => p.keywords)),
    cpv_codes: add(cpv_codes, chosen.flatMap((p) => p.cpv)),
  };
}
