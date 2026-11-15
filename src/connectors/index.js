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
import { rssConnector } from './rss.js';
import { portalConnector } from './portal.js';

// The three grant sites have no API, so we read their public listing pages,
// slowly, and only where robots.txt allows.
const html = (c) => ({ access: 'Public listing pages', respectRobots: true, minDelayMs: 2000, intervalMinutes: 720, ...c });

// Innovate UK is off by default: its robots.txt redirects to a sign-in service
// that fails, and the standard says to treat that as "disallow everything".
export const connectors = [findATender, contractsFinder, publicContractsScotland, sell2Wales, ted, samGov, html(findAGrant), html({ ...innovateUk, enabledByDefault: false }), html(ukri)];

export const connectorByKey = (key) => connectors.find((c) => c.key === key);

export const CUSTOM_KINDS = { rss: rssConnector, portal: portalConnector };

export function connectorForSource(source) {
  if (source.kind === 'builtin') return connectorByKey(source.key);
  const build = CUSTOM_KINDS[source.kind];
  let config = {};
  try { config = JSON.parse(source.config || '{}'); } catch { /* treat as empty */ }
  return build ? build({ ...source, config }) : null;
}
