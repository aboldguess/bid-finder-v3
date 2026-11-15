// Platform administration: sources, the credential vault, run history,
// organisations and the audit trail.
import crypto from 'node:crypto';
import { connectorForSource } from '../../connectors/index.js';
import { isIngestRunning, runAll, testSource } from '../../ingest/run.js';
import { runAlerts } from '../../notify/alerts.js';
import { assertPublicUrl } from '../../http/ssrf.js';
import { saveCredential } from '../../secrets/vault.js';
import { log } from '../../log.js';

// Settings an administrator fills in for each kind of custom source.
export const CUSTOM_FIELDS = {
  rss: [
    { key: 'url', label: 'Feed URL', placeholder: 'https://portal.example.com/opportunities.rss', required: true, url: true },
  ],
  portal: [
    { key: 'listUrl', label: 'Listing page URL', placeholder: 'https://portal.example.com/opportunities', required: true, url: true, help: 'The page that lists open opportunities. Add more, one per line, if there are several.', multiline: true },
    { key: 'itemSelector', label: 'Item selector', placeholder: 'table.opportunities tbody tr', required: true, help: 'CSS selector matching each opportunity in the list.' },
    { key: 'titleSelector', label: 'Title selector', placeholder: 'a.title', help: 'Within an item. Defaults to its first link.' },
    { key: 'linkSelector', label: 'Link selector', placeholder: 'a.title', help: 'Within an item. Defaults to its first link.' },
    { key: 'deadlineSelector', label: 'Closing date selector', placeholder: 'td.closing' },
    { key: 'buyerSelector', label: 'Buyer selector', placeholder: 'td.buyer' },
    { key: 'summarySelector', label: 'Summary selector', placeholder: 'p.description' },
    { key: 'valueSelector', label: 'Value selector', placeholder: 'td.value' },
    { key: 'nextSelector', label: 'Next-page link selector', placeholder: 'a[rel=next]' },
    { key: 'loginUrl', label: 'Sign-in page URL', placeholder: 'https://portal.example.com/login', url: true, help: 'Only for portals behind a login. Attach a username and password credential below.' },
    { key: 'usernameField', label: 'Username field name', placeholder: 'Detected automatically' },
    { key: 'passwordField', label: 'Password field name', placeholder: 'Detected automatically' },
  ],
};

export function adminRoutes(app, ctx) {
  const { db, flash, requireUser, requireAdmin, audit } = ctx;
  const guard = [requireUser, requireAdmin];
  const getSource = (key) => db.prepare('SELECT * FROM sources WHERE key = ?').get(key);
  const credentials = () => db.prepare('SELECT id, name, kind, created_at FROM credentials ORDER BY name').all();
  const parse = (text) => { try { return JSON.parse(text || '{}'); } catch { return {}; } };
  const fieldsFor = (source) => (source.kind === 'builtin' ? connectorForSource(source)?.settings || [] : CUSTOM_FIELDS[source.kind] || []);

  app.get('/admin', guard, (req, res) => {
    const sources = db.prepare(`
      SELECT s.*, c.name AS credential_name,
        (SELECT COUNT(*) FROM opportunities o WHERE o.source_key = s.key AND (o.closes_at IS NULL OR o.closes_at > ?)) AS open_count
      FROM sources s LEFT JOIN credentials c ON c.id = s.credential_id ORDER BY s.kind, s.name
    `).all(new Date().toISOString()).map((s) => ({ ...s, connector: connectorForSource(s) }));
    const orgs = db.prepare(`
      SELECT o.*, (SELECT COUNT(*) FROM memberships m WHERE m.org_id = o.id) AS members,
        (SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = o.id AND m.role = 'owner' LIMIT 1) AS owner_email
      FROM orgs o ORDER BY o.created_at DESC
    `).all();
    const runs = db.prepare('SELECT r.*, s.name FROM source_runs r JOIN sources s ON s.key = r.source_key ORDER BY r.id DESC LIMIT 25').all();
    const auditRows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 40').all();
    res.render('admin', { sources, orgs, runs, audit: auditRows, credentials: credentials(), ingesting: isIngestRunning() });
  });

  app.post('/admin/ingest', guard, (req, res) => {
    const source = req.body.source ? getSource(req.body.source) : null;
    // Runs in the background; the page shows progress.
    runAll(db, { only: source?.key }).then((r) => r.length && runAlerts(db)).catch((err) => log.error('Manual refresh failed', err));
    audit(req, 'ingest.started', source?.key || 'all');
    flash(req, `Refresh started${source ? ` for ${source.name}` : ''}. Large sources take a few minutes on their first run.`);
    res.redirect('/admin');
  });

  app.post('/admin/sources/:key/toggle', guard, (req, res) => {
    db.prepare('UPDATE sources SET enabled = 1 - enabled, next_run_at = NULL WHERE key = ?').run(req.params.key);
    audit(req, 'source.toggled', req.params.key);
    res.redirect('/admin');
  });

  // --- Source settings ------------------------------------------------------

  const editPage = (req, res, source, extra = {}) => res.status(extra.status || 200).render('source-form', {
    source, values: parse(source.config), fields: fieldsFor(source), credentials: credentials(), connector: source.key ? connectorForSource(source) : null,
    error: null, preview: null, ...extra,
  });

  app.get('/admin/sources/new', guard, (req, res) => {
    const kind = req.query.kind === 'portal' ? 'portal' : 'rss';
    editPage(req, res, { key: '', name: '', kind, type: 'tender', config: '{}', interval_minutes: kind === 'portal' ? 720 : 360, credential_id: null });
  });

  app.get('/admin/sources/:key', guard, (req, res) => {
    const source = getSource(req.params.key);
    if (!source) return res.status(404).render('error', { message: 'Source not found.' });
    editPage(req, res, source);
  });

  async function readForm(req, source) {
    const b = req.body;
    const values = {};
    for (const f of fieldsFor(source)) {
      const v = String(b[f.key] || '').trim().slice(0, 2000);
      if (f.required && !v) throw new Error(`${f.label} is needed.`);
      if (v && f.url) for (const u of v.split(/\n+/).map((x) => x.trim()).filter(Boolean)) await assertPublicUrl(u);
      if (v) values[f.key] = v;
    }
    const credentialId = Number(b.credential_id) || null;
    if (credentialId && !db.prepare('SELECT 1 FROM credentials WHERE id = ?').get(credentialId)) throw new Error('That credential no longer exists.');
    return {
      ...source,
      name: source.kind === 'builtin' ? source.name : String(b.name || '').trim().slice(0, 120),
      type: source.kind === 'builtin' ? source.type : (b.type === 'grant' ? 'grant' : 'tender'),
      config: JSON.stringify(values),
      credential_id: credentialId,
      interval_minutes: Math.min(10080, Math.max(15, Number(b.interval_minutes) || source.interval_minutes || 360)),
    };
  }

  async function saveSource(req, res) {
    const existing = req.params.key ? getSource(req.params.key) : null;
    if (req.params.key && !existing) return res.status(404).render('error', { message: 'Source not found.' });
    const base = existing || { key: '', kind: req.body.kind === 'portal' ? 'portal' : 'rss', name: '', type: 'tender', config: '{}', interval_minutes: 360, credential_id: null };
    let next;
    try {
      next = await readForm(req, base);
      if (!next.name) throw new Error('Give the source a name.');
    } catch (err) {
      return editPage(req, res, { ...base, name: req.body.name || base.name, config: JSON.stringify(req.body) }, { status: 400, error: err.message });
    }
    if (req.body.action === 'test') {
      try {
        const preview = await testSource(db, next);
        return editPage(req, res, next, { preview });
      } catch (err) {
        return editPage(req, res, next, { status: 400, error: `Test failed: ${err.message}` });
      }
    }
    if (existing) {
      db.prepare('UPDATE sources SET name = ?, type = ?, config = ?, credential_id = ?, interval_minutes = ?, next_run_at = NULL WHERE key = ?')
        .run(next.name, next.type, next.config, next.credential_id, next.interval_minutes, existing.key);
    } else {
      next.key = `custom-${next.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}-${crypto.randomBytes(2).toString('hex')}`;
      db.prepare('INSERT INTO sources (key, name, kind, type, config, credential_id, interval_minutes, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
        .run(next.key, next.name, next.kind, next.type, next.config, next.credential_id, next.interval_minutes);
    }
    audit(req, existing ? 'source.updated' : 'source.created', next.key);
    flash(req, `${next.name} saved. It will run within a minute.`);
    res.redirect('/admin');
  }
  app.post('/admin/sources', guard, saveSource);
  app.post('/admin/sources/:key', guard, saveSource);

  app.post('/admin/sources/:key/delete', guard, (req, res) => {
    const source = getSource(req.params.key);
    if (source && source.kind !== 'builtin') {
      db.transaction(() => {
        db.prepare('DELETE FROM opportunities WHERE source_key = ?').run(source.key);
        db.prepare('DELETE FROM sources WHERE key = ?').run(source.key);
      })();
      audit(req, 'source.deleted', source.key);
      flash(req, `${source.name} and its opportunities were removed.`);
    }
    res.redirect('/admin');
  });

  // --- Credential vault -------------------------------------------------------

  app.post('/admin/credentials', guard, (req, res) => {
    const b = req.body;
    const name = String(b.name || '').trim().slice(0, 120);
    const kind = ['login', 'api-key', 'header'].includes(b.kind) ? b.kind : 'login';
    const secret = kind === 'login' ? { username: String(b.username || ''), password: String(b.password || '') }
      : kind === 'api-key' ? { key: String(b.key || '').trim() }
      : { header: String(b.header || '').trim(), value: String(b.value || '') };
    const complete = name && Object.values(secret).every(Boolean) && (kind !== 'header' || /^[A-Za-z0-9-]+$/.test(secret.header));
    if (!complete) flash(req, 'Fill in a name and every field for the credential.');
    else if (db.prepare('SELECT 1 FROM credentials WHERE name = ?').get(name)) flash(req, 'A credential with that name already exists.');
    else {
      saveCredential(db, { name, kind, secret });
      audit(req, 'credential.created', name);
      flash(req, `Credential "${name}" stored, encrypted. It cannot be viewed again, only replaced.`);
    }
    res.redirect('/admin#credentials');
  });

  app.post('/admin/credentials/:id/delete', guard, (req, res) => {
    const row = db.prepare('SELECT name FROM credentials WHERE id = ?').get(Number(req.params.id));
    if (row) {
      db.prepare('DELETE FROM credentials WHERE id = ?').run(Number(req.params.id));
      audit(req, 'credential.deleted', row.name);
      flash(req, `Credential "${row.name}" deleted.`);
    }
    res.redirect('/admin#credentials');
  });

  app.post('/admin/orgs/:id/plan', guard, (req, res) => {
    if (['trial', 'solo', 'hub', 'suspended'].includes(req.body.plan)) {
      db.prepare('UPDATE orgs SET plan = ? WHERE id = ?').run(req.body.plan, Number(req.params.id));
      audit(req, 'org.plan', `${req.params.id} ${req.body.plan}`);
    }
    res.redirect('/admin');
  });
}
