// Email verification and password reset, by single-use links sent through
// the server's mailer. Tokens are stored hashed and expire (users.js).
import { config } from '../../config.js';
import { log } from '../../log.js';
import { checkEmailToken, findUser, issueEmailToken, markVerified, MIN_PASSWORD, setPassword, useEmailToken } from '../../users.js';
import { tooMany } from '../security.js';
import { validEmail } from '../context.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A plain, readable email with one button.
export const linkEmail = ({ name, intro, action, url, outro }) => `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1b2430;max-width:520px;margin:0 auto;padding:24px">
<p>Hello ${esc(name)},</p><p>${esc(intro)}</p>
<p><a href="${esc(url)}" style="display:inline-block;background:#1565d8;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">${esc(action)}</a></p>
<p style="color:#5b6675;font-size:14px">Or paste this link into your browser:<br>${esc(url)}</p>
<p style="color:#5b6675;font-size:14px">${esc(outro)}</p><p style="color:#5b6675;font-size:14px">Bid Finder</p></body></html>`;

export function emailRoutes(app, ctx) {
  const { db, flash, requireUser, audit, limits } = ctx;

  // Sends the verification link. Returns false if email is not set up or the send failed.
  async function sendVerification(user) {
    if (!ctx.mailReady()) return false;
    const url = `${config.baseUrl}/verify/${issueEmailToken(db, user, 'verify')}`;
    try {
      await ctx.mail({ to: [user.email], subject: 'Confirm your email for Bid Finder', html: linkEmail({
        name: user.name, intro: 'Please confirm this is your email address. Until you do, Bid Finder will not send you alerts or digests.',
        action: 'Confirm my email', url, outro: 'The link works for 48 hours. If you did not create an account, ignore this email.',
      }) });
      return true;
    } catch (err) {
      log.error(`Verification email to user ${user.id} failed: ${err.message}`);
      return false;
    }
  }
  ctx.sendVerification = sendVerification;

  app.get('/verify/:token', (req, res) => {
    const user = checkEmailToken(db, req.params.token, 'verify');
    if (!user || !useEmailToken(db, user)) return res.status(400).render('error', { message: 'This link has expired or has already been used. Sign in and ask for a new one from the banner at the top of the page.' });
    markVerified(db, user.id);
    audit(req, 'email.verified', user.email, user);
    if (req.user?.id === user.id) {
      flash(req, 'Thanks, your email address is confirmed.');
      return res.redirect('/dashboard');
    }
    flash(req, 'Thanks, your email address is confirmed. Sign in to carry on.');
    res.redirect('/login');
  });

  app.post('/account/verify', requireUser, async (req, res) => {
    const key = `verify|${req.user.id}`;
    if (limits.resetEmail.retryAfter(key)) {
      flash(req, 'We have sent several links already. Check your spam folder, or try again in an hour.');
    } else {
      limits.resetEmail.hit(key);
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
      flash(req, await sendVerification(user) ? `We have sent a new link to ${user.email}.` : 'Email could not be sent from this server. Ask your administrator.');
    }
    res.redirect(req.get('referer')?.startsWith(config.baseUrl) ? new URL(req.get('referer')).pathname : '/dashboard');
  });

  // --- Forgotten password ------------------------------------------------------

  const forgotPage = (res, extra = {}) => res.status(extra.status || 200).render('forgot', { sent: false, error: null, email: '', canEmail: ctx.mailReady(), ...extra });
  app.get('/forgot', (req, res) => forgotPage(res));

  app.post('/forgot', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase().slice(0, 320);
    if (!ctx.mailReady()) return forgotPage(res, { status: 503 });
    if (!validEmail(email)) return forgotPage(res, { status: 400, email, error: 'That email address does not look right.' });
    const ip = req.ip || '';
    const wait = limits.resetIp.retryAfter(ip);
    if (wait) return tooMany(res, wait).render('forgot', { sent: false, email, canEmail: true, error: 'Too many requests from your network. Try again later.' });
    limits.resetIp.hit(ip);
    // The page says the same whether or not the account exists, so it cannot be used to find out who has one.
    const user = findUser(db, email);
    if (user && !limits.resetEmail.retryAfter(`reset|${email}`)) {
      limits.resetEmail.hit(`reset|${email}`);
      const url = `${config.baseUrl}/reset/${issueEmailToken(db, user, 'reset')}`;
      try {
        await ctx.mail({ to: [user.email], subject: 'Reset your Bid Finder password', html: linkEmail({
          name: user.name, intro: 'Someone asked to reset the password for your Bid Finder account. If it was you, choose a new one here.',
          action: 'Choose a new password', url, outro: 'The link works for one hour and only once. If you did not ask for this, ignore this email; your password has not changed.',
        }) });
        audit(req, 'password.reset.requested', email, user);
      } catch (err) {
        log.error(`Password reset email to user ${user.id} failed: ${err.message}`);
      }
    }
    forgotPage(res, { sent: true, email });
  });

  const resetPage = (req, res, extra = {}) => res.status(extra.status || 200).render('reset', { token: req.params.token, error: null, min: MIN_PASSWORD, ...extra });
  const invalid = (res) => res.status(400).render('error', { message: 'This reset link has expired or has already been used. Ask for a new one from the sign-in page.' });

  app.get('/reset/:token', (req, res) => (checkEmailToken(db, req.params.token, 'reset') ? resetPage(req, res) : invalid(res)));

  app.post('/reset/:token', async (req, res) => {
    const user = checkEmailToken(db, req.params.token, 'reset');
    if (!user) return invalid(res);
    const password = String(req.body.password || '');
    if (password.length < MIN_PASSWORD) return resetPage(req, res, { status: 400, error: `Use a password of at least ${MIN_PASSWORD} characters.` });
    if (password !== String(req.body.confirm || '')) return resetPage(req, res, { status: 400, error: 'The two passwords do not match.' });
    if (!useEmailToken(db, user)) return invalid(res);
    await setPassword(db, user.id, password); // also signs out every session
    markVerified(db, user.id); // they proved they can read the inbox
    audit(req, 'password.reset', user.email, user);
    req.session.regenerate(() => {
      req.session.userId = user.id;
      flash(req, 'Password changed. Any other devices have been signed out.');
      res.redirect('/dashboard');
    });
  });
}

