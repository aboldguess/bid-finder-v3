import './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreOpportunity } from '../src/match/score.js';

const now = Date.parse('2026-10-21T12:00:00Z');
const opp = (o = {}) => ({
  type: 'grant', title: 'AI for aerospace manufacturing', summary: 'Funding for composite materials research.',
  eligibility: 'Private Sector', funder: 'Innovate UK', location: 'England', award_min: 50000, award_max: 500000,
  closes_at: '2026-12-01T12:00:00Z', ...o,
});
const profile = (p = {}) => ({
  types: 'grant', keywords: 'aerospace\ncomposite', exclude_keywords: '', regions: 'South East England',
  applicant_types: 'Private Sector', min_award: 25000, max_award: 1e6, ...p,
});

test('a strong fit scores high and explains itself', () => {
  const r = scoreOpportunity(opp(), profile(), now);
  assert.equal(r.excluded, false);
  assert.ok(r.score >= 60, `score ${r.score}`);
  assert.ok(r.reasons.some((x) => x.includes('"aerospace"')));
  assert.ok(r.reasons.includes('Award size is in your range'));
  assert.ok(r.reasons.some((x) => x.startsWith('Open in your area')));
});

test('excluded keywords, closed items and unfollowed types are dropped', () => {
  assert.equal(scoreOpportunity(opp(), profile({ exclude_keywords: 'composite' }), now).excluded, true);
  assert.equal(scoreOpportunity(opp({ closes_at: '2026-01-01T00:00:00Z' }), profile(), now).excluded, true);
  assert.equal(scoreOpportunity(opp({ type: 'tender' }), profile(), now).excluded, true);
});

test('wrong region and award size pull the score down', () => {
  const good = scoreOpportunity(opp(), profile(), now).score;
  const elsewhere = scoreOpportunity(opp({ location: 'Scotland' }), profile(), now).score;
  const tooBig = scoreOpportunity(opp({ award_min: 5e6, award_max: 10e6 }), profile(), now).score;
  assert.ok(elsewhere < good);
  assert.ok(tooBig < good);
});

test('UK-wide schemes match every region; keyword matching respects word starts', () => {
  const r = scoreOpportunity(opp({ location: 'UK' }), profile(), now);
  assert.ok(!r.reasons.some((x) => x.startsWith('Location may not')));
  const r2 = scoreOpportunity(opp({ title: 'Paerospace', summary: '' }), profile({ keywords: 'aerospace' }), now);
  assert.ok(!r2.reasons.some((x) => x.includes('aerospace')));
});

test('deadlines inside a week are flagged', () => {
  const r = scoreOpportunity(opp({ closes_at: '2026-10-23T12:00:00Z' }), profile(), now);
  assert.ok(r.reasons.includes('Closes in 2 days'));
});
