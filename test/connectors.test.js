import { fixture } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import findAGrant, { parsePage as parseFindAGrant } from '../src/connectors/findAGrant.js';
import { parsePage as parseInnovate } from '../src/connectors/innovateUk.js';
import ukri, { parsePage as parseUkri } from '../src/connectors/ukri.js';
import { parsePage as parseCf } from '../src/connectors/contractsFinder.js';

test('Find a Grant: rendered HTML listing', () => {
  const items = parseFindAGrant(fixture('find-a-grant.html'));
  assert.equal(items.length, 2);
  const [g] = items;
  assert.equal(g.external_id, 'smart-manufacturing-accelerator-1');
  assert.equal(g.title, 'Smart Manufacturing Accelerator');
  assert.equal(g.url, 'https://www.find-government-grants.service.gov.uk/grants/smart-manufacturing-accelerator-1');
  assert.equal(g.funder, 'Department for Business and Trade');
  assert.equal(g.location, 'England, South East England');
  assert.equal(g.eligibility, 'Private Sector, Non-profit');
  assert.equal(g.award_min, 25000);
  assert.equal(g.award_max, 1.5e6);
  assert.equal(g.total_fund, 45e6);
  assert.equal(g.closes_at, '2030-03-31T22:59:00.000Z');
  assert.match(g.summary, /digital and AI/);
  assert.equal(items[1].award_max, 10000);
});

test('Find a Grant: Next.js data payload', () => {
  const [g] = parseFindAGrant(fixture('find-a-grant-next.html'));
  assert.equal(g.external_id, 'clean-maritime-demo-1');
  assert.equal(g.title, 'Clean Maritime Demonstration');
  assert.equal(g.location, 'National');
  assert.equal(g.award_max, 3e6);
  assert.equal(g.closes_at, '2026-12-01T23:59:00.000Z');
});

test('Find a Grant: stops paging when a page adds nothing new', async () => {
  const pages = [];
  const items = await findAGrant.fetch({ delayMs: 0, get: async (url) => { pages.push(url); return fixture('find-a-grant.html'); } });
  assert.equal(items.length, 2);
  assert.equal(pages.length, 2);
  assert.match(pages[1], /page=2&skip=10&limit=10/);
});

test('Innovate UK: competition listing', () => {
  const items = parseInnovate(fixture('innovate-uk.html'));
  assert.equal(items.length, 2);
  const [c] = items;
  assert.equal(c.external_id, '2599');
  assert.equal(c.title, 'BridgeAI Deployment Catalyst: AI for Operational Systems');
  assert.equal(c.funder, 'Innovate UK');
  assert.equal(c.closes_at, '2026-12-08T11:00:00.000Z');
  assert.equal(c.award_max, 5e6);
  assert.match(c.eligibility, /AI SME/);
  assert.equal(c.status, 'Open now');
  assert.equal(items[1].closes_at, '2026-12-02T23:59:00.000Z');
});

test('UKRI: listing fields, closed items dropped by fetch', async () => {
  const items = parseUkri(fixture('ukri.html'));
  assert.equal(items.length, 3);
  const [o] = items;
  assert.equal(o.external_id, 'engineering-biology-hubs');
  assert.equal(o.funder, 'Biotechnology and Biological Sciences Research Council (BBSRC)');
  assert.equal(o.total_fund, 40e6);
  assert.equal(o.award_max, 10e6);
  assert.equal(o.closes_at, '2027-01-14T16:00:00.000Z');
  assert.equal(items[2].closes_at, null);
  assert.deepEqual([items[2].award_min, items[2].award_max], [250000, 1e6]);

  const fetched = await ukri.fetch({ delayMs: 0, maxPages: 3, get: async () => fixture('ukri.html') });
  assert.deepEqual(fetched.map((i) => i.external_id), ['engineering-biology-hubs', 'tbc-thing']);
});

test('Contracts Finder: OCDS releases', () => {
  const { items, next } = parseCf(fixture('contracts-finder.json'));
  assert.equal(next, null);
  const [t] = items;
  assert.equal(t.title, 'Drone survey services');
  assert.equal(t.funder, 'Hampshire County Council');
  assert.equal(t.url, 'https://www.contractsfinder.service.gov.uk/Notice/1a2b3c4d-1111-2222-3333-444455556666');
  assert.equal(t.location, 'South East');
  assert.equal(t.award_max, 250000);
  assert.match(t.eligibility, /Suitable for SMEs/);
});
