# Operations

## Where the data is

Everything lives in one folder: `./data` when run directly, the `data` volume (`/data` in the container) under Docker, or wherever `DATA_DIR` points.

- `bidfinder.db`: the SQLite database.
- `backups/`: nightly backups.
- `session-secret`, `secret-key`: generated on first run only if `SESSION_SECRET` and `BIDFINDER_SECRET_KEY` are not set. `scripts/setup.sh` sets both in `.env`, which keeps the encryption key out of the data folder and so out of its backups.

## Backups and restore

A consistent backup is taken every night (03:15 by default, `MAINTENANCE_CRON`) into `backups/bidfinder-YYYY-MM-DD.db`, and the newest seven are kept (`BACKUPS_TO_KEEP`). Take one at any time with `bidfinder backup`.

Those backups sit on the same disk, so copy them elsewhere. For example, from the host each night:

```bash
docker compose cp app:/data/backups ./bidfinder-backups
```

To restore, stop the app, put the backup in place of the database, and start again:

```bash
docker compose stop app
docker compose run --rm --no-deps app sh -c 'cp /data/backups/bidfinder-2026-11-14.db /data/bidfinder.db && rm -f /data/bidfinder.db-wal /data/bidfinder.db-shm'
docker compose start app
```

Stored portal logins can only be read with the `BIDFINDER_SECRET_KEY` that encrypted them, so keep `.env` with your backups' owner, not in the same place as the backups.

## Housekeeping

The nightly job also removes opportunities that closed more than `RETENTION_DAYS` (180) ago, unless someone shortlisted them, wrote a note or put them in the pipeline. Run history is kept for 60 days, alert history for 180 and the audit trail for a year.

## Monitoring

| Endpoint | Use |
| --- | --- |
| `/healthz` | The process is up. For liveness checks. |
| `/readyz` | The database answers and the scheduler is ticking. Returns 503 otherwise. Docker's health check uses this. |
| `/metrics` | Prometheus text format: requests by status, open opportunities per source, whether each source is on, when it last ran and whether that run succeeded, run and alert counts by outcome, users, uptime and version. |

`/metrics` answers only requests carrying `Authorization: Bearer <METRICS_TOKEN>`, or, when no token is set, requests from this machine or a private network address. The bundled Caddy configuration does not serve it to the internet at all; scrape the app container directly from your monitoring network.

Worth alerting on: `/readyz` failing, and `bidfinder_source_last_run_success` at 0 for an enabled source.

Logs go to standard output, one JSON object per line in production (`LOG_FORMAT=json`), each request with an id that is also returned in the `X-Request-Id` header. Set `LOG_LEVEL=debug` to see retries.

## Security

- **Accounts.** Passwords are hashed with bcrypt. Sessions are server-side, in HttpOnly, SameSite cookies that are marked Secure whenever `BASE_URL` is https. Repeated failed sign-ins are blocked for 15 minutes. Changing a password signs out every other session.
- **Sign-up.** Open for the first account only, which becomes the administrator. Others join by single-use invite link that expires, or are created on the server with `bidfinder create-user`. Set `ALLOW_REGISTRATION=true` to let anyone create their own organisation. Hosted mode (`HOSTED=true` or `bidfinder serve --hosted`) is for running one server for many customers: sign-up is always open, each new person must tick that they accept the terms (`/terms`) and privacy notice (`/privacy`), and when they did is stored on their account.
- **Private sources.** A custom RSS feed or portal can be made private to one organisation ("Who sees its results" on its settings page). Only that organisation sees its name, its results, alerts and digests about them, in the web app and the API; to everyone else they look like they do not exist. Credentials can belong to one organisation too, and can then only be attached to that organisation's private sources. Built-in sources are always shared. An organisation that still owns a private source cannot be deleted until the source is.
- **Email links.** Forgotten passwords are reset from the sign-in page by a link that works once, for one hour, and signs out every other device; without `SMTP_URL` the page tells people to ask the administrator (`bidfinder reset-password`). In hosted mode new accounts must also confirm their email (a 48-hour link, which can be re-sent from a banner); until someone in an organisation has, it gets no digests or alerts. Self-hosted accounts, and every account that existed before this upgrade, count as confirmed.
- **Abuse limits on the account forms.** Per address: 30 failed sign-ins in 15 minutes (on top of 10 per email and address), 10 sign-up attempts an hour and 5 new accounts a day. Over a limit the page answers 429 with a Retry-After header. Sign-up also has a hidden honeypot field and rejects forms sent less than `SIGNUP_MIN_SECONDS` (3) after they were shown. Blocked attempts are written to the audit log as `signup.limited` and `signup.bot`. The counters live in memory, so a restart clears them. Behind a proxy, set `TRUST_PROXY` correctly or every visitor shares the proxy's address. `bidfinder promote` and `bidfinder demote` change who is an administrator; the last one cannot be demoted.
- **Forms** carry anti-forgery tokens, and pages are served with a strict Content-Security-Policy and HSTS.
- **API tokens** are shown once and stored only as a hash. Each is limited to 120 requests a minute and can be revoked on the Account page.
- **Stored secrets** (portal logins, API keys, Slack and webhook addresses) are encrypted with AES-256-GCM.
- **Outbound requests** to sources and webhooks you add are refused if they resolve to a private or local address.
- **Audit trail.** Failed sign-ins, password changes, source and credential changes, saved searches, invites and API tokens are recorded and shown on the Admin page.
- **Container.** Runs as a non-root user with a read-only root filesystem and no privilege escalation.

To rotate `SESSION_SECRET`, change it and restart; everyone is signed out. `BIDFINDER_SECRET_KEY` cannot be rotated in place: after changing it, enter stored credentials and alert webhooks again.

If you are locked out, `bidfinder reset-password you@example.co.uk` prints a new password.

## Troubleshooting

**A source shows an error.** The Admin page shows the message and the last 25 runs. Run it by hand to see more: `LOG_LEVEL=debug bidfinder ingest <key>`.

- `HTTP 429` or `503`: the portal is asking for fewer requests. It is retried automatically; if it persists, lengthen the source's interval.
- `robots.txt at ... disallows ...`: the site does not permit automated reading of that page. Use a feed or API if the portal has one.
- `... points at a private network address`: the address resolves inside your own network, which custom sources may not reach.
- A listing-page source that finds nothing after a site redesign needs its selectors updating; "Test" shows what they match.

**No emails arrive.** Check `SMTP_URL` and `MAIL_FROM`, then the alert history on the saved search, which records each attempt and its error.

**The port changed.** When the requested port is busy, `bidfinder serve` takes the next free one and says so in its first log lines. Use `--strict-port` to make that an error instead.

**Nothing matches.** A new profile has no keywords. Fill in the profile, or lower the minimum score on it; the "All" view shows everything regardless of score.

## Scale

SQLite in WAL mode on one server comfortably handles hundreds of thousands of opportunities and a team of users, which is far more than one firm needs. Run a single app container: the scheduler lives inside it, and two would fetch every source twice.
