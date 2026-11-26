// Customers' data rights and the legal pages: export everything, delete an
// account or a whole organisation, and the terms and privacy notice, whose
// wording platform administrators paste in at Admin → Legal pages.
import bcrypt from 'bcryptjs';
import { config } from '../../config.js';
import { deleteOrg, deleteUser, exportOrg } from '../../account-data.js';
import { getSetting, setSetting } from '../../billing/plans.js';
import { log } from '../../log.js';

export const LEGAL = { terms: 'Terms of service', privacy: 'Privacy notice' };
const PLACEHOLDER = 'The full wording is being finalised and will be published here before launch.';

// Plain text to safe HTML: blank lines split paragraphs, "# " or "## " starts a
// heading, "- " starts a bullet. Everything is escaped; no HTML gets through.
export function renderLegal(text) {
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  return String(text || '').replace(/\r/g, '').split(/\n{2,}/).map((block) => {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return '';
    if (lines.every((l) => l.startsWith('- '))) return `<ul>${lines.map((l) => `<li>${esc(l.slice(2))}</li>`).join('')}</ul>`;
    const heading = lines[0].match(/^#{1,3}\s+(.*)$/);
    if (heading) return `<h2>${esc(heading[1])}</h2>${lines.length > 1 ? `<p>${lines.slice(1).map(esc).join('<br>')}</p>` : ''}`;
    return `<p>${lines.map(esc).join('<br>')}</p>`;
  }).join('\n');
}

export function dataRoutes(app, ctx) {
  const { db, flash, requireUser, requireAdmin, audit } = ctx;
  const hostedOnly = (req, res, next) => (config.hosted ? next() : res.status(404).render('error', { message: 'Page not found.' }));

  // --- Legal pages -----------------------------------------------------------

  for (const [slug, title] of Object.entries(LEGAL)) {
    app.get(`/${slug}`, hostedOnly, (req, res) => {
      const text = getSetting(db, `legal_${slug}`);
      res.render('legal', { title, html: text ? renderLegal(text) : '', placeholder: PLACEHOLDER, updated: getSetting(db, `legal_${slug}_updated`) });
    });
  }

  app.get('/admin/legal', requireAdmin, hostedOnly, (req, res) => {
    res.render('admin-legal', { pages: Object.entries(LEGAL).map(([slug, title]) => ({ slug, title, text: getSetting(db, `legal_${slug}`), updated: getSetting(db, `legal_${slug}_updated`) })) });
  });

  app.post('/admin/legal', requireAdmin, hostedOnly, (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    for (const slug of Object.keys(LEGAL)) {
      const text = String(req.body[slug] ?? '').slice(0, 100000).trim();
      if (text === getSetting(db, `legal_${slug}`)) continue;
      setSetting(db, `legal_${slug}`, text);
      setSetting(db, `legal_${slug}_updated`, text ? today : '');
      audit(req, 'legal.updated', slug);
    }
    flash(req, 'Legal pages saved. They are live now.');
    res.redirect('/admin/legal');
  });

  // --- Export ----------------------------------------------------------------

  app.get('/account/export', requireUser, (req, res) => {
    audit(req, 'data.exported', req.org.name);
    const name = `bid-finder-${req.org.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'export'}-${new Date().toISOString().slice(0, 10)}.json`;
    res.set('Content-Disposition', `attachment; filename="${name}"`);
    res.type('application/json').send(JSON.stringify(exportOrg(db, req.org.id), null, 2));
  });

  // --- Deleting an account or an organisation -------------------------------

  const lastAdmins = (userIds) => {
    const admins = db.prepare('SELECT id FROM users WHERE is_platform_admin = 1').all().map((r) => r.id);
    return admins.length > 0 && admins.every((id) => userIds.includes(id));
  };
  const fail = (req, res, message) => { flash(req, message); res.redirect('/account#delete'); };

  app.post('/account/delete', requireUser, async (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!(await bcrypt.compare(req.body.password || '', user.password_hash))) return fail(req, res, 'Your password was not right, so nothing was deleted.');
    const wholeOrg = req.body.scope === 'org';
    const org = db.prepare('SELECT * FROM orgs WHERE id = ?').get(req.org.id);
    const members = db.prepare('SELECT user_id, role FROM memberships WHERE org_id = ?').all(org.id);
    const owners = members.filter((m) => m.role === 'owner');

    if (wholeOrg) {
      if (req.org.role !== 'owner') return fail(req, res, 'Only an owner can delete the organisation.');
      if ((req.body.confirm || '').trim() !== org.name) return fail(req, res, `Type the organisation's name, ${org.name}, to confirm.`);
      const leaving = db.prepare(`SELECT m.user_id FROM memberships m WHERE m.org_id = ? AND NOT EXISTS (SELECT 1 FROM memberships x WHERE x.user_id = m.user_id AND x.org_id != ?)`).all(org.id, org.id).map((r) => r.user_id);
      if (lastAdmins(leaving)) return fail(req, res, 'This organisation includes the only platform administrator, so it cannot be deleted. Promote someone in another organisation first.');
      if (org.stripe_subscription_id && ['active', 'past_due', 'trialing'].includes(org.billing_status)) {
        try {
          await ctx.stripe.cancelSubscription(org.stripe_subscription_id);
        } catch (err) {
          log.error(`Cancelling subscription for org ${org.id} before deletion failed: ${err.message}`);
          return fail(req, res, 'We could not cancel your subscription with our payment provider, so nothing was deleted. Please try again in a few minutes.');
        }
      }
      const removed = deleteOrg(db, org.id);
      audit(req, 'org.deleted', `organisation ${org.id} and ${removed.length} ${removed.length === 1 ? 'account' : 'accounts'}`, null);
      return req.session.destroy(() => res.redirect('/?deleted=org'));
    }

    if (lastAdmins([user.id])) return fail(req, res, 'You are the only platform administrator, so your account cannot be deleted. Promote someone else first.');
    const otherOrgs = db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE user_id = ? AND org_id != ?').get(user.id, org.id).n;
    if (members.length === 1 && !otherOrgs) return fail(req, res, 'You are the only person in this organisation. Delete the whole organisation instead.');
    if (req.org.role === 'owner' && owners.length === 1 && members.length > 1) return fail(req, res, 'You are the only owner. Delete the whole organisation, or remove the other members first.');
    deleteUser(db, user.id);
    audit(req, 'user.deleted', `account ${user.id}`, null);
    req.session.destroy(() => res.redirect('/?deleted=account'));
  });
}
