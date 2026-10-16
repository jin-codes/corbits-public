#!/usr/bin/env bash
# Corbits server (API + queue worker + scheduler) as a background service on macOS.
#   scripts/server.sh install     start it now and at every login; restart it if it crashes
#   scripts/server.sh uninstall   stop it and remove the service
#   scripts/server.sh status      is it running, and does it answer
# Needs Postgres (and the browser container) up: `pnpm db:up` / `pnpm docker:up`. Logs: ~/Library/Logs/Corbits/server.log
# Stop any `pnpm start` you run by hand first: both would want the same port.
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT="$(pwd)"
LABEL="com.corbits.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/Library/Logs/Corbits"
DOMAIN="gui/$(id -u)"
PORT="${PORT:-8787}"

case "${1:-}" in
  install)
    [ -f "$PROJECT/.env" ] || { echo "no .env in $PROJECT" >&2; exit 1; }
    PNPM="$(command -v pnpm)" || { echo "pnpm not found" >&2; exit 1; }
    if curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/"; then
      echo "something already answers on port $PORT: stop it first (a hand-started 'pnpm start'?)" >&2; exit 1
    fi
    mkdir -p "$(dirname "$PLIST")" "$LOGDIR"
    cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>ProgramArguments</key><array><string>$PNPM</string><string>start</string></array>
  <!-- launchd starts with a bare PATH; node, pnpm and the claude CLI live in Homebrew's -->
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$LOGDIR/server.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/server.log</string>
</dict></plist>
PLISTEOF
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    for _ in $(seq 1 30); do
      curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/" && { echo "installed: Corbits is running on port $PORT and will start at login."; exit 0; }
      sleep 2
    done
    echo "installed, but it does not answer yet: see $LOGDIR/server.log" >&2; exit 1
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed."
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E "state =|pid =|last exit" || echo "not installed"
    curl -s -m 3 -o /dev/null -w "http %{http_code}\n" "http://127.0.0.1:$PORT/" || echo "does not answer"
    ;;
  *)
    echo "usage: scripts/server.sh install|uninstall|status" >&2
    exit 2
    ;;
esac
