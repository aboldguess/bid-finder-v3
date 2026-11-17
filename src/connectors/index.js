// The connector registry. Built-in connectors are code; custom ones (RSS
// feeds and web portals) are built from rows an administrator adds.
//
// A connector is { key, name, type, fetch(ctx) -> opportunities } plus
// optional politeness and scheduling hints. See docs/CONNECTORS.md.
import findATender from './findATender.js';
import contractsFinder from './contractsFinder.js';
import { publicContractsScotland, sell2Wales } from './proactis.js';
import ted from './ted.js';
import samGov from './samGov.js';
import findAGrant from './findAGrant.js';
import innovateUk from './innovateUk.js';
import ukri from './ukri.js';
import grantsGov, { grantsGovConnector } from './grantsGov.js';
import { euFunding, euTenders } from './euFunding.js';
import boamp from './boamp.js';
import tenderNed from './tenderNed.js';
import serviceBund from './serviceBund.js';
import placsp from './placsp.js';
import canadaBuys from './canadaBuys.js';
import getsNz from './getsNz.js';
import gebiz from './gebiz.js';
import etendersZa from './etendersZa.js';
import worldBank from './worldBank.js';
import { watchConnector } from './watch.js';
import { rssConnector } from './rss.js';
import { portalConnector } from './portal.js';

// The UK grant sites have no API, so we read their public listing pages,
// slowly, and only where robots.txt allows.
const html = (c) => ({ access: 'Public listing pages', respectRobots: true, minDelayMs: 2000, intervalMinutes: 720, ...c });

// Innovate UK's robots.txt redirects to a sign-in service on another host,
// which fails. That is not the site stating a crawling policy, so for this
// source only, such a failure is read as "no robots.txt". See docs/CONNECTORS.md.
const innovate = html({ ...innovateUk, robotsOffsiteError: 'allow' });

// Bodies people ask to follow by name, across the portals they publish on.
const DOT_AGENCIES = 'DOT|DOT-FHWA|DOT-FTA|DOT-FAA|DOT-FRA|DOT-NHTSA|DOT-MARAD|DOT-PHMSA|DOT-FMCSA|DOT-OST|DOT-GLS';
const watches = [
  watchConnector({
    key: 'watch-network-rail',
    name: 'Watch: Network Rail',
    homepage: 'https://www.networkrail.co.uk/industry-and-commercial/supply-chain/',
    parts: [{ connector: findATender }, { connector: contractsFinder }],
    match: /network rail/i,
  }),
  watchConnector({
    key: 'watch-nasa',
    name: 'Watch: NASA',
    homepage: 'https://www.nasa.gov/oscm/',
    parts: [
      { connector: grantsGovConnector({ key: 'grants-gov' }), config: { agencies: 'NASA' }, filter: null },
      { connector: samGov, config: { keyword: '"NATIONAL AERONAUTICS AND SPACE ADMINISTRATION"' }, filter: /aeronautics and space/i },
    ],
  }),
  watchConnector({
    key: 'watch-us-dot',
    name: 'Watch: US Department of Transportation',
    homepage: 'https://www.transportation.gov/grants',
    parts: [
      { connector: grantsGovConnector({ key: 'grants-gov' }), config: { agencies: DOT_AGENCIES }, filter: null },
      { connector: samGov, config: { keyword: '"TRANSPORTATION, DEPARTMENT OF"' }, filter: /transportation, department of/i },
    ],
  }),
];

export const connectors = [
  // United Kingdom
  findATender, contractsFinder, publicContractsScotland, sell2Wales, html(findAGrant), innovate, html(ukri),
  // European Union, centrally and by country
  ted, euFunding, euTenders, boamp, serviceBund, tenderNed, placsp,
  // North America
  samGov, grantsGov, canadaBuys,
  // Asia-Pacific and the Commonwealth
  getsNz, gebiz, etendersZa,
  // Multilateral
  worldBank,
  // Named bodies
  ...watches,
];

export const connectorByKey = (key) => connectors.find((c) => c.key === key);

export const CUSTOM_KINDS = { rss: rssConnector, portal: portalConnector };

export function connectorForSource(source) {
  if (source.kind === 'builtin') return connectorByKey(source.key);
  const build = CUSTOM_KINDS[source.kind];
  let config = {};
  try { config = JSON.parse(source.config || '{}'); } catch { /* treat as empty */ }
  return build ? build({ ...source, config }) : null;
}
