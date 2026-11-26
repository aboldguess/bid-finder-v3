# Running hosted Bid Finder on a Raspberry Pi

This puts the paid, hosted Bid Finder on a Raspberry Pi 5 at home, at your own web address, with HTTPS and without opening any ports on your router. It takes about an hour, most of it waiting for installs.

What you end up with:

- **Two services** that start on boot and restart if they crash:
  - `bidfinder-web`, the website;
  - `bidfinder-worker`, which fetches the portals and sends alerts and digests.

  Slow fetching never holds up the website.
- **Your address** (`https://bids.example.co.uk`) reaches the Pi through a **Cloudflare Tunnel**. Your home IP stays hidden and nothing on your router changes.
- **`/admin`** sits behind **Cloudflare Access**, so only your email address can open it, on top of the admin login.
- **Email that reaches inboxes.** It's sent through Resend and signed for your domain, and the installer adds the DNS records for you.
- **A nightly backup** at 04:15. It's checked for damage, kept for 14 days on the Pi, and optionally kept for 60 days in Google Drive.
- **Alerts** if the site goes down, or if a night's backup doesn't happen.

You need:

- the Pi on your home network, ideally booting from an SSD rather than an SD card;
- a Cloudflare account (free) and a domain (about £10 a year);
- a free Resend account;
- a free UptimeRobot account.

Healthchecks.io and Google Drive are optional extras.

Type the commands below into a terminal on the Pi, or over SSH. Lines starting with `#` are comments.

## Why email goes through Resend

A Pi on a home connection can't send email straight to people's inboxes. Home IP addresses are on the spam blocklists every mail provider checks (Spamhaus PBL). Most ISPs block outgoing port 25. And your IP has no matching reverse DNS. Mail sent directly would bounce or land in spam.

Instead, Bid Finder hands each message to Resend over an encrypted connection. Resend sends it from servers with a good reputation, signed with your domain's DKIM key. The free plan covers 3,000 emails a month (100 a day). The next plan up is about £16 a month for 50,000.

---

## 1. Prepare the Pi (10 min)

Use **Raspberry Pi OS Lite (64-bit)**.

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y git curl unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades   # answer Yes
```

## 2. Buy a domain and add it to Cloudflare (10 min)

The simplest place to buy is **Cloudflare Registrar** (Domain Registration → Register Domains), at cost price. If you bought the domain elsewhere, choose **Add a domain** in Cloudflare, pick the Free plan, and switch the nameservers at your registrar.

You can use the whole domain or a subdomain such as `bids.example.co.uk`.

## 3. Get the keys for email (5 min)

1. Sign up at [resend.com](https://resend.com) and create an **API key** with **Full access** ([API keys](https://resend.com/api-keys)). Full access lets the installer add your domain. Copy the key; it starts with `re_`.
2. In Cloudflare, go to **My Profile → API Tokens → Create Token** and use the **Edit zone DNS** template. Under Zone Resources, pick your domain. Copy the token.

The installer asks for both. The Cloudflare token is used once, to add the DNS records, and is not stored.

## 4. Install Bid Finder (15 min)

```bash
cd ~
git clone https://github.com/aboldguess/bid-finder-v3.git
cd bid-finder-v3
sudo ./deploy/pi/install.sh --domain bids.example.co.uk
```

If the repository is private, GitHub asks you to sign in. Use your username and a [personal access token](https://github.com/settings/tokens?type=beta) with read access.

The installer:

- installs Node.js 22 and the packages Bid Finder needs;
- creates `/etc/bidfinder.env` with your domain, hosted mode switched on, and new random secrets. **Keep a copy of this file in your password manager**, separate from the backups. `BIDFINDER_SECRET_KEY` unlocks stored portal logins. View it with `sudo cat /etc/bidfinder.env`;
- picks the port: 3000, or the next free one if something else already uses 3000. To choose it yourself, add `--port 3005`. It prints the port at the end;
- asks for the two email keys (typing doesn't show). It then adds your domain to Resend, puts the SPF, DKIM, bounce and DMARC records into Cloudflare, and asks Resend to verify them. Resend emails you when the domain is verified, usually within a few minutes. Press Enter at the prompt to skip, and run it later (see below);
- installs and starts the web app, the worker and the backup timer, then checks that Bid Finder answers.

The website listens on the Pi only (`HOST=127.0.0.1`). The tunnel reaches it from there.

## 5. Connect the Cloudflare Tunnel (10 min)

1. In the Cloudflare dashboard, open **Zero Trust**. Pick a team name and the **Free** plan.
2. Go to **Networks → Tunnels → Create a tunnel → Cloudflared**, and name it `bidfinder-pi`.
3. Choose **Debian** and **arm64**, and run the commands it shows on the Pi. The last one (`sudo cloudflared service install eyJ...`) makes the tunnel start on boot.
4. Add a **public hostname**: your (sub)domain, with service **HTTP** and URL `localhost:3000`. Use the port the installer printed.
5. Open `https://bids.example.co.uk` on your phone, off Wi-Fi.

Behind the tunnel, each visitor's real address arrives in the `CF-Connecting-IP` header. `/etc/bidfinder.env` already tells Bid Finder to use it for rate limits and logs. It only trusts that header from cloudflared on the Pi itself, so nobody else can fake it.

## 6. Create your administrator account (2 min)

```bash
~/bid-finder-v3/deploy/pi/bidfinder create-user you@example.co.uk --org "Your Company" --admin
```

This prints a password. Sign in and change it under **Account**. Your organisation is free ("comped"). Customers who sign up get the 14-day trial.

## 7. Lock `/admin` with Cloudflare Access (5 min)

1. Go to **Zero Trust → Access → Applications → Add an application → Self-hosted**.
2. Name it `Bid Finder admin` and set the session duration to 1 month.
3. Add a public hostname: your domain, with path `admin`.
4. Add a policy named `Phil only`: action **Allow**, include **Emails** = your address. Leave the One-time PIN login on.
5. Check that `https://bids.example.co.uk/admin` asks for a code in a private window, and that the home page doesn't.

## 8. Card payments (10 min)

Follow "Card payments" in [docs/OPERATIONS.md](../../docs/OPERATIONS.md). The webhook address is `https://bids.example.co.uk/stripe/webhook`. Put the keys in `/etc/bidfinder.env`, then run `sudo systemctl restart bidfinder-web bidfinder-worker`.

## 9. Uptime alert (5 min)

In [UptimeRobot](https://uptimerobot.com), go to **Add New Monitor → HTTP(s)** and enter `https://bids.example.co.uk/readyz`. This page is checked through the public address, so it tests the whole chain:

- the Pi;
- the web app;
- whether the worker is still running;
- the database;
- your internet connection;
- the tunnel.

To test the alert, run `sudo systemctl stop bidfinder-web`, wait for the email, then run `sudo systemctl start bidfinder-web`.

## 10. Backups

The backup runs every night at 04:15, or straight after boot if the Pi was off at that time. It takes a consistent snapshot while the site keeps running, checks it for damage, and keeps 14 days of copies in `/var/lib/bidfinder/backups`.

```bash
sudo systemctl start bidfinder-backup        # run one now
journalctl -u bidfinder-backup -n 20         # what happened
```

**Offsite copy (recommended).** Copies on the Pi don't help if its disk dies.

```bash
sudo apt install -y rclone
rclone config            # n → name: gdrive → storage: drive → defaults; authorise in a browser when asked
rclone mkdir gdrive:bidfinder-backups
```

Then set `BACKUP_RCLONE_REMOTE=gdrive:bidfinder-backups` in `/etc/bidfinder.env` and run a backup by hand to check that it lands. Compressed copies are kept for 60 days (`BACKUP_OFFSITE_DAYS`).

**Missed-backup alert.** Create a check at [Healthchecks.io](https://healthchecks.io) with a period of 1 day and a grace of 2 hours. Put its ping URL in `BACKUP_PING_URL`. Each backup reports success, or the error message.

**Restoring:**

```bash
sudo systemctl stop bidfinder-web bidfinder-worker
cd /var/lib/bidfinder
sudo mv bidfinder.db bidfinder.db.broken && sudo rm -f bidfinder.db-wal bidfinder.db-shm
sudo cp backups/bidfinder-2026-11-25.db bidfinder.db && sudo chown $USER: bidfinder.db
sudo systemctl start bidfinder-worker bidfinder-web
```

To restore from Drive, first run `rclone copy gdrive:bidfinder-backups/bidfinder-2026-11-25.db.gz .` and then `gunzip` it.

---

## Day to day

| What | Command |
| --- | --- |
| Is it running? | `systemctl status bidfinder-web bidfinder-worker` |
| Live logs | `journalctl -u bidfinder-web -u bidfinder-worker -f` |
| Restart | `sudo systemctl restart bidfinder-web bidfinder-worker` |
| Change settings | `sudo nano /etc/bidfinder.env`, then restart |
| Update to the latest code | `cd ~/bid-finder-v3 && ./deploy/pi/update.sh` (backs up first) |
| Any `bidfinder` command | `~/bid-finder-v3/deploy/pi/bidfinder users --orgs` |
| Set up email later or again | `sudo RESEND_API_KEY=re_... CLOUDFLARE_API_TOKEN=... node deploy/pi/setup-mail.js --domain bids.example.co.uk` |

## Things worth knowing

- **Power cuts.** The Pi, both services and the tunnel all start on their own. At most the last few seconds of writes are lost.
- **Home internet drops.** The tunnel reconnects by itself. Alerts that couldn't be sent go out on the next run.
- **Capacity.** A Pi 5 comfortably serves a few hundred customers. The heavy part (scoring for alerts) only looks at new notices.
- **Files this sets up:**
  - `/etc/bidfinder.env` holds the settings and secrets, and is not in git;
  - the units in `/etc/systemd/system/bidfinder-*`;
  - the database and backups in `/var/lib/bidfinder/`.
