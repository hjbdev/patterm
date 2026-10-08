#!/usr/bin/env bash
set -euo pipefail

APP_ID="patterm-desktop"
APP_NAME="Patterm"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/$APP_ID"
BIN_DIR="$HOME/.local/bin"
APPLICATIONS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
LAUNCHER="$BIN_DIR/patterm"
DESKTOP_FILE="$APPLICATIONS_DIR/patterm.desktop"
SIDECAR_BINARY="patterm-terminal-core"
UPDATE=false
# --debug installs the debug sidecar for the desktop app, as earlier builds did.
DEBUG=false
for argument in "$@"; do
  case "$argument" in
    --update) UPDATE=true ;;
    --debug) DEBUG=true ;;
    *)
      printf 'Usage: install.sh [--update] [--debug]\n' >&2
      exit 1
      ;;
  esac
done
SIDECAR_PROFILE=release
if $DEBUG; then SIDECAR_PROFILE=debug; fi

if [[ "$(uname -s)" != "Linux" ]]; then
  printf 'error: install.sh currently supports Linux only\n' >&2
  exit 1
fi

if $UPDATE && ! command -v curl >/dev/null 2>&1; then
  printf 'error: --update needs curl to check that the updated service answers /health\n' >&2
  exit 1
fi

if ! $UPDATE && systemctl --user is-active --quiet patterm.service; then
  printf 'error: use ./update.sh to update the running background service\n' >&2
  exit 1
fi

# Build and stage before the service stops. A failed build leaves it untouched.
if $DEBUG; then "$SCRIPT_DIR/build.sh" --debug; else "$SCRIPT_DIR/build.sh"; fi

if [[ ! -x "$SCRIPT_DIR/node_modules/.bin/electron" ]]; then
  printf 'error: Electron binary not found at node_modules/.bin/electron\n' >&2
  exit 1
fi

if [[ ! -x "$SCRIPT_DIR/native/terminal-core/target/$SIDECAR_PROFILE/$SIDECAR_BINARY" || ! -x "$SCRIPT_DIR/native/terminal-core/target/release/$SIDECAR_BINARY" ]]; then
  printf 'error: terminal sidecar was not built\n' >&2
  exit 1
fi

mkdir -p "$(dirname "$INSTALL_ROOT")" "$BIN_DIR" "$APPLICATIONS_DIR"
STAGING_ROOT="$(mktemp -d "${INSTALL_ROOT}.staging.XXXXXX")"
PREVIOUS_ROOT="${STAGING_ROOT}.previous"
# One earlier build is kept for a manual rollback with a matching database backup.
KEPT_ROOT="${INSTALL_ROOT}.previous"
SERVICE_STOPPED=false
APP_STARTED=false
WAS_ACTIVE=false
cleanup() {
  local status=$?
  trap - EXIT
  if (( status != 0 )) && ! $APP_STARTED; then
    if [[ -d "$PREVIOUS_ROOT" ]]; then
      rm -rf "$INSTALL_ROOT"
      mv "$PREVIOUS_ROOT" "$INSTALL_ROOT"
    fi
    if $SERVICE_STOPPED && $WAS_ACTIVE; then
      systemctl --user start patterm.service || true
    fi
  fi
  rm -rf "$STAGING_ROOT"
  if [[ -d "$PREVIOUS_ROOT" ]]; then
    printf 'Previous application retained at %s. Do not run it against migrated databases.\n' "$PREVIOUS_ROOT"
  fi
  if (( status != 0 )) && $APP_STARTED; then
    local rollback_root="$KEPT_ROOT"
    # A failed start exits before the replaced build moves to KEPT_ROOT.
    [[ -d "$PREVIOUS_ROOT" ]] && rollback_root="$PREVIOUS_ROOT"
    printf 'The updated service did not become healthy. Check: journalctl --user -u patterm.service -n 100\n' >&2
    printf 'To roll back, follow "Upgrade and rollback" in README.md with %s and the newest backups/pre-migration-* directory.\n' "$rollback_root" >&2
  fi
  exit "$status"
}
trap cleanup EXIT
mkdir -p "$STAGING_ROOT/resources/native" "$STAGING_ROOT/resources/mcp"

cp -a "$SCRIPT_DIR/dist" "$STAGING_ROOT/dist"
cp -a "$SCRIPT_DIR/node_modules" "$STAGING_ROOT/node_modules"
cp "$SCRIPT_DIR/package.json" "$SCRIPT_DIR/LICENSE" "$SCRIPT_DIR/THIRD_PARTY_NOTICES.md" "$STAGING_ROOT/"
# key=value build identity; release tarballs supply the same file.
{
  printf 'version=%s\n' "$(node -p 'require(process.argv[1]).version' "$SCRIPT_DIR/package.json" 2>/dev/null || echo unknown)"
  printf 'commit=%s\n' "$(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
  if [[ -n "$(git -C "$SCRIPT_DIR" status --porcelain 2>/dev/null)" ]]; then printf 'dirty=true\n'; fi
  printf 'built_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$STAGING_ROOT/BUILD"
cp "$SCRIPT_DIR/native/terminal-core/target/$SIDECAR_PROFILE/$SIDECAR_BINARY" "$STAGING_ROOT/resources/native/$SIDECAR_BINARY"
cp "$SCRIPT_DIR/dist/mcp/patterm-mcp.js" "$STAGING_ROOT/resources/mcp/patterm-mcp.js"

mkdir -p "$STAGING_ROOT/scripts" "$STAGING_ROOT/deploy" "$STAGING_ROOT/native/terminal-core/target/release"
cp "$SCRIPT_DIR/scripts/patterm.sh" "$STAGING_ROOT/scripts/patterm.sh"
cp "$SCRIPT_DIR/scripts/install-service.mjs" "$STAGING_ROOT/scripts/install-service.mjs"
cp "$SCRIPT_DIR/scripts/start-tailscale-service.mjs" "$STAGING_ROOT/scripts/start-tailscale-service.mjs"
cp "$SCRIPT_DIR/deploy/patterm.service" "$SCRIPT_DIR/deploy/patterm-terminal@.service" "$STAGING_ROOT/deploy/"
cp "$SCRIPT_DIR/native/terminal-core/target/release/$SIDECAR_BINARY" "$STAGING_ROOT/native/terminal-core/target/release/$SIDECAR_BINARY"
chmod +x "$STAGING_ROOT/scripts/patterm.sh"
if $UPDATE; then
  node "$STAGING_ROOT/scripts/install-service.mjs" --update --output-dir "$STAGING_ROOT/service-preview"
  rm -rf "$STAGING_ROOT/service-preview"
  if systemctl --user is-active --quiet patterm.service; then WAS_ACTIVE=true; fi
  systemctl --user stop patterm.service
  SERVICE_STOPPED=true
fi
if [[ -e "$INSTALL_ROOT" ]]; then mv "$INSTALL_ROOT" "$PREVIOUS_ROOT"; fi
mv "$STAGING_ROOT" "$INSTALL_ROOT"
if $UPDATE; then
  node "$INSTALL_ROOT/scripts/install-service.mjs" --update
  systemctl --user daemon-reload
fi
ln -sfn "$INSTALL_ROOT/scripts/patterm.sh" "$LAUNCHER"
rm -f "$BIN_DIR/patterm-desktop" "$APPLICATIONS_DIR/patterm-desktop.desktop"

chmod +x "$LAUNCHER" "$INSTALL_ROOT/resources/native/$SIDECAR_BINARY"

cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Name=$APP_NAME
Comment=Project agent workbench
Exec=$LAUNCHER
Type=Application
Terminal=false
Categories=Development;Utility;
StartupWMClass=$APP_ID
EOF

chmod 0644 "$DESKTOP_FILE"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPLICATIONS_DIR" >/dev/null 2>&1 || true
fi

if $UPDATE; then
  # A start can migrate databases, so never automatically restore the older app.
  APP_STARTED=true
  systemctl --user start patterm.service
fi
if [[ -d "$PREVIOUS_ROOT" ]]; then
  rm -rf "$KEPT_ROOT"
  mv "$PREVIOUS_ROOT" "$KEPT_ROOT"
fi
if $UPDATE; then
  # The unit starts before migrations run. Report success only once it serves.
  PORT="$(sed -n 's/^PATTERM_PORT="\{0,1\}\([0-9]*\)"\{0,1\}$/\1/p' "${XDG_CONFIG_HOME:-$HOME/.config}/patterm/patterm.env" 2>/dev/null | tail -n 1)"
  HEALTH_URL="http://127.0.0.1:${PORT:-8787}/health"
  for (( waited = 0; ; waited += 2 )); do
    if curl --fail --silent --max-time 2 --output /dev/null "$HEALTH_URL"; then break; fi
    if (( waited >= 600 )) || systemctl --user is-failed --quiet patterm.service; then
      printf 'error: patterm.service is not healthy at %s\n' "$HEALTH_URL" >&2
      exit 1
    fi
    sleep 2
  done
fi
printf '%s installed. Launch with %s or from your desktop launcher.\n' "$APP_NAME" "$LAUNCHER"
