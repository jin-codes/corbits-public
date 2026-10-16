#!/usr/bin/env bash
# Starts a Chrome that Corbits can drive: its OWN profile (your normal profile is never exposed) with
# the remote-debugging port open on this machine only. Log in to the sites you want the agent to use
# once, in this window; the profile keeps those logins between runs.
#   pnpm chrome            (port 9223, profile in ~/.corbits-chrome)
# Then set CORBITS_BROWSER_CDP_URL=http://127.0.0.1:9223 and CORBITS_ALLOWED_ORIGINS in .env.
set -euo pipefail
PORT="${CORBITS_CHROME_PORT:-9223}"
PROFILE="${CORBITS_CHROME_PROFILE:-$HOME/.corbits-chrome}"
ARGS=("--remote-debugging-port=$PORT" "--remote-debugging-address=127.0.0.1" "--user-data-dir=$PROFILE" "--no-first-run" "--no-default-browser-check")
case "$(uname -s)" in
  Darwin) exec open -na "Google Chrome" --args "${ARGS[@]}" ;;
  Linux)  exec "${CHROME_BIN:-google-chrome}" "${ARGS[@]}" ;;
  *) echo "Unsupported OS: start Chrome yourself with: ${ARGS[*]}" >&2; exit 1 ;;
esac
