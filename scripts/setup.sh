#!/usr/bin/env bash
# Sets up Bid Finder on a server with Docker: asks for your domain, writes
# .env with freshly generated secrets, and starts everything. Safe to re-run;
# an existing .env is kept.
#
# Usage: ./scripts/setup.sh [--domain bids.example.co.uk] [--no-start]
set -euo pipefail
cd "$(dirname "$0")/.."

DOMAIN="" START=1
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --no-start) START=0; shift ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 1 ;;
  esac
done

command -v docker >/dev/null || { echo "Docker is not installed. See https://docs.docker.com/engine/install/" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "The Docker Compose plugin is not installed." >&2; exit 1; }

secret() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }

if [ -f .env ]; then
  echo ".env already exists, keeping it."
else
  [ -n "$DOMAIN" ] || read -rp "Domain name for Bid Finder (for example bids.example.co.uk): " DOMAIN
  [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "That does not look like a domain name: $DOMAIN" >&2; exit 1; }
  umask 077
  {
    echo "# Written by scripts/setup.sh. See .env.example for every setting."
    echo "DOMAIN=$DOMAIN"
    echo "SESSION_SECRET=$(secret)"
    echo "# Encrypts stored portal logins and API keys. If you lose it, they must be re-entered."
    echo "BIDFINDER_SECRET_KEY=$(secret)"
    echo "METRICS_TOKEN=$(secret)"
    echo "# SMTP_URL=smtps://user:pass@smtp.example.com:465"
    echo "# MAIL_FROM=Bid Finder <alerts@$DOMAIN>"
  } > .env
  echo "Wrote .env. Keep a copy of it somewhere safe, separate from your backups."
fi

if [ "$START" = 1 ]; then
  docker compose up -d --build
  DOMAIN="$(sed -n 's/^DOMAIN=//p' .env | tail -1)"
  echo
  echo "Bid Finder is starting at https://$DOMAIN"
  echo "The first account you register becomes the administrator."
  echo "Logs: docker compose logs -f app"
fi
