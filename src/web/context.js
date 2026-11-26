// Helpers shared by the route modules.
import crypto from 'node:crypto';
import { getProfile } from '../match/feed.js';
import { scoreOpportunity } from '../match/score.js';
import { createAuthLimits } from './security.js';
import { emailConfigured, sendEmail } from '../notify/channels.js';

export const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
export const newToken = (prefix = '') => `${prefix}${crypto.randomBytes(24).toString('base64url')}`;
export const validEmail = (email) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);

// `mail` replaces the SMTP sender, for tests.
export function createContext(db, { mail } = {}) {
  const flash = (req, message) => { req.session.flash = message; };
  const render403 = (res, message) => res.status(403).render('error', { message });
  return {
    db,
    flash,
    limits: createAuthLimits(),
    mail: mail || sendEmail,
    mailReady: () => Boolean(mail) || emailConfigured(),
    requireUser: (req, res, next) => (req.user ? next() : res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`)),
    requireAdmin: (req, res, next) => (req.user?.is_platform_admin ? next() : render403(res, 'Platform administrators only.')),
    requireOwner: (req, res, next) => (req.org?.role === 'owner' ? next() : render403(res, 'Only the organisation owner can do that.')),
    audit(req, action, detail = '', actor = req.user) {
      db.prepare('INSERT INTO audit_log (user_id, actor, action, detail, ip) VALUES (?, ?, ?, ?, ?)')
        .run(actor?.id ?? null, actor?.email || '', action, String(detail).slice(0, 500), req.ip || '');
    },
    loadOpportunity: (id) => db.prepare('SELECT * FROM opportunities WHERE id = ?').get(Number(id)),
    // An opportunity with this organisation's score and triage state.
    withMatch(opp, orgId) {
      const state = db.prepare('SELECT * FROM org_opportunity_state WHERE org_id = ? AND opportunity_id = ?').get(orgId, opp.id) || {};
      return { ...opp, starred: state.starred || 0, hidden: state.hidden || 0, note: state.note || '', stage: state.stage || '', match: scoreOpportunity(opp, getProfile(db, orgId)) };
    },
    registrationOpen: (config) => config.hosted || config.allowRegistration || db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0,
  };
}

// Safe same-site redirect target, or the fallback.
export const localPath = (value, fallback) => (/^\/[^/\\]/.test(value || '') ? value : fallback);
