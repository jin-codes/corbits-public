#!/usr/bin/env bash
# Corbits in the macOS menu bar (see macos/CorbitsMenuBar.swift).
#   scripts/menubar.sh install     build it, and start it now and at every login
#   scripts/menubar.sh uninstall   stop it and remove everything it installed
#   scripts/menubar.sh run         build and run in this terminal (for trying it out)
# Needs the Xcode command line tools (swiftc) and CORBITS_API_TOKENS in this project's .env.
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT="$(pwd)"
APPDIR="$HOME/Library/Application Support/Corbits"
BIN="$APPDIR/CorbitsMenuBar"
LABEL="com.corbits.menubar"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

build() {
  command -v swiftc >/dev/null || { echo "swiftc not found: run 'xcode-select --install' first" >&2; exit 1; }
  mkdir -p "$APPDIR"
  swiftc -swift-version 5 -O macos/CorbitsMenuBar.swift -o "$BIN"
}

case "${1:-}" in
  install)
    [ -f "$PROJECT/.env" ] || { echo "no .env in $PROJECT" >&2; exit 1; }
    build
    mkdir -p "$(dirname "$PLIST")"
    cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$BIN</string><string>$PROJECT/.env</string></array>
  <key>RunAtLoad</key><true/>
  <!-- restart if it crashes, but stay quit when you choose Quit from the menu -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
</dict></plist>
PLISTEOF
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "installed: Corbits is in the menu bar and will start at login."
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST" "$BIN"
    rmdir "$APPDIR" 2>/dev/null || true
    echo "removed."
    ;;
  run)
    build
    exec "$BIN" "$PROJECT/.env"
    ;;
  *)
    echo "usage: scripts/menubar.sh install|uninstall|run" >&2
    exit 2
    ;;
esac
