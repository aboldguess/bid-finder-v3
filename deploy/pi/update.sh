#!/usr/bin/env bash
# Pull the latest code and restart Bid Finder (a few seconds' downtime). The
# database is upgraded automatically on start; a backup is taken first.
#
#   cd ~/bid-finder-v3 && ./deploy/pi/update.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
sudo systemctl start bidfinder-backup
git pull --ff-only
npm ci --omit=dev --no-audit --no-fund
sudo systemctl restart bidfinder-worker bidfinder-web
"$(dirname "$0")/healthcheck.sh" 20
