// First-run set-up: from sign-up to a ranked feed in a couple of minutes.
// Pick the kinds of work you do, see live how many open opportunities match,
// and save. Everything can be refined later on the profile page.
import { VISIBLE } from '../../match/visibility.js';
import { getFeed, getProfile } from '../../match/feed.js';
import { mergePresets, presets } from '../../match/presets.js';
import { cpvPrefix, splitList } from '../../match/score.js';
import { recheckSearches } from '../../notify/alerts.js';

const asList = (v) => [].concat(v ?? []).flatMap((x) => String(x).split(','));
const COUNTRY = /^[A-Z]{2}$/;

// The profile the welcome form describes, on top of what is already saved.
export function draftProfile(saved, body) {
  const ids = asList(body.presets).map((s) => s.trim()).filter((id) => presets.some((p) => p.id === id));
  const extra = splitList(String(body.keywords || '')).slice(0, 50).join('\n');
  const merged = mergePresets(ids, {
    keywords: [saved.keywords, extra].filter(Boolean).join('\n'),
    cpv_codes: saved.cpv_codes,
  });
  const types = ['tender', 'grant'].filter((t) => asList(body.types).includes(t));
  const countries = asList(body.countries).map((c) => c.trim().toUpperCase()).filter((c) => COUNTRY.test(c));
  return {
    ...saved,
    keywords: merged.keywords,
    cpv_codes: splitList(merged.cpv_codes).map(cpvPrefix).filter((p) => /^\d{2,8}$/.test(p)).join('\n'),
    types: (types.length ? types : ['tender', 'grant']).join('\n'),
    countries: countries.join('\n'),
    presets: ids,
  };
}

export function welcomeRoutes(app, ctx) {
  const { db, flash, requireUser } = ctx;

  app.get('/welcome', requireUser, (req, res) => {
    // Only what this organisation may see: another customer's private sources never add to the count.
    const total = db.prepare(`SELECT COUNT(*) AS n FROM opportunities o WHERE o.duplicate_of IS NULL AND (o.closes_at IS NULL OR o.closes_at > ?) AND ${VISIBLE}`).get(new Date().toISOString(), req.org.id).n;
    res.render('welcome', { presets, profile: getProfile(db, req.org.id), total });
  });

  // Live preview while choosing: how many open opportunities would match, and the best few.
  app.get('/welcome/preview', requireUser, (req, res) => {
    const profile = draftProfile(getProfile(db, req.org.id), req.query);
    const empty = !profile.keywords && !profile.cpv_codes;
    const feed = getFeed(db, req.org.id, { view: 'matches', sort: 'score', limit: 5, profile });
    res.json({
      total: empty ? 0 : feed.total,
      top: empty ? [] : feed.items.map((o) => ({ id: o.id, title: o.title, buyer: o.buyer, closes_at: o.closes_at, score: o.match.score })),
    });
  });

  app.post('/welcome', requireUser, (req, res) => {
    const draft = draftProfile(getProfile(db, req.org.id), req.body);
    if (!draft.keywords && !draft.cpv_codes) {
      flash(req, 'Pick at least one kind of work, or type a few words that describe it.');
      return res.redirect('/welcome');
    }
    db.prepare(`
      UPDATE profiles SET keywords = ?, cpv_codes = ?, types = ?, countries = ?,
        digest_frequency = COALESCE(NULLIF(digest_frequency, ''), 'daily'),
        digest_emails = CASE WHEN digest_emails = '' OR digest_emails IS NULL THEN ? ELSE digest_emails END,
        updated_at = datetime('now')
      WHERE org_id = ?
    `).run(draft.keywords, draft.cpv_codes, draft.types, draft.countries, req.user.email, req.org.id);
    recheckSearches(db, { orgId: req.org.id });
    const { total } = getFeed(db, req.org.id, { view: 'matches', limit: 0 });
    ctx.audit(req, 'onboarding', `${draft.presets.join(', ') || 'own keywords'}; ${total} matches`);
    flash(req, `Your feed is ready: ${total.toLocaleString('en-GB')} open ${total === 1 ? 'opportunity matches' : 'opportunities match'}, best first. A daily email of new matches goes to ${req.user.email}. Fine-tune it any time on the Profile page.`);
    res.redirect('/feed');
  });
}
