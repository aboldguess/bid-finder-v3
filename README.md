# Bid Finder

Public funding and contract opportunities for UK SMEs, and for the business-support hubs (LEPs, growth hubs, Catapults, trade associations) that collate them for their members.

Every day Bid Finder reads the main UK sources, scores each opportunity against an organisation's profile, explains the score in plain English, and sends a ranked email digest. It runs comfortably on a Raspberry Pi with no external services.

## What it does

- **Sources:** Find a Grant (GOV.UK), Innovate UK competitions, UKRI Funding Finder and Contracts Finder, refreshed daily and de-duplicated.
- **Fit scoring:** keywords (title matches count most), exclusions, region, applicant type, award size and deadline. Every score comes with its reasons.
- **Triage:** shortlist (star), hide, team notes and full-text search.
- **Digests:** daily or weekly email of new matches. Digests are also kept in the app, so it works before email is set up.
- **Shared shortlist:** an organisation can publish its shortlist as a read-only public page. This is the first hub feature: curate once, share the link with members.
- **Multi-tenant:** each organisation (company or hub) has its own profile, triage state and plan. The first account on a fresh install is the platform admin, who can refresh sources and set plans.

## Install on a Raspberry Pi

Needs Raspberry Pi OS 64-bit (or any Debian/Ubuntu) and a network connection.

```bash
git clone https://github.com/aboldguess/bid-finder-v3.git
cd bid-finder-v3
./scripts/install-pi.sh
```

That installs Node.js 22 if needed, installs dependencies and starts a `bidfinder` systemd service on port 3000. Open `http://<pi-address>:3000`, register, and you are the admin. The first fetch from every source starts automatically.

Settings live in `.env` (see `.env.example`). They're all optional. The main ones are `SMTP_URL` and `MAIL_FROM` to send emails, and `BASE_URL` for links in emails. When serving over HTTPS, for example behind Caddy or a Cloudflare Tunnel, set `SECURE_COOKIES=true`.

## Run it anywhere else

```bash
npm install
npm start               # web app + daily schedule, http://localhost:3000
npm run ingest          # fetch every source now (or: npm run ingest -- ukri)
npm run digest          # build and send due digests now
npm test
```

Data (the SQLite database and a generated session secret) is kept in `./data`, or wherever `DATA_DIR` points. Back that folder up.

## How it fits together

```
src/
  connectors/   one file per source: fetch pages, return normalised opportunities
  ingest/       runs connectors one at a time and upserts into SQLite
  match/        fit scoring and the per-organisation ranked feed
  notify/       email digests
  web/          Express app, EJS views, CSS
  db/           schema (SQLite with FTS5 full-text search)
```

To add a source, write a connector exporting `{ key, name, type, fetch() }` with a `parsePage()` that a fixture test can exercise, then add it to `src/connectors/index.js`.

## Notes on sources

Find a Grant, Innovate UK and UKRI have no public API, so their connectors read the public listing pages. They use label-based parsing ("Closing date", "How much you can get", and so on) rather than brittle CSS classes, but a site redesign can still break one. The admin page shows each source's last run and any error.

## Roadmap

- **Phase 2:** hub bulletins (curated email to a member list), team invites, a pipeline board (qualifying, bidding, submitted, won or lost), plan limits and billing.
- **Backlog:** AI summaries and fit explanations, Find a Tender and TED, Horizon Europe, a re-tender radar from award data.
