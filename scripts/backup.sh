#!/usr/bin/env bash
# Daily Postgres backup for the production stack. Keeps the newest 14 dumps in ./backups.
# Run from the project directory (cron: 0 4 * * * cd /home/ubuntu/corbits && ./scripts/backup.sh).
# Copy ./backups off this server too (see docs/deploy-oracle.md); a backup on the same disk is not enough.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
out="backups/corbits-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
trap 'rm -f "$out.tmp"' EXIT
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T postgres pg_dump -U corbits corbits | gzip > "$out.tmp"
mv "$out.tmp" "$out"
ls -1t backups/corbits-*.sql.gz | tail -n +15 | xargs -r rm --
echo "wrote $out"
