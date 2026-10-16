#!/usr/bin/env bash
# Restore a backup made by scripts/backup.sh into the production database.
#   ./scripts/restore.sh backups/corbits-<timestamp>.sql.gz
# This REPLACES the current database contents. Stop the app first so nothing writes during the restore:
#   docker compose -f docker-compose.yml -f docker-compose.prod.yml stop app
set -euo pipefail
cd "$(dirname "$0")/.."
file="${1:?usage: scripts/restore.sh backups/corbits-<timestamp>.sql.gz}"
[ -f "$file" ] || { echo "no such file: $file" >&2; exit 1; }
read -r -p "Replace the current database with $file? Type 'yes' to continue: " answer
[ "$answer" = "yes" ] || { echo "aborted"; exit 1; }
dc() { docker compose -f docker-compose.yml -f docker-compose.prod.yml "$@"; }
dc exec -T postgres psql -U corbits -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS corbits WITH (FORCE)" -c "CREATE DATABASE corbits OWNER corbits"
gunzip -c "$file" | dc exec -T postgres psql -U corbits -d corbits -v ON_ERROR_STOP=1 -q
echo "restored $file; start the app again: docker compose -f docker-compose.yml -f docker-compose.prod.yml start app"
