import findAGrant from './findAGrant.js';
import innovateUk from './innovateUk.js';
import ukri from './ukri.js';
import contractsFinder from './contractsFinder.js';

// Every connector exposes { key, name, type, fetch(opts) -> opportunities }.
export const connectors = [findAGrant, innovateUk, ukri, contractsFinder];

export const connectorByKey = (key) => connectors.find((c) => c.key === key);
