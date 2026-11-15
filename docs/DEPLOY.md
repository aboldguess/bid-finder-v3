# Deploying on your own domain

This takes about fifteen minutes. You need a domain name and a small Linux server. One CPU and 1 GB of memory is plenty.

## 1. Get a server and a domain

1. Rent a server (any provider) running a current Ubuntu or Debian, and note its public IP address.
2. Buy a domain, or pick a subdomain of one you own, for example `bids.example.co.uk`.
3. At your DNS provider, add an `A` record for that name pointing at the server's IP address (and an `AAAA` record if the server has IPv6).
4. Make sure ports 80 and 443 are open in the server's firewall. Port 80 is needed for the certificate and to redirect visitors to HTTPS.

## 2. Install Docker

Follow [Docker's instructions](https://docs.docker.com/engine/install/) for your distribution. The Compose plugin comes with it.

## 3. Start Bid Finder

```bash
git clone https://github.com/aboldguess/bid-finder-v3.git
cd bid-finder-v3
./scripts/setup.sh --domain bids.example.co.uk
```

The script writes `.env` with three generated secrets, builds the image and starts two containers:

- `app`: Bid Finder, running as a non-root user on a read-only filesystem, with its data in the `data` volume.
- `caddy`: the reverse proxy. It obtains a Let's Encrypt certificate for your domain, renews it, redirects HTTP to HTTPS and keeps `/metrics` off the internet.

Open `https://bids.example.co.uk` and register. **The first account is the administrator.** After that, sign-up is closed and colleagues join through invite links from the Team page.

Keep a copy of `.env` somewhere safe. `BIDFINDER_SECRET_KEY` encrypts the portal logins and API keys you store; without it they cannot be read and must be entered again.

## 4. Set up email

Alerts and digests need an SMTP account. Any provider works. Add to `.env`:

```
SMTP_URL=smtps://user:password@smtp.example.com:465
MAIL_FROM=Bid Finder <alerts@example.co.uk>
```

Then `docker compose up -d`. Until email is set up, alerts still reach Slack and webhooks, and digests can be read in the app.

## 5. Make it yours

1. **Profile.** Pick the engineering disciplines that describe your firm, then adjust the keywords, CPV codes, countries and value range. This drives every score.
2. **Sources.** Under Admin, switch on TED if you bid in the EU, and SAM.gov if you bid in the US (it needs a free API key; see [CONNECTORS.md](CONNECTORS.md)). Add your private supplier portals.
3. **Saved searches.** Save a search for each kind of work you chase, and choose where its alerts go.

## Day to day

```bash
docker compose logs -f app                  # watch what it is doing
docker compose exec app bidfinder sources   # last run of each source
docker compose exec app bidfinder ingest    # fetch everything now
docker compose exec app bidfinder reset-password you@example.co.uk
```

## Updating

```bash
git pull
docker compose up -d --build
```

The database is upgraded automatically on start. A backup is taken every night; take one by hand before an update with `docker compose exec app bidfinder backup`.

## Variations

**Behind your own reverse proxy.** Skip Caddy and run the app alone: `docker build -t bid-finder . && docker run -d -p 127.0.0.1:3000:3000 -v bidfinder:/data --env-file .env bid-finder`. Set `BASE_URL=https://your-domain` so cookies are marked secure, and `TRUST_PROXY` to the proxy's address so client addresses are logged correctly. Do not forward `/metrics`.

**On your office network only.** No domain is needed. Run `bidfinder serve` on any machine (see the README) and use the network address it prints.

**A different port inside Docker.** The container always listens on 3000. Change the published side, for example `-p 8080:3000`.

## If something is wrong

- **The browser warns about the certificate.** DNS has not reached the server yet, or ports 80 and 443 are closed. `docker compose logs caddy` says which.
- **`Set DOMAIN in .env`.** Run `./scripts/setup.sh`, or add `DOMAIN=your-domain` to `.env`.
- **A source shows an error.** The Admin page shows the message and the recent runs. See [OPERATIONS.md](OPERATIONS.md).
