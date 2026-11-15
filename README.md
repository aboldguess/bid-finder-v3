# Bid Finder

Finds tenders and grants that fit your firm, so you stop trawling portals.

Bid Finder watches public procurement portals and your private supplier portals, folds copies of the same notice together, scores every opportunity against your firm's profile, explains the score, and tells you by email, Slack or webhook when something worth bidding for appears. It is self-hosted: one small container and a SQLite file, with no external services.

It was built for a small engineering company, and the defaults reflect that: profile presets for engineering disciplines, CPV code matching and UK sources switched on from the start.

## What you get

- **Sources.** Find a Tender, Contracts Finder, Public Contracts Scotland, TED (EU), SAM.gov (US), Find a Grant and UKRI, with Sell2Wales and Innovate UK ready for when their sites allow it. Official APIs are used wherever one exists, and every source is checked against the live service weekly. See [docs/CONNECTORS.md](docs/CONNECTORS.md).
- **Your own portals.** Add any RSS or Atom feed, or any listing page, from the Admin screen with no code. Portals behind a login work too; their passwords and API keys are encrypted at rest.
- **One notice, shown once.** The same tender on three portals appears as one entry that links to the others.
- **Fit scoring.** Keywords, CPV codes, countries, regions, contract value and deadline. Every score lists its reasons.
- **Saved searches and alerts.** Instant, daily or weekly, to email, Slack or any webhook.
- **Pipeline.** Shortlist, hide, add notes and move bids through qualifying, bidding, submitted, won, lost and no bid.
- **Team.** Invite colleagues by link. Sign-up is closed after the first account unless you open it.
- **API.** A read and triage API with bearer tokens, described at `/api/docs`.
- **Operations.** Health and readiness checks, Prometheus metrics, structured logs, an audit trail, nightly backups.

## Try it in two minutes

Needs Node.js 22 or later.

```bash
git clone https://github.com/aboldguess/bid-finder-v3.git
cd bid-finder-v3
npm install
npm run demo
```

The demo loads sample tenders into a separate `data-demo` folder and prints the address and a sign-in. It fetches nothing from the internet.

## Run it for real

```bash
npm install
npm link            # optional: makes the `bidfinder` command available everywhere
bidfinder serve     # or: npm start
```

Open the address it prints and register. The first account is the administrator, and the first fetch from every enabled source starts within a minute. Then fill in your profile, which is what the scoring works from.

### Choosing the port and who can connect

```bash
bidfinder serve --port 8080     # listen on port 8080 (default 3000, or PORT in .env)
bidfinder serve --lan           # reachable from other devices on your network (the default)
bidfinder serve --local         # this machine only
bidfinder serve --host 192.168.1.20   # one specific network address
bidfinder serve --strict-port   # fail if the port is busy
```

If the port is already in use, Bid Finder moves to the next free one (3000, then 3001, and so on, up to 20 tries) and prints the address it ended up on. Pass `--strict-port` if you would rather it stopped with an error, which is what you want behind a reverse proxy.

On start it prints every address you can use:

```
Bid Finder 4.0.0 is running at http://localhost:3000
On your network: http://192.168.1.20:3000
```

Other devices on your network use the second address. If they cannot connect, allow the port through the machine's firewall. Without `npm link`, use `npm start -- --port 8080 --local`, or `node src/cli.js serve --port 8080`.

### The command line

| Command | What it does |
| --- | --- |
| `bidfinder serve` | Start the web app and the background scheduler |
| `bidfinder ingest [source]` | Fetch every enabled source now, or just one, for example `bidfinder ingest find-a-tender` |
| `bidfinder alerts` | Send saved-search alerts that are due |
| `bidfinder digest` | Build and send the digests that are due |
| `bidfinder sources` | List sources with the result of their last run |
| `bidfinder backup` | Back up the database into the data folder |
| `bidfinder reset-password <email>` | Set a new random password for a user and print it |
| `bidfinder version` | Print the version |
| `bidfinder help` | Show all commands and options |

Settings are read from the environment or a `.env` file in the current folder. Every one is optional; [.env.example](.env.example) lists them. The ones you are most likely to want are `SMTP_URL` and `MAIL_FROM` for email, and `BASE_URL` for the links in emails.

## Put it on your own domain

On any server with Docker:

```bash
git clone https://github.com/aboldguess/bid-finder-v3.git
cd bid-finder-v3
./scripts/setup.sh --domain bids.example.co.uk
```

That generates the secrets, builds the image and starts Bid Finder behind Caddy, which obtains and renews the HTTPS certificate by itself. [docs/DEPLOY.md](docs/DEPLOY.md) walks through it from buying the domain onwards.

For a Raspberry Pi or other small Linux box without Docker, `./scripts/install-pi.sh [--port 3001]` installs Node.js and runs Bid Finder as a systemd service.

## Documentation

- [docs/DEPLOY.md](docs/DEPLOY.md): domain, DNS, HTTPS, email, updating.
- [docs/CONNECTORS.md](docs/CONNECTORS.md): every source, how politely each is fetched, private portals, writing a connector.
- [docs/OPERATIONS.md](docs/OPERATIONS.md): backups and restore, monitoring, security, troubleshooting.
- `/api/docs` in the running app: the API.

## How it fits together

```
src/
  cli.js        the bidfinder command
  server.js     starts the web app and scheduler; listen.js picks the port
  connectors/   one file per source, plus the generic feed and portal connectors
  http/         the one outbound HTTP client: throttling, retries, robots.txt, private-network guard
  ingest/       runs connectors, normalises, de-duplicates across sources
  match/        fit scoring, engineering presets, the ranked feed
  notify/       alerts, digests, email, Slack and webhook channels
  secrets/      the encrypted credential vault
  web/          Express app, EJS views, API
  db/           SQLite schema and migrations
```

## Development

```bash
npm test        # node:test; connectors are tested against recorded fixtures
npm run lint
```

CI runs the linter, the tests, a dependency audit and a Docker build on every pull request. A separate workflow checks every source against the live portals each week (`npm run check:sources` runs it locally).
