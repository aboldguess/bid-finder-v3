// Plans, trials and what each organisation may do. Only enforced in hosted
// mode: a self-hosted install has no limits.
//
// An organisation's billing_status is one of:
//   trialing  free trial until trial_ends_at, with the trial plan's limits
//   active    paying for plan_key
//   past_due  a payment failed; keeps working while the card is retried
//   lapsed    trial ended or subscription cancelled: read-only
//   comped    free of charge: plan_key's limits, or none if it has no plan
import { config } from '../config.js';

export const STATUSES = ['trialing', 'active', 'past_due', 'lapsed', 'comped'];
export const UNLIMITED = { seats: null, saved_searches: null, instant_alerts: 1, private_sources: null };

export const getSetting = (db, key, fallback = '') => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
export const setSetting = (db, key, value) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value ?? ''));

const live = (endsAt, now) => !endsAt || Date.parse(endsAt) > now;

// A plan with the prices a customer pays right now (sale prices while a sale runs).
export function withPrices(plan, now = Date.now()) {
  if (!plan) return null;
  const onSale = live(plan.sale_ends_at, now) && (plan.sale_monthly_pence != null || plan.sale_annual_pence != null);
  return {
    ...plan,
    onSale,
    pay: {
      monthly: onSale && plan.sale_monthly_pence != null ? plan.sale_monthly_pence : plan.monthly_pence,
      annual: onSale && plan.sale_annual_pence != null ? plan.sale_annual_pence : plan.annual_pence,
    },
    features: String(plan.features || '').split('\n').map((f) => f.trim()).filter(Boolean),
  };
}

export const getPlan = (db, key, now) => withPrices(db.prepare('SELECT * FROM plans WHERE key = ?').get(key), now);
export const listPlans = (db, { publicOnly = false, now } = {}) =>
  db.prepare(`SELECT * FROM plans ${publicOnly ? 'WHERE public = 1' : ''} ORDER BY sort, monthly_pence`).all().map((p) => withPrices(p, now));

// The site-wide promotion banner, if one is running.
export function banner(db, now = Date.now()) {
  const text = getSetting(db, 'banner_text');
  if (!text || !live(getSetting(db, 'banner_ends_at') || null, now)) return null;
  return { text, colour: getSetting(db, 'banner_colour', '#c62828') };
}

export function startTrial(db, orgId, now = Date.now()) {
  const days = Math.max(0, Number(getSetting(db, 'trial_days', '14')) || 0);
  db.prepare(`UPDATE orgs SET billing_status = 'trialing', trial_ends_at = ? WHERE id = ?`).run(new Date(now + days * 864e5).toISOString(), orgId);
}

// What an organisation may do right now.
export function entitlement(db, org, now = Date.now()) {
  if (!config.hosted || !org) return { limits: UNLIMITED, readOnly: false, status: 'self-hosted', plan: null };
  const status = org.billing_status || 'trialing';
  if (status === 'comped') return { status, readOnly: false, plan: getPlan(db, org.plan_key, now), limits: org.plan_key ? limitsOf(getPlan(db, org.plan_key, now)) : UNLIMITED };
  if (status === 'trialing') {
    const ends = Date.parse(org.trial_ends_at || '') || 0;
    const plan = getPlan(db, getSetting(db, 'trial_plan', 'team'), now);
    if (ends > now) return { status, readOnly: false, plan, limits: limitsOf(plan), trialDaysLeft: Math.ceil((ends - now) / 864e5) };
    return { status: 'lapsed', readOnly: true, reason: 'trial-ended', plan: null, limits: limitsOf(plan) };
  }
  if (status === 'active' || status === 'past_due') {
    const plan = getPlan(db, org.plan_key, now);
    return { status, readOnly: false, plan, limits: plan ? limitsOf(plan) : UNLIMITED };
  }
  return { status: 'lapsed', readOnly: true, reason: 'cancelled', plan: null, limits: UNLIMITED };
}

const limitsOf = (plan) => (plan
  ? { seats: plan.seats, saved_searches: plan.saved_searches, instant_alerts: plan.instant_alerts, private_sources: plan.private_sources }
  : UNLIMITED);

// null when within the limit, otherwise a message for the person.
export function overLimit(limit, used, what) {
  if (limit == null || used < limit) return null;
  return `Your plan includes ${limit} ${what}. Upgrade on the Billing page for more.`;
}

export const pounds = (pence) => `£${(pence / 100).toLocaleString('en-GB', { minimumFractionDigits: pence % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
