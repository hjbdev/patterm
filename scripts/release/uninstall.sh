#!/usr/bin/env bash
# Removes Patterm: its services, launcher, and installed versions. It asks
# before deleting your data, which includes projects, history, and settings.
# Usage: uninstall.sh [--yes] [--keep-data | --delete-data]
set -euo pipefail

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
PATTERM_HOME="${PATTERM_HOME:-$DATA_HOME/patterm}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
ENV_FILE="$CONFIG_HOME/patterm/patterm.env"
UNIT_DIR="$CONFIG_HOME/systemd/user"

ASSUME_YES=false DATA_CHOICE=ask
for argument in "$@"; do
  case "$argument" in
    --yes) ASSUME_YES=true ;;
    --keep-data) DATA_CHOICE=keep ;;
    --delete-data) DATA_CHOICE=delete ;;
    *) printf 'Usage: uninstall.sh [--yes] [--keep-data | --delete-data]\n' >&2; exit 1 ;;
  esac
done

# Piped through curl, stdin is the script, so questions read the terminal.
ask() {
  local reply=""
  if [[ -r /dev/tty ]]; then read -r -p "$1 [y/N] " reply < /dev/tty || true; fi
  [[ "$reply" == [yY]* ]]
}

DATA_DIR="$DATA_HOME/patterm-server"
if [[ -f "$ENV_FILE" ]]; then
  # install-service.mjs escapes \ " $ and ` with a backslash; undo that, without evaluating anything.
  configured="$(sed -n 's/^PATTERM_DATA_DIR="\(.*\)"$/\1/p' "$ENV_FILE" | tail -n 1 | sed 's/\\\(.\)/\1/g')"
  [[ -z "$configured" ]] || DATA_DIR="$configured"
fi
DATA_DIRS=("$DATA_DIR" "$CONFIG_HOME/patterm-desktop")

printf 'This stops every Patterm agent and terminal and removes:\n  %s\n  %s and %s.previous (earlier from-source installs)\n  ~/.local/bin/patterm, its desktop entry, the systemd user units, and %s\n' \
  "$PATTERM_HOME" "$DATA_HOME/patterm-desktop" "$DATA_HOME/patterm-desktop" "$ENV_FILE"
if ! $ASSUME_YES && ! ask 'Uninstall Patterm?'; then
  printf 'Nothing was changed.\n'
  exit 1
fi

if command -v systemctl >/dev/null 2>&1; then
  # Quit semantics: the web service, then every terminal and Integrated host.
  # A unit that isn't loaded fails to stop, so check what is still running instead.
  systemctl --user stop patterm.service 2>/dev/null || true
  systemctl --user stop 'patterm-terminal@*.service' 'patterm-integrated-*' 2>/dev/null || true
  if running="$(systemctl --user list-units --plain --no-legend --state=active,activating,deactivating,reloading 'patterm.service' 'patterm-terminal@*' 'patterm-integrated-*' 2>/dev/null)"; then
    if [[ -n "$running" ]]; then
      printf 'error: these Patterm units are still running, so nothing was removed:\n%s\nStop them, then run uninstall.sh again.\n' "$running" >&2
      exit 1
    fi
  elif [[ -e "$UNIT_DIR/patterm.service" ]]; then
    printf 'error: could not check whether Patterm stopped (no systemd user session?), so nothing was removed.\n' >&2
    exit 1
  fi
  systemctl --user disable patterm.service 2>/dev/null || true
  rm -f "$UNIT_DIR/patterm.service" "$UNIT_DIR/patterm-terminal@.service"
  systemctl --user daemon-reload 2>/dev/null || true
  systemctl --user reset-failed 'patterm*' 2>/dev/null || true
fi
rm -f "$ENV_FILE"
rmdir "$CONFIG_HOME/patterm" 2>/dev/null || true

rm -f "$HOME/.local/bin/patterm" "$DATA_HOME/applications/patterm.desktop"
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database "$DATA_HOME/applications" >/dev/null 2>&1 || true; fi
rm -rf "$PATTERM_HOME" "$DATA_HOME/patterm-desktop" "$DATA_HOME/patterm-desktop.previous"

delete_data=false
case "$DATA_CHOICE" in
  delete) delete_data=true ;;
  ask)
    existing=()
    for directory in "${DATA_DIRS[@]}"; do [[ ! -e "$directory" ]] || existing+=("$directory"); done
    if (( ${#existing[@]} )) && ask "Also delete your Patterm data (${existing[*]})? This cannot be undone."; then delete_data=true; fi
    ;;
esac
if $delete_data; then
  rm -rf "${DATA_DIRS[@]}"
  printf 'Deleted Patterm data.\n'
else
  printf 'Kept Patterm data in %s and %s.\n' "${DATA_DIRS[@]}"
fi

if command -v loginctl >/dev/null 2>&1 && [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" == yes ]]; then
  printf 'Lingering is still enabled for %s, which other user services may need. To turn it off: loginctl disable-linger %s\n' "$USER" "$USER"
fi
if command -v tailscale >/dev/null 2>&1; then
  printf 'If you set up Tailscale Serve for Patterm, check it with: tailscale serve status\n'
fi
printf 'Patterm is uninstalled.\n'
