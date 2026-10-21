import './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAmounts, parseAwardRange, parseUkDate } from '../src/connectors/util.js';

test('parses money in the formats funders use', () => {
  assert.deepEqual(parseAmounts('From £1,500 to £30,500'), [1500, 30500]);
  assert.deepEqual(parseAmounts('£45 million'), [45e6]);
  assert.deepEqual(parseAmounts('up to £1.5m or £500k'), [1.5e6, 500e3]);
  assert.deepEqual(parseAmounts('no money here'), []);
});

test('reads award ranges, maxima and minima', () => {
  assert.deepEqual(parseAwardRange('From £1,500 to £2 million'), { min: 1500, max: 2e6 });
  assert.deepEqual(parseAwardRange('Up to £10,000'), { min: null, max: 10000 });
  assert.deepEqual(parseAwardRange('£1,000,000', 'minimum'), { min: 1e6, max: null });
  assert.deepEqual(parseAwardRange('To be confirmed'), { min: null, max: null });
});

test('reads UK dates as London time', () => {
  // 31 March 2030 is BST, so 11:59pm local is 22:59 UTC.
  assert.equal(parseUkDate('31 March 2030, 11:59pm (Midnight)'), '2030-03-31T22:59:00.000Z');
  // December is GMT.
  assert.equal(parseUkDate('8 December 2026 11:00am'), '2026-12-08T11:00:00.000Z');
  assert.equal(parseUkDate('14 January 2027 4:00pm UK time'), '2027-01-14T16:00:00.000Z');
  // A bare deadline date means the end of that day.
  assert.equal(parseUkDate('2 December 2026'), '2026-12-02T23:59:00.000Z');
  assert.equal(parseUkDate('21 October 2026', { endOfDay: false }), '2026-10-20T23:00:00.000Z');
  assert.equal(parseUkDate('To be confirmed'), null);
  assert.equal(parseUkDate('1 Dec 2015, 12:01am'), '2015-12-01T00:01:00.000Z');
});
