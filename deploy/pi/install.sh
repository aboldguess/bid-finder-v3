#!/usr/bin/env bash
# One-time setup of hosted Bid Finder on a Raspberry Pi 5 (or any Debian/Ubuntu
# box) behind a Cloudflare Tunnel. Installs Node.js if needed, the web app and
# worker as services that start on boot, the nightly backup, and (with a Resend
# key) outgoing email with its DNS records. Safe to run again: an existing
# /etc/bidfinder.env is kept.
#
#   cd ~/bid-finder-v3 && sudo ./deploy/pi/install.sh --domain bids.example.co.uk
#
# Options
#   --domain <name>     Your public address (asked for if not given)
#   -p, --port <n>      Port on the Pi for the tunnel to reach (default: 3000, or the
#                       next free one if 3000 is taken). Kept in /etc/bidfinder.env.
#   --no-mail           Skip the email step
#
# For email it asks for a Resend API key and a Cloudflare API token (or reads
# RESEND_API_KEY and CLOUDFLARE_API_TOKEN). Neither is stored except the
# Resend key, inside SMTP_URL in /etc/bidfinder.env.
set -euo pipefail

DOMAIN="" PORT_ARG="" MAIL=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --domain=*) DOMAIN="${1#*=}"; shift ;;
    --port|-port|-p) PORT_ARG="${2:-}"; shift 2 ;;
    --port=*|-port=*) PORT_ARG="${1#*=}"; shift ;;
    --no-mail) MAIL=0; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 1 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then echo "Run with sudo: sudo ./deploy/pi/install.sh"; exit 1; fi
APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_USER="${SUDO_USER:-$(stat -c %U "$APP_DIR")}"
[[ "$RUN_USER" == root ]] && { echo "Run this from your normal account with sudo, not as root."; exit 1; }
ENV_FILE=/etc/bidfinder.env

if [[ -n "$PORT_ARG" ]] && ! [[ "$PORT_ARG" =~ ^[0-9]+$ && "$PORT_ARG" -ge 1 && "$PORT_ARG" -le 65535 ]]; then
  echo "Port must be a number from 1 to 65535, got: $PORT_ARG" >&2; exit 1
fi

echo "==> Node.js"
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  apt-get update -q
  apt-get install -y -q ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi
[[ "$(command -v node)" == /usr/bin/node ]] || { echo "Expected node at /usr/bin/node (found $(command -v node)). Install Node from NodeSource, not nvm."; exit 1; }
# Build tools, in case the database driver has no ready-made binary for this board.
apt-get install -y -q build-essential python3 curl gzip >/dev/null
echo "    $(node --version)"

echo "==> Packages (as $RUN_USER)"
sudo -u "$RUN_USER" -H npm --prefix "$APP_DIR" ci --omit=dev --no-audit --no-fund

port_busy() { ss -ltnH "sport = :$1" 2>/dev/null | grep -q .; }
ours_running() { systemctl is-active --quiet bidfinder-web 2>/dev/null; }

echo "==> Settings file $ENV_FILE"
if [[ ! -f "$ENV_FILE" ]]; then
  [[ -n "$DOMAIN" ]] || read -rp "    Public address for Bid Finder (for example bids.example.co.uk): " DOMAIN
  DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN%%/*}"
  [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || { echo "That does not look like a domain name: $DOMAIN" >&2; exit 1; }
  PORT="${PORT_ARG:-3000}"
  if [[ -z "$PORT_ARG" ]]; then
    while port_busy "$PORT"; do PORT=$((PORT + 1)); done
    [[ "$PORT" == 3000 ]] || echo "    Port 3000 is taken, so Bid Finder will use $PORT."
  elif port_busy "$PORT"; then
    echo "Port $PORT is already in use. Pick another with --port, or leave it out to find a free one." >&2; exit 1
  fi
  secret() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }
  umask 077
  sed -e "s|@DOMAIN@|$DOMAIN|g" -e "s|@PORT@|$PORT|" -e "s|@SESSION_SECRET@|$(secret)|" \
      -e "s|@SECRET_KEY@|$(secret)|" -e "s|@METRICS_TOKEN@|$(secret)|" \
      "$APP_DIR/deploy/pi/bidfinder.env.example" > "$ENV_FILE"
  echo "    Created it with new secrets. Keep a copy somewhere safe (not with the backups):"
  echo "      sudo cat $ENV_FILE"
else
  echo "    Already exists, keeping it."
  DOMAIN="$(sed -n 's|^BASE_URL=https\?://||p' "$ENV_FILE" | tail -1)"
  if [[ -n "$PORT_ARG" ]]; then
    sed -i -E "s/^#? ?PORT=.*/PORT=$PORT_ARG/" "$ENV_FILE"
    echo "    Port set to $PORT_ARG. Point the Cloudflare Tunnel at it."
  fi
fi
chown root:"$RUN_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"
PORT="$(sed -n -E 's/^PORT=([0-9]+).*/\1/p' "$ENV_FILE" | tail -1)"
if ! ours_running && port_busy "$PORT"; then
  echo "Port $PORT is already used by another program. Re-run with --port <free port>." >&2; exit 1
fi

if [[ "$MAIL" == 1 ]] && ! grep -q '^SMTP_URL=' "$ENV_FILE"; then
  echo "==> Email"
  echo "    A Pi on a home connection can't deliver email itself (home addresses are on spam"
  echo "    blocklists and most ISPs block port 25), so mail goes out through Resend."
  echo "    Free for 3,000 emails a month. Create a Full access key at https://resend.com/api-keys"
  echo "    For the DNS records, a Cloudflare token with Zone > DNS > Edit:"
  echo "    https://dash.cloudflare.com/profile/api-tokens (\"Edit zone DNS\" template)."
  echo "    Press Enter to skip; you can run deploy/pi/setup-mail.js later."
  RESEND_API_KEY="${RESEND_API_KEY:-}" CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
  [[ -n "$RESEND_API_KEY" ]] || { read -rsp "    Resend API key: " RESEND_API_KEY; echo; }
  if [[ -n "$RESEND_API_KEY" ]]; then
    [[ -n "$CLOUDFLARE_API_TOKEN" ]] || { read -rsp "    Cloudflare API token (Enter to add the DNS records by hand): " CLOUDFLARE_API_TOKEN; echo; }
    RESEND_API_KEY="$RESEND_API_KEY" CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
      node "$APP_DIR/deploy/pi/setup-mail.js" --domain "$DOMAIN" --env "$ENV_FILE" \
      || echo "    Email setup did not finish. Fix the problem above, then run it again (see deploy/pi/README.md)."
  else
    echo "    Skipped. Until email is set up, new customers cannot confirm their address or reset a password."
  fi
fi

echo "==> systemd services"
for unit in bidfinder-web.service bidfinder-worker.service bidfinder-backup.service bidfinder-backup.timer; do
  sed -e "s|@USER@|$RUN_USER|g" -e "s|@APP_DIR@|$APP_DIR|g" "$APP_DIR/deploy/pi/$unit" > "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable --now bidfinder-worker.service bidfinder-web.service bidfinder-backup.timer
systemctl restart bidfinder-worker.service bidfinder-web.service

# Keep the system journal small on the SD card.
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=200M\n' > /etc/systemd/journald.conf.d/bidfinder.conf
systemctl restart systemd-journald

echo "==> Checking Bid Finder answers"
if "$APP_DIR/deploy/pi/healthcheck.sh" 20 | sed 's/^/    /'; then
  echo
  echo "Done. Next, in the Cloudflare dashboard (deploy/pi/README.md, step 4):"
  echo "  point the tunnel's public hostname $DOMAIN at http://localhost:$PORT"
  echo "Then create your administrator account here:"
  echo "  $APP_DIR/deploy/pi/bidfinder create-user you@example.com --org \"Your Company\" --admin"
  exit 0
fi
exit 1
