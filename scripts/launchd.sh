#!/usr/bin/env bash
# Orys as a background service on this Mac (SPEC §18.3): starts at login, restarts when it
# stops, and runs `orys serve --agent --keep-awake`, so the hosted dashboard reaches it. Remote
# access is switched on and off in the dashboard (Remote), not here. Logs go to
# ~/Library/Logs/orys/serve.log: launchd may not write into ~/Desktop (macOS privacy).
#
# Usage: bash scripts/launchd.sh install | uninstall | restart | status | logs | print
# Run it from the main checkout: the service runs the code of the checkout the script is in.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
LABEL=dev.orys.engine
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
LOG="$HOME/Library/Logs/orys/serve.log"

xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }

# Agents need node, git, claude (and docker for some projects) on PATH; launchd starts with almost none.
service_path() {
  local dirs=() p d
  for cmd in node claude git docker pnpm; do
    p=$(command -v "$cmd" 2>/dev/null) || continue
    d=$(dirname "$p")
    [[ " ${dirs[*]-} " == *" $d "* ]] || dirs+=("$d")
  done
  local joined
  joined=$(IFS=:; echo "${dirs[*]-}")
  echo "${joined:+$joined:}/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
}

plist() {
  local node
  node=$(command -v node) || { echo "node not found on PATH" >&2; exit 1; }
  command -v claude >/dev/null || echo "warning: claude not found on PATH; agents will fail to start" >&2
  # One process, no wrappers: launchd's SIGTERM reaches Orys directly and it stops cleanly.
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$node")</string>
    <string>--import</string><string>tsx</string>
    <string>src/cli/index.ts</string><string>serve</string><string>--agent</string><string>--keep-awake</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "$ROOT")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml "$(service_path)")</string>
    <key>HOME</key><string>$(xml "$HOME")</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ExitTimeOut</key><integer>60</integer>
  <key>StandardOutPath</key><string>$(xml "$LOG")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOG")</string>
</dict>
</plist>
PLIST
}

loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

# One Orys service per Mac: a second copy (another checkout, or a test install under another HOME)
# must not take over or remove the one that is running.
not_another() {
  loaded || return 0
  local other
  other=$(launchctl print "$DOMAIN/$LABEL" | awk -F' = ' '$1 == "\tworking directory" { print $2; exit }')
  if [[ -n "$other" && "$other" != "$ROOT" ]]; then
    echo "Another Orys ($other) runs as the service on this Mac; this copy ($ROOT) leaves it alone." >&2
    echo "To switch, run there first: bash $other/scripts/launchd.sh uninstall" >&2
    exit 1
  fi
}

case "${1:-}" in
  print) plist ;;
  install)
    if [[ "$ROOT" == */.claude/worktrees/* ]]; then echo "Run this from the main checkout, not a worktree ($ROOT)" >&2; exit 1; fi
    not_another
    if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${AIPM_PORT:-4317}/api/status" && ! loaded; then
      echo "Orys is already running on port ${AIPM_PORT:-4317} (a terminal?). Stop it first, then install." >&2
      exit 1
    fi
    mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
    plist > "$PLIST.tmp"
    plutil -lint "$PLIST.tmp" >/dev/null
    mv "$PLIST.tmp" "$PLIST"
    if loaded; then launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true; fi
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "installed $PLIST; Orys starts now and at every login (log: $LOG)"
    ;;
  uninstall)
    not_another
    if loaded; then launchctl bootout "$DOMAIN/$LABEL"; fi
    rm -f "$PLIST"
    echo "removed $LABEL"
    ;;
  restart) launchctl kickstart -k "$DOMAIN/$LABEL" && echo "restarted" ;;
  status)
    if loaded; then launchctl print "$DOMAIN/$LABEL" | grep -E '^\s*(state|pid|last exit code) =' || true; else echo "not installed"; fi
    ;;
  logs) tail -n 50 -f "$LOG" ;;
  *) echo "usage: bash scripts/launchd.sh install | uninstall | restart | status | logs | print" >&2; exit 2 ;;
esac
