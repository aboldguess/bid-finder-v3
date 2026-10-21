#!/usr/bin/env bash
# One-shot install for Raspberry Pi OS (64-bit) or any Debian/Ubuntu box.
# Installs Node.js 22 if needed, installs dependencies, and runs Bid Finder
# as a systemd service that starts on boot. Re-run it to update.
set -euo pipefail

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
echo "Bid Finder is running on http://$(hostname -I | awk '{print $1}'):3000 (or the PORT in .env)"
echo "The first account you register becomes the platform admin."
echo "Logs: journalctl -u bidfinder -f"
