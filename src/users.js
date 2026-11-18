// Creating accounts and changing who administers the platform. Shared by the
// sign-up page and the `bidfinder` command line, so both follow the same rules.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

export const MIN_PASSWORD = 10;
const PROFILE_TYPES = 'grant\ntender';
const validEmail = (email) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);

export class UserError extends Error {}

export const generatePassword = () => crypto.randomBytes(12).toString('base64url');

export const findUser = (db, email) => db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());

// Creates a user. Give orgName to start a new organisation the user owns, or
// orgId to add them to an existing one (as 'member' unless role says otherwise).
// The first account on a server is always a platform administrator.
export async function createUser(db, { email, name, password, orgName, orgId, role, admin = false }) {
  email = String(email || '').trim().toLowerCase();
  name = String(name || '').trim();
  if (!validEmail(email)) throw new UserError(`"${email}" does not look like an email address.`);
  if (!name) throw new UserError('Give the person\'s name.');
  if (String(password || '').length < MIN_PASSWORD) throw new UserError(`Use a password of at least ${MIN_PASSWORD} characters.`);
  if (findUser(db, email)) throw new UserError(`An account with the email ${email} already exists.`);
  if (orgId == null && !String(orgName || '').trim()) throw new UserError('Give an organisation for the account.');
  if (orgId != null && !db.prepare('SELECT 1 FROM orgs WHERE id = ?').get(orgId)) throw new UserError(`No organisation with id ${orgId}.`);
  if (role && !['owner', 'member'].includes(role)) throw new UserError('The role must be owner or member.');

  const hash = await bcrypt.hash(password, 12);
  return db.transaction(() => {
    const first = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
    const isAdmin = first || Boolean(admin);
    const id = Number(db.prepare('INSERT INTO users (email, name, password_hash, is_platform_admin) VALUES (?, ?, ?, ?)').run(email, name, hash, isAdmin ? 1 : 0).lastInsertRowid);
    let org = orgId;
    if (org == null) {
      org = Number(db.prepare(`INSERT INTO orgs (name, kind) VALUES (?, 'company')`).run(String(orgName).trim().slice(0, 200)).lastInsertRowid);
      db.prepare('INSERT INTO profiles (org_id, digest_emails, types) VALUES (?, ?, ?)').run(org, email, PROFILE_TYPES);
      role ||= 'owner';
    }
    db.prepare('INSERT INTO memberships (user_id, org_id, role) VALUES (?, ?, ?)').run(id, org, role || 'member');
    return { id, email, name, orgId: org, role: role || 'member', isAdmin, first };
  })();
}

// Makes a user a platform administrator, or takes it away. The last
// administrator cannot be demoted, so the Admin page is never left unreachable.
export function setPlatformAdmin(db, email, admin) {
  const user = findUser(db, email);
  if (!user) throw new UserError(`No account with the email ${email}.`);
  if (Boolean(user.is_platform_admin) === Boolean(admin)) return { user, changed: false };
  if (!admin && db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_platform_admin = 1').get().n <= 1) {
    throw new UserError(`${user.email} is the only administrator. Promote someone else first.`);
  }
  db.prepare('UPDATE users SET is_platform_admin = ? WHERE id = ?').run(admin ? 1 : 0, user.id);
  return { user, changed: true };
}

export function listUsers(db) {
  return db.prepare(`
    SELECT u.email, u.name, CASE u.is_platform_admin WHEN 1 THEN 'yes' ELSE '' END AS admin,
      COALESCE(GROUP_CONCAT(o.name || ' (' || m.role || ')', ', '), '') AS organisations, u.created_at
    FROM users u LEFT JOIN memberships m ON m.user_id = u.id LEFT JOIN orgs o ON o.id = m.org_id
    GROUP BY u.id ORDER BY u.id
  `).all();
}

export const listOrgs = (db) => db.prepare(`
  SELECT o.id, o.name, (SELECT COUNT(*) FROM memberships m WHERE m.org_id = o.id) AS members FROM orgs o ORDER BY o.id
`).all();
