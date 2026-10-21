#!/usr/bin/env bash
# One-shot install for Raspberry Pi OS (64-bit) or any Debian/Ubuntu box.
# Installs Node.js 22 if needed, installs dependencies, and runs Bid Finder
# as a systemd service that starts on boot. Re-run it to update.
#
# Usage: ./scripts/install-pi.sh [--port 3001]
#   --port, -port, -p   Port to listen on (default: the PORT already in .env, else 3000).
set -euo pipefail

PORT_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --port|-port|-p) PORT_ARG="${2:-}"; shift 2 ;;
    --port=*|-port=*) PORT_ARG="${1#*=}"; shift ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 1 ;;
  esac
done
if [ -n "$PORT_ARG" ] && ! [[ "$PORT_ARG" =~ ^[0-9]+$ && "$PORT_ARG" -ge 1 && "$PORT_ARG" -le 65535 ]]; then
  echo "Port must be a number between 1 and 65535, got: $PORT_ARG" >&2
  exit 1
fi

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_USER="${SUDO_USER:-$USER}"

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

cd "$APP_DIR"
npm ci --omit=dev
[ -f .env ] || cp .env.example .env

# Record the port in .env so the service, and later re-runs, keep using it.
if [ -n "$PORT_ARG" ]; then
  sed -i -E '/^#? ?PORT=/d' .env
  echo "PORT=$PORT_ARG" >> .env
fi
PORT="$(sed -n -E 's/^PORT=([0-9]+).*/\1/p' .env | tail -1)"
PORT="${PORT:-3000}"

# Refuse to clash with another app already listening on that port.
if command -v ss >/dev/null && ! systemctl is-active --quiet bidfinder 2>/dev/null && ss -ltn "sport = :$PORT" | grep -q LISTEN; then
  echo "Port $PORT is already in use by another program. Re-run with --port <free port>." >&2
  exit 1
fi

sudo tee /etc/systemd/system/bidfinder.service >/dev/null <<UNIT
[Unit]
Description=Bid Finder
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=-$APP_DIR/.env
ExecStart=$(command -v node) src/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable bidfinder
sudo systemctl restart bidfinder
echo "Bid Finder is running on http://$(hostname -I | awk '{print $1}'):$PORT"
echo "The first account you register becomes the platform admin."
echo "Logs: journalctl -u bidfinder -f"
