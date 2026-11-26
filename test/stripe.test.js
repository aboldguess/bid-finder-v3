// Stripe Checkout, plan changes and webhooks, against a fake Stripe.
import './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { config } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { entitlement } from '../src/billing/plans.js';
import { formEncode, signForTest, verifyWebhook } from '../src/billing/stripe.js';
import { createApp } from '../src/web/app.js';

const token = (html) => html.match(/name="_csrf" value="([^"]+)"/)[1];
const SECRET = 'whsec_test';

function fakeStripe() {
  const calls = [];
  const subs = {}; // what Stripe currently holds for each subscription
  const rec = (name, result) => async (...args) => { calls.push([name, ...args]); return typeof result === 'function' ? result(...args) : result; };
  return {
    calls,
    subs,
    configured: true,
    createCustomer: rec('customer', { id: 'cus_1' }),
    createProduct: rec('product', { id: 'prod_1' }),
    createCheckout: rec('checkout', { id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' }),
    createPortal: rec('portal', { url: 'https://billing.stripe.test/p' }),
    getSubscription: rec('getSub', (id) => ({ id, customer: 'cus_1', items: { data: [{ id: 'si_1' }] }, ...subs[id] })),
    updateSubscription: rec('updateSub', { id: 'sub_1' }),
    cancelSubscription: rec('cancelSub', (id) => ({ id, status: 'canceled' })),
    openCheckouts: rec('openCheckouts', () => Object.values(subs).filter((s) => s.openCheckout).map((s) => ({ id: s.openCheckout }))),
    expireCheckout: rec('expireCheckout', (id) => ({ id, status: 'expired' })),
  };
}

const hosted = (name, fn) => test(name, async () => {
  config.hosted = true;
  const before = { ...config.stripe };
  config.stripe.webhookSecret = SECRET;
  try { await fn(); } finally { config.hosted = false; Object.assign(config.stripe, before); }
});

async function setup() {
  const db = openDb(':memory:');
  const stripe = fakeStripe();
  const app = createApp(db, { mail: async () => {}, stripe });
  const signUp = async (email, orgName) => {
    const agent = request.agent(app);
    const page = await agent.get('/register');
    await agent.post('/register').type('form').send({ _csrf: token(page.text), name: 'Pat', email, password: 'correct horse battery', orgName, terms: '1' });
    return agent;
  };
  await signUp('ops@operator.example', 'Operator');
  const pat = await signUp('pat@acme.example', 'Acme');
  const org = () => db.prepare(`SELECT * FROM orgs WHERE name = 'Acme'`).get();
  const webhook = (event) => {
    const body = JSON.stringify(event);
    return request(app).post('/stripe/webhook').set('Content-Type', 'application/json').set('Stripe-Signature', signForTest(body, SECRET)).send(body);
  };
  return { db, app, stripe, pat, org, webhook };
}

hosted('choosing a plan opens Stripe Checkout with our own price, keeping the rest of the trial', async () => {
  const { stripe, pat, org } = await setup();
  const page = await pat.get('/billing');
  assert.match(page.text, /14 days left/);
  const res = await pat.post('/billing/checkout').type('form').send({ _csrf: token(page.text), plan: 'team', period: 'annual' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, 'https://checkout.stripe.test/cs_1');
  assert.equal(org().stripe_customer_id, 'cus_1', 'the Stripe customer is remembered');
  const [, session] = stripe.calls.find((c) => c[0] === 'checkout');
  assert.equal(session.mode, 'subscription');
  assert.equal(session.client_reference_id, org().id);
  assert.deepEqual(session.line_items[0].price_data.recurring, { interval: 'year' });
  assert.equal(session.line_items[0].price_data.unit_amount, 79000);
  assert.equal(session.line_items[0].price_data.currency, 'gbp');
  assert.ok(Math.abs(session.subscription_data.trial_end - Date.parse(org().trial_ends_at) / 1000) < 2, 'the first charge waits for the trial to end');
  assert.equal(session.automatic_tax, undefined, 'Stripe Tax only when turned on');
});

hosted('a sale price is what the customer is charged', async () => {
  const { db, stripe, pat } = await setup();
  db.prepare(`UPDATE plans SET sale_monthly_pence = 4900, sale_label = 'Black Friday' WHERE key = 'team'`).run();
  const page = await pat.get('/billing');
  await pat.post('/billing/checkout').type('form').send({ _csrf: token(page.text), plan: 'team', period: 'monthly' });
  assert.equal(stripe.calls.find((c) => c[0] === 'checkout')[1].line_items[0].price_data.unit_amount, 4900);
});

hosted('webhooks: paying activates the plan, a failed payment marks it past due, cancelling makes it read-only', async () => {
  const { db, stripe, pat, org, webhook } = await setup();
  const page = await pat.get('/billing');
  await pat.post('/billing/checkout').type('form').send({ _csrf: token(page.text), plan: 'pro', period: 'monthly' });
  const orgId = org().id;

  const completed = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: String(orgId), customer: 'cus_1', subscription: 'sub_1', metadata: { plan_key: 'pro', period: 'monthly' } } } };
  assert.equal((await webhook(completed)).status, 200);
  assert.deepEqual([org().billing_status, org().plan_key, org().stripe_subscription_id], ['active', 'pro', 'sub_1']);
  assert.equal(entitlement(db, org()).limits.private_sources, 3);
  assert.equal((await webhook(completed)).body.result, 'duplicate', 'the same event twice is handled once');

  stripe.subs.sub_1 = { status: 'past_due', metadata: { plan_key: 'pro' } };
  await webhook({ id: 'evt_2', type: 'customer.subscription.updated', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'past_due', metadata: { plan_key: 'pro' } } } });
  assert.equal(org().billing_status, 'past_due');
  assert.equal(entitlement(db, org()).readOnly, false, 'still works while the card is retried');

  // An old subscription ending must not affect the current one.
  await webhook({ id: 'evt_3', type: 'customer.subscription.deleted', data: { object: { id: 'sub_old', customer: 'cus_1', status: 'canceled' } } });
  assert.equal(org().billing_status, 'past_due');

  await webhook({ id: 'evt_4', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'canceled' } } });
  assert.equal(org().billing_status, 'lapsed');
  assert.equal(entitlement(db, org()).readOnly, true);
  assert.match((await pat.get('/billing')).text, /subscription has ended/);

  // Stripe can deliver an older "active" snapshot after the cancellation. What Stripe holds now wins.
  stripe.subs.sub_1 = { status: 'canceled' };
  await webhook({ id: 'evt_5', type: 'customer.subscription.updated', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active' } } });
  assert.equal(org().billing_status, 'lapsed', 'a stale update cannot bring a cancelled account back');
});

hosted('webhooks: a subscription Stripe has stopped collecting on (unpaid) becomes read-only', async () => {
  const { db, stripe, org, webhook } = await setup();
  db.prepare(`UPDATE orgs SET stripe_customer_id = 'cus_1', stripe_subscription_id = 'sub_1', billing_status = 'past_due', plan_key = 'team' WHERE name = 'Acme'`).run();
  stripe.subs.sub_1 = { status: 'unpaid' };
  await webhook({ id: 'evt_u', type: 'customer.subscription.updated', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'unpaid' } } });
  assert.equal(org().billing_status, 'lapsed');
  assert.equal(entitlement(db, org()).readOnly, true);
});

hosted('two checkouts for one organisation never leave it paying twice', async () => {
  const { stripe, pat, org, webhook } = await setup();
  const page = await pat.get('/billing');
  await pat.post('/billing/checkout').type('form').send({ _csrf: token(page.text), plan: 'team', period: 'monthly' });
  // A second tab: the first, still-open checkout is expired before a new one starts.
  stripe.subs.pending = { openCheckout: 'cs_1' };
  await pat.post('/billing/checkout').type('form').send({ _csrf: token(page.text), plan: 'team', period: 'monthly' });
  assert.deepEqual(stripe.calls.filter((c) => c[0] === 'expireCheckout').map((c) => c[1]), ['cs_1']);

  // Should both still complete (one finished just before it was expired), the second subscription is cancelled at once.
  const done = (id, sub) => webhook({ id, type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: String(org().id), customer: 'cus_1', subscription: sub, metadata: { plan_key: 'team', period: 'monthly' } } } });
  await done('evt_a', 'sub_a');
  await done('evt_b', 'sub_b');
  assert.equal(org().stripe_subscription_id, 'sub_a');
  assert.deepEqual(stripe.calls.filter((c) => c[0] === 'cancelSub').map((c) => c[1]), ['sub_b']);
});

hosted('webhooks: a bad or missing signature is refused and changes nothing', async () => {
  const { app, org } = await setup();
  const body = JSON.stringify({ id: 'evt_x', type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: String(org().id), customer: 'cus_evil', subscription: 'sub_evil' } } });
  const forged = await request(app).post('/stripe/webhook').set('Content-Type', 'application/json').set('Stripe-Signature', signForTest(body, 'wrong-secret')).send(body);
  assert.equal(forged.status, 400);
  assert.equal((await request(app).post('/stripe/webhook').set('Content-Type', 'application/json').send(body)).status, 400);
  assert.equal(org().billing_status, 'trialing');
  assert.throws(() => verifyWebhook(body, signForTest(body, SECRET, Math.floor(Date.now() / 1000) - 3600), SECRET), /too old/);
});

hosted('webhooks: a checkout can never move another organisation\'s Stripe customer', async () => {
  const { db, org, webhook } = await setup();
  db.prepare(`UPDATE orgs SET stripe_customer_id = 'cus_acme' WHERE id = ?`).run(org().id);
  await webhook({ id: 'evt_5', type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: String(org().id), customer: 'cus_someone_else', subscription: 'sub_9' } } });
  assert.equal(org().billing_status, 'trialing');
  assert.equal(org().stripe_customer_id, 'cus_acme');
});

hosted('switching plan updates the existing subscription instead of starting a second one', async () => {
  const { db, stripe, pat, org } = await setup();
  db.prepare(`UPDATE orgs SET billing_status = 'active', plan_key = 'starter', stripe_customer_id = 'cus_1', stripe_subscription_id = 'sub_1' WHERE id = ?`).run(org().id);
  const page = await pat.get('/billing');
  const res = await pat.post('/billing/checkout').type('form').send({ _csrf: token(page.text), plan: 'team', period: 'monthly' });
  assert.equal(res.headers.location, '/billing');
  assert.ok(!stripe.calls.some((c) => c[0] === 'checkout'));
  const [, id, params] = stripe.calls.find((c) => c[0] === 'updateSub');
  assert.equal(id, 'sub_1');
  assert.equal(params.items[0].id, 'si_1');
  assert.equal(params.items[0].price_data.unit_amount, 7900);
  assert.equal(params.items[0].price_data.product, 'prod_1');
  assert.equal(org().plan_key, 'team');

  const portal = await pat.post('/billing/portal').type('form').send({ _csrf: token(page.text) });
  assert.equal(portal.headers.location, 'https://billing.stripe.test/p');
});

hosted('only the owner can pay, and a complimentary account has nothing to pay', async () => {
  const { db, app, pat, org } = await setup();
  db.prepare(`UPDATE orgs SET billing_status = 'comped' WHERE id = ?`).run(org().id);
  const page = await pat.get('/billing');
  assert.match(page.text, /Complimentary account/);
  const res = await pat.post('/billing/checkout').type('form').send({ _csrf: token(page.text), plan: 'team', period: 'monthly' });
  assert.equal(res.headers.location, '/billing');
  assert.equal((await request(app).post('/billing/checkout')).status, 403, 'no session, no CSRF token');
});

test('formEncode writes Stripe\'s nested form fields', () => {
  assert.equal(decodeURIComponent(formEncode({ a: { b: 1 }, c: [{ d: 'x' }], e: undefined }).toString()), 'a[b]=1&c[0][d]=x');
});

hosted('the security policy lets plan buttons redirect to Stripe Checkout and the Customer Portal', async () => {
  const { pat } = await setup();
  const csp = (await pat.get('/billing')).headers['content-security-policy'];
  assert.match(csp, /form-action 'self' https:\/\/checkout\.stripe\.com https:\/\/billing\.stripe\.com/);
});
