#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(dirname "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")")"
# Release tarballs bundle Node and Electron; a source install uses its own.
NODE="$APP_DIR/runtime/node"
[[ -x "$NODE" ]] || NODE=node
ELECTRON="$APP_DIR/electron/electron"
[[ -x "$ELECTRON" ]] || ELECTRON="$APP_DIR/node_modules/.bin/electron"

case "${1:-}" in
  --headless)
    shift
    if [[ "${1:-}" == --tailscale-serve && $# == 1 ]]; then
      exec "$NODE" "$APP_DIR/scripts/start-tailscale-service.mjs"
    fi
    if (( $# )); then
      printf 'Usage: patterm --headless [--tailscale-serve]\n' >&2
      exit 1
    fi
    if ! systemctl --user cat patterm.service >/dev/null 2>&1; then
      "$NODE" "$APP_DIR/scripts/install-service.mjs" --public-origin "${PATTERM_PUBLIC_ORIGIN:-${PUBLIC_ORIGIN:-http://localhost:${PATTERM_PORT:-8787}}}"
      systemctl --user daemon-reload
    fi
    systemctl --user start patterm.service
    printf 'Patterm background service started.\nStatus: systemctl --user status patterm.service\nLogs: journalctl --user -u patterm.service -f\nStop the web service: systemctl --user stop patterm.service\nUse Quit in Patterm to stop all agents and terminals.\n'
    exit 0
    ;;
  --help|-h)
    printf 'Usage: patterm [--headless [--tailscale-serve]]\n\nWithout options, opens the desktop app.\n--headless        Start the background user service without opening a window.\n--tailscale-serve Detect the Tailscale hostname and configure private HTTPS access.\n'
    exit 0
    ;;
  --tailscale-serve)
    printf 'Use patterm --headless --tailscale-serve\n' >&2
    exit 1
    ;;
esac

export PATTERM_DESKTOP_RESOURCES="$APP_DIR/resources"
unset ELECTRON_RUN_AS_NODE
cd "$APP_DIR"
exec "$ELECTRON" "$APP_DIR/dist/main/desktop/main/main.js" "$@"
