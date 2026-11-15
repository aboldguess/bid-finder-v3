// Sign-up, sign-in, invites, team, account settings and API tokens.
import bcrypt from 'bcryptjs';
import { config } from '../../config.js';
import { loginThrottle } from '../security.js';
import { localPath, newToken, sha256, validEmail } from '../context.js';

const PROFILE_TYPES = 'grant\ntender';

export function accountRoutes(app, ctx) {
  const { db, flash, requireUser, requireOwner, audit } = ctx;
  const findInvite = (token) => token && db.prepare(`
    SELECT i.*, o.name AS org_name FROM invites i JOIN orgs o ON o.id = i.org_id
    WHERE i.token_hash = ? AND i.used_at IS NULL AND i.expires_at > ?
  `).get(sha256(token), new Date().toISOString());

  const registerPage = (req, res, { status = 200, error = null, form = {} } = {}) => {
    const invite = findInvite(req.params.token);
    if (req.params.token && !invite) return res.status(404).render('error', { message: 'This invitation has expired or has already been used. Ask for a new one.' });
    if (!invite && !ctx.registrationOpen(config)) return res.status(403).render('error', { message: 'Sign-up is closed on this server. Ask your administrator for an invitation.' });
    const first = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
    res.status(status).render('register', { error, form: { email: invite?.email || '', ...form }, invite, inviteToken: req.params.token || '', first });
  };

  app.get('/register', (req, res) => registerPage(req, res));
  app.get('/invite/:token', (req, res) => registerPage(req, res));

  const register = async (req, res) => {
    const invite = findInvite(req.params.token);
    if (req.params.token && !invite) return registerPage(req, res);
    if (!invite && !ctx.registrationOpen(config)) return registerPage(req, res);
    const form = {
      name: (req.body.name || '').trim().slice(0, 200),
      email: (req.body.email || '').trim().toLowerCase().slice(0, 320),
      orgName: (req.body.orgName || '').trim().slice(0, 200),
    };
    const password = req.body.password || '';
    const error =
      !form.name || !form.email || (!invite && !form.orgName) ? 'Please fill in every field.'
      : !validEmail(form.email) ? 'That email address does not look right.'
      : password.length < 10 ? 'Use a password of at least 10 characters.'
      : db.prepare('SELECT 1 FROM users WHERE email = ?').get(form.email) ? 'An account with that email already exists.'
      : null;
    if (error) return registerPage(req, res, { status: 400, error, form });

    const hash = await bcrypt.hash(password, 12);
    const userId = db.transaction(() => {
      // The very first account on a fresh install runs the platform.
      const first = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
      const user = db.prepare('INSERT INTO users (email, name, password_hash, is_platform_admin) VALUES (?, ?, ?, ?)').run(form.email, form.name, hash, first ? 1 : 0).lastInsertRowid;
      if (invite) {
        db.prepare(`INSERT INTO memberships (user_id, org_id, role) VALUES (?, ?, 'member')`).run(user, invite.org_id);
        db.prepare('UPDATE invites SET used_at = ? WHERE token_hash = ?').run(new Date().toISOString(), invite.token_hash);
      } else {
        const org = db.prepare(`INSERT INTO orgs (name, kind) VALUES (?, 'company')`).run(form.orgName).lastInsertRowid;
        db.prepare(`INSERT INTO memberships (user_id, org_id, role) VALUES (?, ?, 'owner')`).run(user, org);
        db.prepare('INSERT INTO profiles (org_id, digest_emails, types) VALUES (?, ?, ?)').run(org, form.email, PROFILE_TYPES);
      }
      return user;
    })();
    req.session.regenerate(() => {
      req.session.userId = userId;
      flash(req, invite ? `Welcome to ${invite.org_name}.` : 'Welcome. Tell us what you are looking for and every opportunity will be ranked for you.');
      res.redirect(invite ? '/dashboard' : '/profile');
    });
  };
  app.post('/register', register);
  app.post('/invite/:token', register);

  app.get('/login', (req, res) => res.render('login', { error: null, email: '', next: req.query.next || '', canRegister: ctx.registrationOpen(config) }));

  app.post('/login', async (req, res) => {
    const email = (req.body.email || '').trim().toLowerCase();
    const next = localPath(req.body.next, '/dashboard');
    const page = (status, error) => res.status(status).render('login', { error, email, next, canRegister: ctx.registrationOpen(config) });
    if (loginThrottle.blocked(req)) return page(429, 'Too many attempts. Try again in 15 minutes.');
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !(await bcrypt.compare(req.body.password || '', user.password_hash))) {
      loginThrottle.fail(req);
      audit(req, 'login.failed', email);
      return page(401, 'Email or password is incorrect.');
    }
    loginThrottle.clear(req);
    req.session.regenerate(() => {
      req.session.userId = user.id;
      res.redirect(next);
    });
  });

  app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

  // --- Account: password and API tokens -------------------------------------

  const accountPage = (req, res, extra = {}) => {
    const tokens = db.prepare('SELECT id, name, prefix, last_used_at, created_at FROM api_tokens WHERE user_id = ? AND org_id = ? ORDER BY id DESC').all(req.user.id, req.org.id);
    res.status(extra.status || 200).render('account', { tokens, error: null, newToken: null, ...extra });
  };
  app.get('/account', requireUser, (req, res) => accountPage(req, res));

  app.post('/account/password', requireUser, async (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!(await bcrypt.compare(req.body.current || '', user.password_hash))) return accountPage(req, res, { status: 400, error: 'Your current password is not right.' });
    if ((req.body.password || '').length < 10) return accountPage(req, res, { status: 400, error: 'Use a new password of at least 10 characters.' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(req.body.password, 12), user.id);
    // Sign out every other session for this user.
    db.prepare(`DELETE FROM sessions WHERE sid != ? AND json_extract(sess, '$.userId') = ?`).run(req.sessionID, user.id);
    audit(req, 'password.changed');
    flash(req, 'Password changed. Other devices have been signed out.');
    res.redirect('/account');
  });

  app.post('/account/tokens', requireUser, (req, res) => {
    const name = (req.body.name || '').trim().slice(0, 100) || 'API token';
    const token = newToken('bf_');
    db.prepare('INSERT INTO api_tokens (org_id, user_id, name, prefix, token_hash) VALUES (?, ?, ?, ?, ?)').run(req.org.id, req.user.id, name, token.slice(0, 9), sha256(token));
    audit(req, 'token.created', name);
    accountPage(req, res, { newToken: token });
  });

  app.post('/account/tokens/:id/revoke', requireUser, (req, res) => {
    db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
    audit(req, 'token.revoked', req.params.id);
    flash(req, 'Token revoked.');
    res.redirect('/account');
  });

  // --- Team -------------------------------------------------------------------

  const teamPage = (req, res, extra = {}) => {
    const members = db.prepare('SELECT u.id, u.name, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY m.role DESC, u.name').all(req.org.id);
    const invites = db.prepare('SELECT token_hash, email, expires_at FROM invites WHERE org_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC').all(req.org.id, new Date().toISOString());
    res.render('team', { members, invites, inviteLink: null, ...extra });
  };
  app.get('/team', requireUser, (req, res) => teamPage(req, res));

  app.post('/team/invites', requireUser, requireOwner, (req, res) => {
    const email = (req.body.email || '').trim().toLowerCase();
    const token = newToken();
    db.prepare('INSERT INTO invites (token_hash, org_id, email, created_by, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(sha256(token), req.org.id, validEmail(email) ? email : '', req.user.id, new Date(Date.now() + 7 * 864e5).toISOString());
    audit(req, 'invite.created', email);
    teamPage(req, res, { inviteLink: `${config.baseUrl}/invite/${token}` });
  });

  app.post('/team/invites/revoke', requireUser, requireOwner, (req, res) => {
    db.prepare('DELETE FROM invites WHERE token_hash = ? AND org_id = ?').run(String(req.body.id || ''), req.org.id);
    res.redirect('/team');
  });

  app.post('/team/members/:id/remove', requireUser, requireOwner, (req, res) => {
    const id = Number(req.params.id);
    if (id !== req.user.id) {
      db.transaction(() => {
        db.prepare(`DELETE FROM memberships WHERE user_id = ? AND org_id = ? AND role != 'owner'`).run(id, req.org.id);
        // An account with no organisation left cannot do anything, so remove it.
        db.prepare('DELETE FROM users WHERE id = ? AND id NOT IN (SELECT user_id FROM memberships)').run(id);
      })();
      audit(req, 'member.removed', id);
      flash(req, 'Member removed.');
    }
    res.redirect('/team');
  });
}
