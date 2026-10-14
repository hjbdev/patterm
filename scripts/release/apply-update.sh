#!/usr/bin/env bash
# Patterm's updater runs this detached before it quits. It waits for the app to
# exit, runs the installer, and opens Patterm again, updated or not.
# Usage: apply-update.sh <pid> <log> <app> -- <installer> [arguments...]
# <app> is a launcher to run, or a macOS .app bundle to open.
set -uo pipefail

PID="$1" LOG="$2" APP="$3"
shift 3
[[ "${1:-}" == -- ]] && shift
mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

printf '%s waiting for Patterm (pid %s) to quit\n' "$(stamp)" "$PID"
# A quit that never happens cancels the update rather than surprising a later one.
for (( waited = 0; waited < 600; waited++ )); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 1
done
if kill -0 "$PID" 2>/dev/null; then
  printf '%s Patterm did not quit; the update was cancelled\n' "$(stamp)"
  exit 1
fi

printf '%s running %s\n' "$(stamp)" "$*"
"$@"
status=$?
printf '%s installer exited with %s\n' "$(stamp)" "$status"

if [[ "$APP" == *.app ]]; then
  open "$APP" || printf '%s could not open %s\n' "$(stamp)" "$APP"
else
  nohup "$APP" >/dev/null 2>&1 &
fi
exit "$status"
