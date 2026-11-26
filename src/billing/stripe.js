// Stripe Checkout, the Customer Portal and webhooks, over Stripe's REST API
// (no SDK). Prices come from our own plans table and are sent inline with
// each checkout, so nothing has to be set up in Stripe's product catalogue.
import crypto from 'node:crypto';
import { config } from '../config.js';
import { log } from '../log.js';

// Stripe takes nested form fields: { a: { b: 1 }, c: [x] } -> a[b]=1&c[0]=x
export function formEncode(params, prefix = '', out = new URLSearchParams()) {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object') formEncode(value, name, out);
    else out.append(name, String(value));
  }
  return out;
}

export function createStripe({ secretKey = config.stripe.secretKey, fetchImpl = fetch } = {}) {
  async function call(method, path, params = {}) {
    const res = await fetchImpl(`https://api.stripe.com/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Stripe-Version': '2024-06-20' },
      body: method === 'GET' ? undefined : formEncode(params).toString(),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`Stripe: ${body.error?.message || `HTTP ${res.status}`}`);
    return body;
  }
  return {
    configured: Boolean(secretKey),
    createCustomer: (params) => call('POST', '/customers', params),
    createProduct: (params) => call('POST', '/products', params),
    createCheckout: (params) => call('POST', '/checkout/sessions', params),
    createPortal: (params) => call('POST', '/billing_portal/sessions', params),
    getSubscription: (id) => call('GET', `/subscriptions/${encodeURIComponent(id)}`),
    updateSubscription: (id, params) => call('POST', `/subscriptions/${encodeURIComponent(id)}`, params),
  };
}

// Checks the Stripe-Signature header (HMAC-SHA256 of "timestamp.body") and
// returns the parsed event, or throws.
export function verifyWebhook(rawBody, header, secret = config.stripe.webhookSecret, { toleranceSeconds = 300, now = Date.now() } = {}) {
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
  const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.split('=')).filter(([k]) => k === 't').map(([k, v]) => [k, v]));
  const signatures = String(header || '').split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  const t = Number(parts.t);
  if (!t || !signatures.length) throw new Error('missing signature');
  if (Math.abs(now / 1000 - t) > toleranceSeconds) throw new Error('signature too old');
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const ok = signatures.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  if (!ok) throw new Error('signature does not match');
  return JSON.parse(rawBody);
}

export const signForTest = (rawBody, secret, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')}`;

// Stripe's subscription status, as ours.
export const statusFrom = (stripeStatus) => ({
  trialing: 'active', active: 'active', past_due: 'past_due', unpaid: 'past_due',
  canceled: 'lapsed', incomplete_expired: 'lapsed', paused: 'lapsed',
}[stripeStatus] || null);

// What a plan costs right now, as the line item Stripe should charge.
export function lineItem(plan, period) {
  const annual = period === 'annual';
  return {
    quantity: 1,
    price_data: {
      currency: 'gbp',
      unit_amount: annual ? plan.pay.annual : plan.pay.monthly,
      recurring: { interval: annual ? 'year' : 'month' },
      tax_behavior: 'exclusive',
      product_data: { name: `Bid Finder ${plan.name} (${annual ? 'annual' : 'monthly'})`, metadata: { plan_key: plan.key } },
    },
  };
}

// Applies one webhook event to the database. Returns what it did, for logs and tests.
export function applyEvent(db, event) {
  if (db.prepare('SELECT 1 FROM stripe_events WHERE id = ?').get(event.id)) return 'duplicate';
  const o = event.data?.object || {};
  let result = 'ignored';
  db.transaction(() => {
    if (event.type === 'checkout.session.completed' && o.mode === 'subscription') {
      const orgId = Number(o.client_reference_id || o.metadata?.org_id);
      const org = db.prepare('SELECT id, stripe_customer_id FROM orgs WHERE id = ?').get(orgId);
      // The customer was created by us for this organisation; never let a session move it to another.
      if (org && (!org.stripe_customer_id || org.stripe_customer_id === o.customer)) {
        db.prepare(`UPDATE orgs SET stripe_customer_id = ?, stripe_subscription_id = ?, plan_key = COALESCE(?, plan_key), billing_period = COALESCE(?, billing_period), billing_status = 'active' WHERE id = ?`)
          .run(o.customer, o.subscription, o.metadata?.plan_key || null, o.metadata?.period || null, org.id);
        result = `org ${org.id} active`;
      }
    } else if (event.type.startsWith('customer.subscription.')) {
      const org = db.prepare('SELECT id, stripe_subscription_id FROM orgs WHERE stripe_customer_id = ?').get(o.customer);
      // Only the organisation's current subscription counts; an old one ending must not lapse a newer one.
      if (org && (!org.stripe_subscription_id || org.stripe_subscription_id === o.id)) {
        const status = event.type === 'customer.subscription.deleted' ? 'lapsed' : statusFrom(o.status);
        if (status) {
          db.prepare('UPDATE orgs SET billing_status = ?, stripe_subscription_id = ?, plan_key = COALESCE(?, plan_key), billing_period = COALESCE(?, billing_period) WHERE id = ?')
            .run(status, o.id, o.metadata?.plan_key || null, o.metadata?.period || null, org.id);
          result = `org ${org.id} ${status}`;
        }
      }
    } else if (event.type === 'invoice.payment_failed') {
      const org = db.prepare('SELECT id FROM orgs WHERE stripe_customer_id = ?').get(o.customer);
      if (org) { db.prepare(`UPDATE orgs SET billing_status = 'past_due' WHERE id = ? AND billing_status = 'active'`).run(org.id); result = `org ${org.id} past_due`; }
    }
    db.prepare('INSERT INTO stripe_events (id, type) VALUES (?, ?)').run(event.id, event.type);
  })();
  log.info(`Stripe ${event.type}: ${result}`);
  return result;
}
