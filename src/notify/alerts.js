// Saved-search alerts. After each ingest, every saved search is checked for
// matches it has not alerted on before; new ones go to its channels (email,
// Slack, webhook). "Instant" searches fire straight after ingest, daily and
// weekly ones when their period has passed.
import { config } from '../config.js';
import { log } from '../log.js';
import { getFeed } from '../match/feed.js';
import { splitList } from '../match/score.js';
import { decryptOrNull } from '../secrets/vault.js';
import { emailConfigured, renderEmail, sendEmail, sendSlack, sendWebhook } from './channels.js';

export const parseFilters = (search) => { try { return JSON.parse(search.filters || '{}'); } catch { return {}; } };

export function searchResults(db, search, opts = {}) {
  return getFeed(db, search.org_id, { ...parseFilters(search), view: 'matches', sort: 'score', limit: 500, ...opts });
}

// A new search starts from now: what already matches is not alerted on.
export function baseline(db, search) {
  const mark = db.prepare('INSERT OR IGNORE INTO alert_deliveries (saved_search_id, opportunity_id) VALUES (?, ?)');
  db.transaction(() => { for (const o of searchResults(db, search).items) mark.run(search.id, o.id); })();
}

export function isAlertDue(search, now = Date.now()) {
  if (search.frequency === 'off') return false;
  if (search.frequency === 'instant' || !search.last_alert_at) return true;
  const ageDays = (now - Date.parse(`${search.last_alert_at.replace(' ', 'T')}Z`)) / 864e5;
  return search.frequency === 'weekly' ? ageDays >= 6.5 : ageDays >= 0.9;
}

export async function deliver(db, search, items, { channels = {} } = {}) {
  const title = `${items.length} new ${items.length === 1 ? 'match' : 'matches'} for "${search.name}"`;
  const link = `${config.baseUrl}/searches/${search.id}`;
  const record = db.prepare('INSERT INTO alert_log (saved_search_id, channel, item_count, ok, error) VALUES (?, ?, ?, ?, ?)');
  const attempt = async (channel, fn) => {
    try {
      await fn();
      record.run(search.id, channel, items.length, 1, null);
      return true;
    } catch (err) {
      record.run(search.id, channel, items.length, 0, String(err.message).slice(0, 500));
      log.error(`Alert "${search.name}" via ${channel} failed: ${err.message}`);
      return false;
    }
  };
  const results = {};
  const emails = splitList(search.emails);
  if (emails.length && (channels.sendEmail || emailConfigured())) {
    results.email = await attempt('email', async () => (channels.sendEmail || sendEmail)({
      to: emails, subject: title,
      html: await renderEmail({ org: { name: search.name }, items: items.slice(0, 25), heading: title, intro: 'Best matches first.', manageUrl: link }),
    }));
  }
  const slack = decryptOrNull(search.slack_webhook);
  if (slack) results.slack = await attempt('slack', () => (channels.sendSlack || sendSlack)(slack, { title, items, link }));
  const hook = decryptOrNull(search.webhook_url);
  if (hook) results.webhook = await attempt('webhook', () => (channels.sendWebhook || sendWebhook)(hook, { title, items, search }));
  return results;
}

export async function runAlerts(db, { now = Date.now(), channels, only } = {}) {
  const searches = db.prepare(`
    SELECT s.* FROM saved_searches s JOIN orgs o ON o.id = s.org_id WHERE o.plan != 'suspended' AND s.frequency != 'off'
      AND EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = o.id AND u.email_verified_at IS NOT NULL)
  `).all().filter((s) => (!only || s.id === only) && isAlertDue(s, now));
  const out = [];
  for (const search of searches) {
    const sent = new Set(db.prepare('SELECT opportunity_id FROM alert_deliveries WHERE saved_search_id = ?').all(search.id).map((r) => r.opportunity_id));
    const fresh = searchResults(db, search, { now }).items.filter((o) => !sent.has(o.id));
    if (!fresh.length) continue;
    const results = await deliver(db, search, fresh, { channels });
    // Mark as delivered once any channel took them (or there is nowhere to send), so a dead webhook cannot cause repeats.
    const anyOk = Object.values(results).some(Boolean) || !Object.keys(results).length;
    if (anyOk) {
      const mark = db.prepare('INSERT OR IGNORE INTO alert_deliveries (saved_search_id, opportunity_id) VALUES (?, ?)');
      db.transaction(() => { for (const o of fresh) mark.run(search.id, o.id); })();
      db.prepare(`UPDATE saved_searches SET last_alert_at = datetime('now') WHERE id = ?`).run(search.id);
    }
    out.push({ search: search.id, count: fresh.length, ...results });
  }
  if (out.length) log.info(`Alerts: ${out.length} saved searches had new matches`);
  return out;
}
