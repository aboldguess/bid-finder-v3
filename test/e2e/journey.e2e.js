/* global document */
// Phase 1 acceptance: a real browser walks a customer through the hosted
// service from the home page to deleting their account. Stripe and email are
// replaced by stand-ins on this machine; everything else is the real app.
//
//   npm run test:e2e        (needs Playwright's Chromium: npx playwright install chromium)
import '../helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { config } from '../../src/config.js';
import { openDb } from '../../src/db/index.js';
import { saveOpportunities } from '../../src/ingest/run.js';
import { runAlerts } from '../../src/notify/alerts.js';
import { signForTest } from '../../src/billing/stripe.js';
import { createUser } from '../../src/users.js';
import { createApp } from '../../src/web/app.js';

const SECRET = 'whsec_e2e';
const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
});
const notice = (id, title, extra = {}) => ({ external_id: id, title, url: `https://notices.example/${id}`, closes_at: '2099-01-01T00:00:00Z', country: 'GB', ...extra });

// Stand-in for Stripe: Checkout is a page with a Pay button, which sends the
// signed webhook Stripe would and returns to the app.
async function fakeStripe(appBase) {
  const sessions = new Map();
  const calls = [];
  const ended = new Set();
  const { server, base } = await listen(async (req, res) => {
    const id = req.url.split('/').pop();
    const s = sessions.get(id);
    if (!s) return res.writeHead(404).end();
    if (req.method === 'GET') return res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>Checkout</title><h1>Pay for ${s.line_items[0].price_data.product_data.name}</h1><form method="post"><button>Pay</button></form>`);
    const body = JSON.stringify({ id: `evt_${id}`, type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: s.client_reference_id, customer: s.customer, subscription: `sub_${id}`, metadata: s.metadata } } });
    await fetch(`${appBase()}/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signForTest(body, SECRET) }, body });
    res.writeHead(303, { location: s.success_url }).end();
  });
  let n = 0;
  const stripe = {
    configured: true,
    calls,
    createCustomer: async () => { calls.push('customer'); return { id: `cus_${++n}` }; },
    createCheckout: async (params) => { const id = `cs_${++n}`; sessions.set(id, params); calls.push('checkout'); return { id, url: `${base}/pay/${id}` }; },
    createPortal: async () => ({ url: `${base}/portal` }),
    getSubscription: async (id) => ({ id, status: ended.has(id) ? 'canceled' : 'active' }),
    cancelSubscription: async (id) => { calls.push(`cancel ${id}`); ended.add(id); return { id, status: 'canceled' }; },
    openCheckouts: async () => [],
    expireCheckout: async (id) => ({ id, status: 'expired' }),
  };
  return { stripe, server, base };
}

test('Phase 1 acceptance: from the home page to a paying customer, and out again', { timeout: 120000 }, async (t) => {
  const saved = { hosted: config.hosted, baseUrl: config.baseUrl, secret: config.stripe.webhookSecret };
  config.hosted = true;
  config.stripe.webhookSecret = SECRET;
  const db = openDb(':memory:');
  const mail = [];
  let appBase = '';
  const fake = await fakeStripe(() => appBase);
  const realOrigins = config.stripe.origins;
  config.stripe.origins = [fake.base];
  const app = createApp(db, { mail: async (m) => mail.push(m), stripe: fake.stripe });
  // Clean-up is registered as each thing starts, so a browser that fails to launch
  // still closes the servers and the test run ends instead of hanging.
  t.after(() => {
    fake.server.close();
    Object.assign(config, { hosted: saved.hosted, baseUrl: saved.baseUrl });
    config.stripe.webhookSecret = saved.secret;
    config.stripe.origins = realOrigins;
  });
  const { server, base } = await listen(app);
  t.after(() => server.close());
  appBase = base;
  config.baseUrl = base;
  const browser = await chromium.launch();
  t.after(() => browser.close());

  // The operator's own account exists already; the public sources have notices.
  await createUser(db, { email: 'ops@operator.example', name: 'Ops', password: 'operator password 1', orgName: 'Operator', admin: true });
  saveOpportunities(db, { key: 'find-a-tender', type: 'tender' }, [
    notice('c1', 'Highways bridge inspection and drainage design', { cpv_codes: '71311000', award_max: 250000 }),
    notice('c2', 'Structural engineering framework for school buildings', { cpv_codes: '71312000' }),
    notice('x1', 'Hospital catering supplies', { cpv_codes: '15000000' }),
  ]);

  const errors = [];
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

  await t.test('a visitor finds the service and starts a trial', async () => {
    await page.goto(base);
    assert.match(await page.title(), /Find public contracts and grants/);
    assert.ok(await page.isVisible('text=Find a Tender (GOV.UK)'));
    await page.click('text=Start your free 14-day trial');
    await page.fill('input[name=name]', 'Pat Jones');
    await page.fill('input[name=email]', 'pat@civils.example');
    await page.fill('input[name=password]', 'correct horse battery');
    await page.fill('input[name=orgName]', 'Civils Ltd');
    await page.check('input[name=terms]');
    await page.click('form.stack button, form .button');
    await page.waitForURL('**/welcome');
  });

  await t.test('they confirm their email from the link we send', async () => {
    const verify = mail.find((m) => m.to.includes('pat@civils.example') && /Confirm your email/.test(m.subject));
    assert.ok(verify, 'a confirmation email was sent');
    const link = verify.html.match(/href="([^"]*\/verify\/[^"]+)"/)[1];
    await page.goto(link);
    assert.ok(!(await page.isVisible('text=Please confirm your email address')));
  });

  await t.test('three choices on the welcome page give them a ranked feed', async () => {
    await page.goto(`${base}/welcome`);
    await page.click('text=Civil and structural');
    await page.waitForFunction(() => document.querySelector('[data-preview-total]').textContent === '2');
    await page.click('text=Show my feed');
    await page.waitForURL('**/feed');
    assert.ok(await page.isVisible('text=Your feed is ready: 2 open opportunities match'));
    const titles = await page.locator('.card-title').allTextContents();
    assert.equal(titles.length, 2);
    assert.ok(!titles.some((x) => /catering/i.test(x)));
  });

  await t.test('a saved search alerts them to a new matching notice', async () => {
    await page.click('text=Save this search and get alerts');
    await page.fill('input[name=name]', 'Bridges');
    await page.fill('input[name=q]', 'bridge');
    await page.selectOption('select[name=frequency]', 'instant');
    await page.fill('textarea[name=emails]', 'pat@civils.example');
    await page.click('form.stack button.button >> nth=-1');
    await page.waitForURL(/\/searches\/\d+$/);
    saveOpportunities(db, { key: 'find-a-tender', type: 'tender' }, [notice('c3', 'Bridge replacement on the River Avon footpath', { cpv_codes: '45221000' })]);
    const sent = [];
    await runAlerts(db, { channels: { sendEmail: async (m) => sent.push(m) } });
    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /1 new match for "Bridges"/);
    assert.match(sent[0].html, /Bridge replacement on the River Avon/);
  });

  await t.test('they pay by card and become a paying customer', async () => {
    await page.goto(`${base}/billing`);
    assert.ok(await page.isVisible('text=Free trial:'));
    await page.click('.plan:has(h2:text-is("Team")) button.only-monthly');
    await page.waitForURL(/\/pay\//);
    await page.click('button:text-is("Pay")');
    await page.waitForURL(/\/billing\?done=1$/);
    const org = db.prepare(`SELECT * FROM orgs WHERE name = 'Civils Ltd'`).get();
    assert.equal(org.billing_status, 'active');
    assert.equal(org.plan_key, 'team');
    await page.reload();
    assert.ok(await page.isVisible('text=Team plan'));
  });

  await t.test('another customer never sees their private portal', async () => {
    const civils = db.prepare(`SELECT id FROM orgs WHERE name = 'Civils Ltd'`).get().id;
    db.prepare(`INSERT INTO sources (key, name, kind, type, org_id) VALUES ('custom-civils', 'Civils supplier portal', 'portal', 'tender', ?)`).run(civils);
    saveOpportunities(db, { key: 'custom-civils', type: 'tender' }, [notice('p1', 'Private bridge maintenance framework')]);
    await page.goto(`${base}/feed`);
    assert.ok(await page.isVisible('text=Private bridge maintenance framework'));

    const rival = await (await browser.newContext()).newPage();
    await rival.goto(`${base}/register`);
    await rival.fill('input[name=name]', 'Rae');
    await rival.fill('input[name=email]', 'rae@rival.example');
    await rival.fill('input[name=password]', 'another good password');
    await rival.fill('input[name=orgName]', 'Rival Ltd');
    await rival.check('input[name=terms]');
    await rival.click('form .button');
    await rival.waitForURL('**/welcome');
    await rival.click('text=Civil and structural');
    await rival.click('text=Show my feed');
    await rival.waitForURL('**/feed');
    assert.ok(!(await rival.content()).includes('Private bridge maintenance'));
    const privateId = db.prepare(`SELECT id FROM opportunities WHERE external_id = 'p1'`).get().id;
    assert.equal((await rival.goto(`${base}/o/${privateId}`)).status(), 404);
  });

  await t.test('when the subscription ends, the account turns read-only but keeps everything', async () => {
    const org = db.prepare(`SELECT * FROM orgs WHERE name = 'Civils Ltd'`).get();
    const body = JSON.stringify({ id: 'evt_end', type: 'customer.subscription.deleted', data: { object: { id: org.stripe_subscription_id, customer: org.stripe_customer_id, status: 'canceled' } } });
    await fetch(`${base}/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signForTest(body, SECRET) }, body });
    await page.goto(`${base}/feed`);
    assert.ok(await page.isVisible('text=Your subscription has ended'));
    assert.ok(await page.isVisible('text=Highways bridge inspection'), 'still readable');
    await page.goto(`${base}/searches/new`);
    await page.fill('input[name=name]', 'Blocked');
    await page.click('form.stack button.button >> nth=-1');
    await page.waitForURL('**/billing');
  });

  await t.test('they take their data and delete the organisation', async () => {
    await page.goto(`${base}/account`);
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('text=Download our data')]);
    const data = JSON.parse(await (await download.createReadStream()).toArray().then((c) => Buffer.concat(c).toString()));
    assert.equal(data.organisation.name, 'Civils Ltd');
    assert.equal(data.saved_searches[0].name, 'Bridges');

    await page.fill('input[name=confirm]', 'Civils Ltd');
    await page.fill('#delete input[name=password]', 'correct horse battery');
    await page.click('text=Delete permanently');
    await page.waitForURL(/\?deleted=org/);
    assert.ok(await page.isVisible('text=Your organisation and its data have been deleted'));
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM users WHERE email = 'pat@civils.example'`).get().n, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM opportunities WHERE external_id = 'p1'`).get().n, 0);
    assert.ok(db.prepare(`SELECT 1 FROM orgs WHERE name = 'Rival Ltd'`).get(), 'the other customer is untouched');
  });

  await t.test('public pages fit a phone screen and no page logged a script error', async () => {
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
    for (const path of ['/', '/pricing', '/register', '/login', '/terms']) {
      await phone.goto(`${base}${path}`);
      const width = await phone.evaluate(() => document.documentElement.scrollWidth);
      assert.ok(width <= 390, `${path} is ${width}px wide`);
    }
    assert.deepEqual(errors, []);
  });
});
