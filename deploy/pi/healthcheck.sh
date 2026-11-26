#!/usr/bin/env bash
# Checks Bid Finder is the thing answering on its port.
# Reads PORT from /etc/bidfinder.env (3000 if unset). Waits up to $1 seconds (default 20).
# Exit 0 = Bid Finder answered. Exit 1 = nothing answered, or another app holds the port.
set -uo pipefail
port=$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*\([0-9]\+\).*/\1/p' /etc/bidfinder.env 2>/dev/null | tail -1)
port=${port:-3000}
url="http://127.0.0.1:$port/readyz"
body=""
for _ in $(seq 1 "${1:-20}"); do
  body=$(curl -sS --max-time 3 "$url" 2>/dev/null) || body=""
  # Bid Finder's readiness check answers {"ok":true,"version":"..."}.
  [[ "$body" == *'"ok":true'*'"version"'* ]] && { echo "OK: Bid Finder is up on port $port."; exit 0; }
  sleep 1
done
if [[ "$body" == *'scheduler stalled'* ]]; then
  echo "The web app is up on port $port, but the worker has stopped. See: journalctl -u bidfinder-worker -n 50 --no-pager"
elif [[ -n "$body" ]]; then
  echo "Port $port is answered by a different app, not Bid Finder."
  echo "  See what holds it:  sudo ss -ltnp | grep ':$port '"
  echo "  Then stop that app, or set PORT to a free port in /etc/bidfinder.env, restart bidfinder-web,"
  echo "  and point the Cloudflare Tunnel at the new port."
else
  echo "Nothing answered on port $port."
fi
echo "  Web app log:  journalctl -u bidfinder-web -n 50 --no-pager"
exit 1
