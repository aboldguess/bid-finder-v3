// Pricing page, the customer's billing page, and the platform administrator's
// plan and promotion settings. Card payments are added in the Stripe step.
import { config } from '../../config.js';
import { getPlan, getSetting, listPlans, pounds, setSetting, STATUSES } from '../../billing/plans.js';
import { applyEvent, lineItem, verifyWebhook } from '../../billing/stripe.js';
import { log } from '../../log.js';

const COLOUR = /^#[0-9a-f]{6}$/i;
const penceFrom = (value, { optional = false } = {}) => {
  const text = String(value ?? '').replace(/[£,\s]/g, '');
  if (text === '') { if (optional) return null; throw new Error('Every plan needs a monthly and an annual price.'); }
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0 || n > 100000) throw new Error(`"${value}" is not a price in pounds.`);
  return Math.round(n * 100);
};
const countFrom = (value) => {
  const text = String(value ?? '').trim();
  if (text === '') return null; // unlimited
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0 || n > 100000) throw new Error(`"${value}" is not a whole number. Leave it empty for unlimited.`);
  return n;
};
const dateFrom = (value) => {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const t = Date.parse(text.length === 10 ? `${text}T23:59:59Z` : text);
  if (Number.isNaN(t)) throw new Error(`"${value}" is not a date.`);
  return new Date(t).toISOString();
};

export function billingRoutes(app, ctx) {
  const { db, flash, requireUser, requireAdmin, requireOwner, audit, stripe } = ctx;
  const guard = [requireUser, requireAdmin];
  const hostedOnly = (req, res, next) => (config.hosted ? next() : res.status(404).render('error', { message: 'Page not found.' }));

  app.get('/pricing', hostedOnly, (req, res) => {
    res.render('pricing', { plans: listPlans(db, { publicOnly: true }), pounds, trialDays: Number(getSetting(db, 'trial_days', '14')) });
  });

  app.get('/billing', hostedOnly, requireUser, (req, res) => {
    res.render('billing', {
      plans: listPlans(db, { publicOnly: true }), pounds, current: req.org.plan_key ? getPlan(db, req.org.plan_key) : null,
      canPay: stripe.configured && req.org.role === 'owner', stripeReady: stripe.configured, done: req.query.done === '1',
    });
  });

  const back = (req, res, message) => { flash(req, message); res.redirect(303, '/billing'); };

  // Start paying, or switch plan. A first payment goes through Stripe Checkout;
  // a change to an existing subscription is made directly, with proration.
  app.post('/billing/checkout', hostedOnly, requireUser, requireOwner, async (req, res) => {
    if (!stripe.configured) return back(req, res, 'Card payments are not set up on this server yet.');
    const plan = getPlan(db, String(req.body.plan || ''));
    const period = req.body.period === 'annual' ? 'annual' : 'monthly';
    if (!plan || !plan.public) return back(req, res, 'Choose one of the plans below.');
    const org = db.prepare('SELECT * FROM orgs WHERE id = ?').get(req.org.id);
    if (org.billing_status === 'comped') return back(req, res, 'Your account is complimentary, so there is nothing to pay.');
    const meta = { org_id: org.id, plan_key: plan.key, period };
    try {
      if (org.stripe_subscription_id && ['active', 'past_due'].includes(org.billing_status)) {
        const sub = await stripe.getSubscription(org.stripe_subscription_id);
        const product = await stripe.createProduct({ name: lineItem(plan, period).price_data.product_data.name, metadata: { plan_key: plan.key } });
        const { product_data: _unused, ...priceData } = lineItem(plan, period).price_data;
        await stripe.updateSubscription(sub.id, {
          items: [{ id: sub.items.data[0].id, price_data: { ...priceData, product: product.id } }],
          metadata: meta, proration_behavior: 'create_prorations',
        });
        db.prepare('UPDATE orgs SET plan_key = ?, billing_period = ? WHERE id = ?').run(plan.key, period, org.id);
        audit(req, 'billing.changed', `${plan.key} ${period}`);
        return back(req, res, `You are now on ${plan.name}, billed ${period === 'annual' ? 'yearly' : 'monthly'}. The difference is prorated on your next invoice.`);
      }
      let customer = org.stripe_customer_id;
      if (!customer) {
        customer = (await stripe.createCustomer({ email: req.user.email, name: org.name, metadata: { org_id: org.id } })).id;
        db.prepare('UPDATE orgs SET stripe_customer_id = ? WHERE id = ?').run(customer, org.id);
      }
      // Keep whatever is left of the free trial: the first charge comes when it ends (Stripe needs at least two days' notice).
      const trialEnd = org.billing_status === 'trialing' ? Math.floor(Date.parse(org.trial_ends_at || '') / 1000) : 0;
      const tax = config.stripe.tax;
      const session = await stripe.createCheckout({
        mode: 'subscription', customer, client_reference_id: org.id, metadata: meta,
        line_items: [lineItem(plan, period)],
        subscription_data: { metadata: meta, ...(trialEnd > Date.now() / 1000 + 2 * 86400 ? { trial_end: trialEnd } : {}) },
        success_url: `${config.baseUrl}/billing?done=1`, cancel_url: `${config.baseUrl}/billing`,
        billing_address_collection: 'required', allow_promotion_codes: true,
        ...(tax ? { automatic_tax: { enabled: true }, tax_id_collection: { enabled: true }, customer_update: { address: 'auto', name: 'auto' } } : {}),
      });
      audit(req, 'billing.checkout', `${plan.key} ${period}`);
      res.redirect(303, session.url);
    } catch (err) {
      log.error(`Checkout for org ${org.id} failed: ${err.message}`);
      back(req, res, 'We could not reach the payment provider. Nothing has been charged. Please try again in a minute.');
    }
  });

  // Update the card, see invoices, or cancel: Stripe's own Customer Portal.
  app.post('/billing/portal', hostedOnly, requireUser, requireOwner, async (req, res) => {
    const org = db.prepare('SELECT stripe_customer_id FROM orgs WHERE id = ?').get(req.org.id);
    if (!stripe.configured || !org.stripe_customer_id) return back(req, res, 'There are no card details on file yet.');
    try {
      res.redirect(303, (await stripe.createPortal({ customer: org.stripe_customer_id, return_url: `${config.baseUrl}/billing` })).url);
    } catch (err) {
      log.error(`Billing portal for org ${req.org.id} failed: ${err.message}`);
      back(req, res, 'We could not reach the payment provider. Please try again in a minute.');
    }
  });

  // --- Platform administration: plans and promotions --------------------------

  app.get('/admin/plans', guard, (req, res) => {
    const settings = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
    res.render('admin-plans', { plans: listPlans(db), settings, pounds, error: null });
  });

  const fail = (req, res, err) => {
    flash(req, err.message);
    res.redirect('/admin/plans');
  };

  app.post('/admin/plans', guard, (req, res) => {
    const b = req.body;
    const isNew = !b.key_existing;
    const key = isNew ? String(b.key || '').trim().toLowerCase() : String(b.key_existing);
    try {
      if (isNew && !/^[a-z][a-z0-9-]{1,30}$/.test(key)) throw new Error('A plan key is 2 to 31 lowercase letters, digits or dashes, starting with a letter.');
      if (isNew && getPlan(db, key)) throw new Error(`There is already a plan called "${key}".`);
      if (!isNew && !getPlan(db, key)) throw new Error('That plan no longer exists.');
      const colour = String(b.colour || '#1565d8').trim();
      if (!COLOUR.test(colour)) throw new Error('Colours look like #1565d8.');
      const row = {
        key,
        name: String(b.name || '').trim().slice(0, 60) || (() => { throw new Error('Give the plan a name.'); })(),
        tagline: String(b.tagline || '').trim().slice(0, 200),
        monthly_pence: penceFrom(b.monthly),
        annual_pence: penceFrom(b.annual),
        sale_monthly_pence: penceFrom(b.sale_monthly, { optional: true }),
        sale_annual_pence: penceFrom(b.sale_annual, { optional: true }),
        sale_label: String(b.sale_label || '').trim().slice(0, 40),
        sale_ends_at: dateFrom(b.sale_ends_at),
        badge: String(b.badge || '').trim().slice(0, 40),
        colour,
        seats: countFrom(b.seats),
        saved_searches: countFrom(b.saved_searches),
        instant_alerts: b.instant_alerts ? 1 : 0,
        private_sources: countFrom(b.private_sources) ?? 0,
        features: String(b.features || '').split('\n').map((f) => f.trim()).filter(Boolean).slice(0, 20).join('\n'),
        sort: Number.parseInt(b.sort, 10) || 0,
        public: b.public ? 1 : 0,
      };
      const cols = Object.keys(row);
      db.prepare(`INSERT INTO plans (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})
        ON CONFLICT(key) DO UPDATE SET ${cols.filter((c) => c !== 'key').map((c) => `${c} = excluded.${c}`).join(', ')}, updated_at = datetime('now')`).run(row);
      audit(req, isNew ? 'plan.created' : 'plan.updated', `${key} ${pounds(row.monthly_pence)}/mo${row.sale_monthly_pence != null ? ` sale ${pounds(row.sale_monthly_pence)}` : ''}`);
      flash(req, `${row.name} saved. The pricing page shows it straight away.`);
      res.redirect('/admin/plans');
    } catch (err) {
      fail(req, res, err);
    }
  });

  app.post('/admin/settings', guard, (req, res) => {
    const b = req.body;
    try {
      const days = Number(b.trial_days);
      if (!Number.isInteger(days) || days < 0 || days > 365) throw new Error('The trial length is a whole number of days, 0 to 365.');
      if (!getPlan(db, b.trial_plan)) throw new Error('Choose which plan trials get.');
      const colour = String(b.banner_colour || '').trim();
      if (!COLOUR.test(colour)) throw new Error('Colours look like #c62828.');
      setSetting(db, 'trial_days', days);
      setSetting(db, 'trial_plan', b.trial_plan);
      setSetting(db, 'banner_text', String(b.banner_text || '').trim().slice(0, 140));
      setSetting(db, 'banner_colour', colour);
      setSetting(db, 'banner_ends_at', dateFrom(b.banner_ends_at) || '');
      audit(req, 'settings.updated', `trial ${days} days on ${b.trial_plan}; banner "${String(b.banner_text || '').slice(0, 60)}"`);
      flash(req, 'Settings saved.');
    } catch (err) {
      flash(req, err.message);
    }
    res.redirect('/admin/plans');
  });

  // Set an organisation's plan and status by hand: comp a partner, extend a trial, end one.
  app.post('/admin/orgs/:id/billing', guard, (req, res) => {
    const id = Number(req.params.id);
    const b = req.body;
    try {
      if (!db.prepare('SELECT 1 FROM orgs WHERE id = ?').get(id)) throw new Error('Organisation not found.');
      if (!STATUSES.includes(b.billing_status)) throw new Error('Choose a status.');
      const planKey = b.plan_key ? String(b.plan_key) : null;
      if (planKey && !getPlan(db, planKey)) throw new Error('That plan no longer exists.');
      db.prepare('UPDATE orgs SET billing_status = ?, plan_key = ?, trial_ends_at = COALESCE(?, trial_ends_at) WHERE id = ?')
        .run(b.billing_status, planKey, dateFrom(b.trial_ends_at), id);
      audit(req, 'org.billing', `${id} ${b.billing_status} ${planKey || ''} ${b.trial_ends_at || ''}`.trim());
      flash(req, 'Organisation updated.');
    } catch (err) {
      flash(req, err.message);
    }
    res.redirect('/admin#orgs');
  });
}

// Stripe webhooks. Mounted in app.js before the body parsers, sessions and
// CSRF, because the signature is over the exact bytes Stripe sent.
export function stripeWebhook(db) {
  return (req, res) => {
    let event;
    try {
      event = verifyWebhook(req.body.toString('utf8'), req.get('stripe-signature'));
    } catch (err) {
      log.warn(`Stripe webhook rejected: ${err.message}`);
      return res.status(400).json({ error: 'bad signature' });
    }
    try {
      res.json({ received: true, result: applyEvent(db, event) });
    } catch (err) {
      log.error('Stripe webhook failed', err);
      res.status(500).json({ error: 'failed' }); // Stripe retries
    }
  };
}
