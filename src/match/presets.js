// Starting points for an engineering firm's profile: keywords and CPV
// categories (Common Procurement Vocabulary, by leading digits) for common
// disciplines. Picking one on the profile page adds to what is there.
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
];
