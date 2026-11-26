#!/usr/bin/env bash
# Nightly backup, run by bidfinder-backup.timer: takes a consistent snapshot
# while the app keeps running, checks it, and (if BACKUP_RCLONE_REMOTE is set)
# copies it offsite compressed. Pings BACKUP_PING_URL with the result.
#
# By hand: sudo systemctl start bidfinder-backup && journalctl -u bidfinder-backup -n 20
set -euo pipefail
cd "$(dirname "$0")/../.."

report() { [[ -n "${BACKUP_PING_URL:-}" ]] && curl -fsS -m 10 --retry 3 --data-raw "$2" "$BACKUP_PING_URL$1" >/dev/null || true; }
fail() { echo "Backup failed: $1" >&2; report /fail "$1"; exit 1; }
trap 'fail "line $LINENO"' ERR

out="$(node src/cli.js backup 2>&1)" || fail "$(grep -m1 -E '^[A-Za-z]*Error' <<<"$out" || tail -1 <<<"$out")"
file="${out#Backed up to }"
[[ -f "$file" ]] || fail "no backup file ($out)"

check="$(node -e 'const D = require("better-sqlite3"); const db = new D(process.argv[1], { readonly: true }); console.log(db.pragma("quick_check", { simple: true }));' "$file")"
[[ "$check" == ok ]] || fail "$file is damaged: $check"
size="$(du -h "$file" | cut -f1)"
msg="$file ($size) checked"

if [[ -n "${BACKUP_RCLONE_REMOTE:-}" ]]; then
  gz="$(mktemp --suffix=.db.gz)"
  trap 'rm -f "$gz"' EXIT
  gzip -c "$file" > "$gz"
  rclone copyto "$gz" "$BACKUP_RCLONE_REMOTE/$(basename "$file").gz" || fail "offsite copy to $BACKUP_RCLONE_REMOTE failed"
  rclone delete --min-age "${BACKUP_OFFSITE_DAYS:-60}d" "$BACKUP_RCLONE_REMOTE" || true
  msg="$msg, copied to $BACKUP_RCLONE_REMOTE"
fi
echo "$msg"
report "" "$msg"
