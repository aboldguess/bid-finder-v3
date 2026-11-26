// Email digests: new, well-matched opportunities since the last digest.
// Without SMTP configured, digests are still built and readable in the app.
import { log } from '../log.js';
import { entitlement } from '../billing/plans.js';
import { emailConfigured, renderEmail, sendEmail } from './channels.js';
import { getFeed } from '../match/feed.js';
import { splitList } from '../match/score.js';

export function lastDigestAt(db, orgId) {
  return db.prepare('SELECT MAX(created_at) AS at FROM digests WHERE org_id = ?').get(orgId).at;
}

export function isDue(frequency, lastAt, now = Date.now()) {
  if (frequency === 'off') return false;
  if (!lastAt) return true;
  const ageDays = (now - Date.parse(`${lastAt.replace(' ', 'T')}Z`)) / 864e5;
  return frequency === 'weekly' ? ageDays >= 6.5 : ageDays >= 0.5;
}

export async function buildDigest(db, org, { now = Date.now() } = {}) {
  const last = lastDigestAt(db, org.id);
  const since = last || new Date(now - 7 * 864e5).toISOString().replace('T', ' ').slice(0, 19);
  const { items, profile } = getFeed(db, org.id, { since, limit: 25, now });
  if (!items.length) return null;
  const html = await renderEmail({ org, items });
  return { items, html, recipients: splitList(profile.digest_emails) };
}

export async function sendDigest(db, org, opts = {}) {
  const digest = await buildDigest(db, org, opts);
  if (!digest) return null;
  let delivered = 0;
  if (emailConfigured() && digest.recipients.length) {
    try {
      await sendEmail({
        to: digest.recipients,
        subject: `${digest.items.length} new ${digest.items.length === 1 ? 'opportunity' : 'opportunities'} for ${org.name}`,
        html: digest.html,
      });
      delivered = 1;
    } catch (err) {
      log.error(`Digest email for org ${org.id} failed: ${err.message}`);
    }
  }
  db.prepare('INSERT INTO digests (org_id, item_count, recipients, delivered, html) VALUES (?, ?, ?, ?, ?)')
    .run(org.id, digest.items.length, digest.recipients.join(', '), delivered, digest.html);
  return { count: digest.items.length, delivered };
}

export async function runDigests(db, { now = Date.now() } = {}) {
  const orgs = db.prepare(`
    SELECT o.*, p.digest_frequency FROM orgs o JOIN profiles p ON p.org_id = o.id
    WHERE o.plan != 'suspended'
      AND EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = o.id AND u.email_verified_at IS NOT NULL)
  `).all();
  const results = [];
  for (const org of orgs) {
    if (!isDue(org.digest_frequency, lastDigestAt(db, org.id), now)) continue;
    if (entitlement(db, org, now).readOnly) continue;
    const r = await sendDigest(db, org, { now });
    if (r) results.push({ org: org.id, ...r });
  }
  log.info(`Digests: ${results.length} built`);
  return results;
}
