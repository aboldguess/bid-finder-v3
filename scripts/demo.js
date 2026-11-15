#!/usr/bin/env node
// Runs Bid Finder against made-up sample data, so you can look round without
// fetching anything. Uses its own folder (./data-demo) and never touches
// your real database. Sign in as demo@example.com / demo-password-123.
//
//   npm run demo -- --port 3005
import path from 'node:path';
import { parseArgs } from 'node:util';

process.env.DATA_DIR = path.resolve(import.meta.dirname, '..', 'data-demo');
const { values } = parseArgs({ options: { port: { type: 'string', short: 'p' } } });

const { getDb } = await import('../src/db/index.js');
const { ensureSources, saveOpportunities } = await import('../src/ingest/run.js');
const { setState } = await import('../src/match/feed.js');
const bcrypt = (await import('bcryptjs')).default;

const db = getDb();
ensureSources(db);
const day = (n) => new Date(Date.now() + n * 864e5).toISOString();
const T = (title, funder, value, closes, cpv, summary, extra = {}) => ({
  external_id: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), title, funder, award_max: value, closes_at: day(closes), cpv_codes: cpv,
  summary, url: 'https://example.com/notice', country: 'GB', currency: 'GBP', published_at: day(-2), eligibility: cpv.split(' ').map((c) => `CPV ${c}`).join('; '), ...extra,
});

const data = {
  'find-a-tender': [
    T('Design and build of hydraulic test rig for rail bogie components', 'Network Rail Infrastructure Ltd', 1850000, 23, '71333000 42000000', 'Design, manufacture, installation and commissioning of a servo-hydraulic fatigue test rig including control system, instrumentation and data acquisition.', { location: 'East Midlands', notice_type: 'tender' }),
    T('Framework for mechanical and electrical engineering consultancy services', 'United Utilities Water Limited', 12000000, 41, '71334000 71321000', 'Multi-supplier framework for M&E design, feasibility studies and technical assurance across water treatment assets.', { location: 'North West', notice_type: 'tender' }),
    T('SCADA and PLC control system upgrade, pumping stations', 'Severn Trent Water', 640000, 5, '71700000 31000000 48000000', 'Replacement of legacy PLCs and SCADA at twelve pumping stations, including panel design, software, FAT and site commissioning.', { location: 'West Midlands', notice_type: 'tender' }),
    T('Supply of precision machined components for nuclear decommissioning tooling', 'Sellafield Ltd', 2300000, 30, '42000000 44000000', 'Manufacture of bespoke remote handling tooling and precision machined parts to nuclear quality standards.', { location: 'North West', notice_type: 'tender' }),
    T('Grounds maintenance and grass cutting services', 'Derbyshire County Council', 900000, 18, '77310000', 'Grounds maintenance for schools and corporate sites.', { location: 'East Midlands' }),
    T('Structural inspection and assessment of highway bridges', 'Transport for Greater Manchester', 475000, 12, '71312000 71631000', 'Principal inspections, structural assessment and load rating of forty highway structures.', { location: 'North West' }),
  ],
  'contracts-finder': [
    T('Prototype battery thermal management system: design and test', 'Advanced Propulsion Centre UK', 240000, 16, '73100000 71333000', 'Feasibility, detailed design and rig testing of a liquid-cooled thermal management system for a heavy-duty battery pack.', { location: 'West Midlands', eligibility: 'Suitable for SMEs; CPV 73100000; CPV 71333000' }),
    T('Calibration and maintenance of laboratory test equipment', 'National Physical Laboratory', 85000, 9, '50410000 71632000', 'Three-year contract for calibration, repair and maintenance of mechanical test equipment.', { location: 'London', eligibility: 'Suitable for SMEs; CPV 50410000' }),
    T('Design and build of hydraulic test rig for rail bogie components', 'Network Rail Infrastructure Ltd', 1850000, 23, '71333000', 'Design, manufacture, installation and commissioning of a servo-hydraulic fatigue test rig.', { location: 'East Midlands' }),
    T('Catering services for council offices', 'Leeds City Council', 300000, 25, '55500000', 'Provision of staff catering.', { location: 'Yorkshire' }),
    T('Digital twin of water network: simulation and modelling support', 'Anglian Water Services', 520000, 34, '72000000 71320000', 'Systems engineering, simulation and modelling support for a network digital twin.', { location: 'East of England' }),
  ],
  'public-contracts-scotland': [
    T('Offshore wind turbine blade inspection robotics: development contract', 'Offshore Renewable Energy Catapult', 780000, 27, '73300000 42000000', 'Development and demonstration of a robotic inspection system for blade leading-edge erosion.', { location: 'Scotland' }),
    T('Mechanical design services for tidal energy test facility', 'European Marine Energy Centre', 310000, 6, '71333000 71320000', 'Mechanical and structural design of subsea test berth equipment.', { location: 'Scotland' }),
  ],
  sell2wales: [
    T('Automation of composite layup cell: controls and robotics integration', 'AMRC Cymru', 410000, 20, '42000000 71700000', 'Robotics integration, PLC programming and safety systems for an automated composite layup cell.', { location: 'Wales' }),
  ],
  'innovate-uk': [
    { ...T('Net zero manufacturing: collaborative R&D competition', 'Innovate UK', 2000000, 45, '', 'UK registered businesses can apply for a share of up to £15 million for projects that decarbonise manufacturing processes.', { location: 'UK', eligibility: 'UK registered businesses, SME' }), award_min: 250000, award_text: '£250,000 to £2 million' },
    { ...T('Defence innovation: uncrewed systems test and evaluation', 'Innovate UK', 500000, 13, '', 'Funding for novel test and evaluation methods for uncrewed air and maritime systems.', { location: 'UK', eligibility: 'UK registered businesses, SME' }), award_text: 'Up to £500,000' },
  ],
};
if (db.prepare('SELECT COUNT(*) AS n FROM opportunities').get().n === 0) {
  for (const [key, items] of Object.entries(data)) {
    const type = db.prepare('SELECT type FROM sources WHERE key = ?').get(key).type;
    saveOpportunities(db, { key, type }, items);
    db.prepare(`UPDATE sources SET last_run_at = datetime('now'), last_status = 'ok', last_found = ?, last_new = ?, next_run_at = ? WHERE key = ?`).run(items.length, items.length, day(365), key);
    db.prepare(`INSERT INTO source_runs (source_key, status, found, added, duration_ms) VALUES (?, 'ok', ?, ?, ?)`).run(key, items.length, items.length, 900 + items.length * 310);
  }
  const user = db.prepare('INSERT INTO users (email, name, password_hash, is_platform_admin) VALUES (?, ?, ?, 1)').run('demo@example.com', 'Demo User', await bcrypt.hash('demo-password-123', 10)).lastInsertRowid;
  const org = db.prepare(`INSERT INTO orgs (name) VALUES ('Northfield Engineering')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO memberships (user_id, org_id, role) VALUES (?, ?, 'owner')`).run(user, org);
  db.prepare(`INSERT INTO profiles (org_id, keywords, exclude_keywords, cpv_codes, countries, types, min_award, max_award, min_score, digest_emails) VALUES (?, ?, ?, ?, 'GB', 'grant\ntender', 50000, 5000000, 30, 'demo@example.com')`)
    .run(org, ['test rig', 'control system', 'mechanical design', 'PLC', 'SCADA', 'robotics', 'prototype', 'simulation'].join('\n'), 'catering\ngrounds maintenance', '713\n42\n717\n73');
  const id = (t) => db.prepare('SELECT id FROM opportunities WHERE title LIKE ? ORDER BY id LIMIT 1').get(`${t}%`).id;
  setState(db, org, id('Design and build of hydraulic'), { starred: 1, stage: 'bidding', note: 'Strong fit. Partner with Hydratech for the power pack.' });
  setState(db, org, id('SCADA and PLC'), { starred: 1, stage: 'qualifying' });
  setState(db, org, id('Prototype battery'), { stage: 'submitted' });
  setState(db, org, id('Mechanical design services'), { stage: 'won' });
  db.prepare(`INSERT INTO saved_searches (org_id, name, filters, frequency, emails, created_by) VALUES (?, 'Control systems over £100k', ?, 'instant', 'demo@example.com', ?)`).run(org, JSON.stringify({ q: 'control', min_value: 100000, type: 'tender' }), user);
  db.prepare(`INSERT INTO saved_searches (org_id, name, filters, frequency, emails, created_by) VALUES (?, 'Engineering services (CPV 713)', ?, 'daily', 'demo@example.com', ?)`).run(org, JSON.stringify({ cpv: '713' }), user);
  console.log('Sample data created.');
}
console.log('Sign in as demo@example.com with the password demo-password-123');
const { serve } = await import('../src/server.js');
await serve({ port: values.port ? Number(values.port) : undefined, scheduler: false });
