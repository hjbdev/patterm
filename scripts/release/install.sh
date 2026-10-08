#!/usr/bin/env bash
# Installs or updates Patterm from a GitHub release:
#   curl -fsSL https://github.com/@PATTERM_REPO@/releases/latest/download/install.sh | bash
# Each version unpacks into $PATTERM_HOME/versions/<version>, and the current
# symlink names the one in use. The previous version is kept for a rollback.
set -euo pipefail

REPO="@PATTERM_REPO@"
# The release workflow fills in the key from scripts/release/minisign.pub.
PUBLIC_KEY="@MINISIGN_PUBLIC_KEY@"
PATTERM_HOME="${PATTERM_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/patterm}"
BIN_DIR="$HOME/.local/bin"
APPLICATIONS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
LEGACY_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/patterm-desktop"

usage() {
  printf 'Usage: install.sh [--version VERSION] [--update] [--allow-downgrade]\n\n--version          Install this version, such as 1.2.0 or 1.3.0-beta.1, instead of the latest stable release.\n--update          Replace the running background service and restart it.\n--allow-downgrade Install a version older than the installed one.\n' >&2
}

VERSION="" UPDATE=false ALLOW_DOWNGRADE=false
while (( $# )); do
  case "$1" in
    --version) VERSION="${2:-}"; VERSION="${VERSION#v}"; [[ -n "$VERSION" ]] || { usage; exit 1; }; shift 2 ;;
    --update) UPDATE=true; shift ;;
    --allow-downgrade) ALLOW_DOWNGRADE=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 1 ;;
  esac
done

fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

health_url() {
  local port
  port="$(sed -n 's/^PATTERM_PORT="\{0,1\}\([0-9]*\)"\{0,1\}$/\1/p' "${XDG_CONFIG_HOME:-$HOME/.config}/patterm/patterm.env" 2>/dev/null | tail -n 1)"
  printf 'http://127.0.0.1:%s/health' "${port:-8787}"
}

# Whether any of this user's processes runs from, works in, or names the
# directory, such as an Integrated host or desktop app the earlier install
# started. /proc reports resolved paths, so compare both spellings, and count
# the directory as in use whenever that can't be checked.
in_use() {
  local real proc link argument path
  real="$(realpath -e -- "$1" 2>/dev/null)" && [[ -r /proc/self/cmdline ]] || return 0
  for proc in /proc/[0-9]*; do
    [[ -O "$proc" ]] || continue
    for link in exe cwd; do
      link="$(readlink "$proc/$link" 2>/dev/null)" || continue
      for path in "$1" "$real"; do
        [[ "$link" == "$path" || "$link" == "$path/"* ]] && return 0
      done
    done
    while IFS= read -r -d '' argument; do
      for path in "$1" "$real"; do
        [[ "$argument" == "$path" || "$argument" == "$path/"* ]] && return 0
      done
    done 2>/dev/null < "$proc/cmdline"
  done
  return 1
}

# The from-source install a service moved from goes once the new service is
# healthy. Anything still running from it keeps it until a later --update.
HEALTHY=false
remove_legacy() {
  local legacy
  for legacy in "$LEGACY_ROOT" "$LEGACY_ROOT.previous"; do
    [[ -d "$legacy" ]] || continue
    if ! $HEALTHY; then
      printf 'An earlier from-source install remains in %s. It is removed by the next --update once the service is healthy, or remove it yourself with: rm -rf %q\n' "$legacy" "$legacy"
    elif [[ ! -f "$legacy/dist/server/server/main.js" ]]; then
      printf 'Kept %s: it does not look like a Patterm install.\n' "$legacy" >&2
    elif in_use "$legacy"; then
      printf 'Kept %s: a running process still uses it, such as an agent started before this update. Rerun with --update after those agents finish to remove it.\n' "$legacy" >&2
    else
      rm -rf -- "$legacy"
      printf 'Removed the earlier from-source install in %s.\n' "$legacy"
    fi
  done
}

[[ "$(uname -s)" == Linux ]] || fail 'Patterm releases support Linux only'
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) fail "no Patterm release for $(uname -m)" ;;
esac
for command in curl tar gzip sha256sum; do
  command -v "$command" >/dev/null 2>&1 || fail "$command is required"
done

if [[ -n "${PATTERM_RELEASE_URL:-}" ]]; then
  RELEASE_URL="${PATTERM_RELEASE_URL%/}"
elif [[ -n "$VERSION" ]]; then
  RELEASE_URL="https://github.com/$REPO/releases/download/v$VERSION"
else
  RELEASE_URL="https://github.com/$REPO/releases/latest/download"
fi
[[ "$REPO" != @* || -n "${PATTERM_RELEASE_URL:-}" ]] || fail 'run the install.sh attached to a release, or set PATTERM_RELEASE_URL'

SERVICE_ACTIVE=false
if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet patterm.service; then SERVICE_ACTIVE=true; fi
if $SERVICE_ACTIVE && ! $UPDATE; then
  fail 'the background service is running; rerun with --update to replace and restart it'
fi
if $UPDATE && ! command -v systemctl >/dev/null 2>&1; then fail '--update needs systemctl'; fi

DOWNLOADS="$(mktemp -d)"
STAGING=""
trap 'rm -rf "$DOWNLOADS" ${STAGING:+"$STAGING"}' EXIT
download() { curl --fail --silent --show-error --location --retry 3 --output "$DOWNLOADS/$1" "$RELEASE_URL/$1"; }

download manifest.json
download manifest.json.minisig

# An installed version trusts the key it shipped with, not this script's.
CURRENT="$PATTERM_HOME/current"
if [[ -f "$CURRENT/scripts/install-release.sh" ]]; then
  PUBLIC_KEY="$(sed -n 's/^PUBLIC_KEY="\(.*\)"$/\1/p' "$CURRENT/scripts/install-release.sh")"
fi
if [[ -x "$CURRENT/runtime/node" && -f "$CURRENT/scripts/verify-minisign.mjs" ]]; then
  "$CURRENT/runtime/node" "$CURRENT/scripts/verify-minisign.mjs" "$PUBLIC_KEY" "$DOWNLOADS/manifest.json" "$DOWNLOADS/manifest.json.minisig" >/dev/null \
    || fail 'the release manifest signature does not match the installed key'
elif command -v minisign >/dev/null 2>&1; then
  minisign -q -V -P "$PUBLIC_KEY" -m "$DOWNLOADS/manifest.json" -x "$DOWNLOADS/manifest.json.minisig" \
    || fail 'the release manifest signature does not match'
else
  printf 'minisign is not installed, so the manifest signature is not checked. The download is still checked against its SHA-256.\n' >&2
fi

# The release workflow writes one "key": "value" pair per line.
manifest_value() { sed -n "s/^ *\"$1\": *\"\{0,1\}\([^\",]*\)\"\{0,1\},\{0,1\}\$/\1/p" "$DOWNLOADS/manifest.json" | head -n 1; }
RELEASE_VERSION="$(manifest_value version)"
TARBALL="$(manifest_value "linux-$ARCH")"
EXPECTED_SHA256="$(manifest_value "linux-$ARCH-sha256")"
[[ "$RELEASE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || fail 'the release manifest has no valid version'
[[ -z "$VERSION" || "$VERSION" == "$RELEASE_VERSION" ]] || fail "the manifest is for $RELEASE_VERSION, not $VERSION"
[[ "$TARBALL" == "patterm-$RELEASE_VERSION-linux-$ARCH.tar.gz" && "$EXPECTED_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail "Patterm $RELEASE_VERSION has no linux-$ARCH build"

# Semantic version precedence (semver.org, item 11): compare MAJOR.MINOR.PATCH
# numerically, then a pre-release sorts before its release, and pre-release
# identifiers compare numerically, numbers before words, words in ASCII order.
identifiers_lt() {
  local LC_ALL=C x y i
  local -a a b
  IFS=. read -ra a <<< "$1"
  IFS=. read -ra b <<< "$2"
  for (( i = 0; i < ${#a[@]} && i < ${#b[@]}; i++ )); do
    x="${a[i]}" y="${b[i]}"
    [[ "$x" != "$y" ]] || continue
    if [[ "$x" =~ ^[0-9]+$ && "$y" =~ ^[0-9]+$ ]]; then (( 10#$x < 10#$y )); return
    elif [[ "$x" =~ ^[0-9]+$ ]]; then return 0
    elif [[ "$y" =~ ^[0-9]+$ ]]; then return 1
    else [[ "$x" < "$y" ]]; return
    fi
  done
  (( ${#a[@]} < ${#b[@]} ))
}
version_lt() {
  local a_core="${1%%-*}" b_core="${2%%-*}" a_pre="" b_pre=""
  [[ "$1" == *-* ]] && a_pre="${1#*-}"
  [[ "$2" == *-* ]] && b_pre="${2#*-}"
  if [[ "$a_core" != "$b_core" ]]; then identifiers_lt "$a_core" "$b_core"
  elif [[ -z "$a_pre" ]]; then return 1
  elif [[ -z "$b_pre" ]]; then return 0
  else identifiers_lt "$a_pre" "$b_pre"
  fi
}
INSTALLED_VERSION=""
[[ -f "$CURRENT/BUILD" ]] && INSTALLED_VERSION="$(sed -n 's/^version=//p' "$CURRENT/BUILD")"
if [[ "$INSTALLED_VERSION" == "$RELEASE_VERSION" ]]; then
  printf 'Patterm %s is already installed.\n' "$RELEASE_VERSION"
  # Finish removing a from-source install that an earlier update had to keep.
  if $UPDATE && $SERVICE_ACTIVE && curl --fail --silent --max-time 2 --output /dev/null "$(health_url)"; then HEALTHY=true; fi
  if $UPDATE; then remove_legacy; fi
  exit 0
fi
if [[ -n "$INSTALLED_VERSION" ]] && version_lt "$RELEASE_VERSION" "$INSTALLED_VERSION" && ! $ALLOW_DOWNGRADE; then
  fail "Patterm $INSTALLED_VERSION is newer than $RELEASE_VERSION. Its databases may not open in an older version; pass --allow-downgrade only to roll back with a matching backup."
fi

printf 'Downloading Patterm %s for linux-%s...\n' "$RELEASE_VERSION" "$ARCH"
download "$TARBALL"
printf '%s  %s\n' "$EXPECTED_SHA256" "$DOWNLOADS/$TARBALL" | sha256sum --check --quiet --strict \
  || fail "$TARBALL does not match the release's SHA-256"

mkdir -p "$PATTERM_HOME/versions" "$BIN_DIR" "$APPLICATIONS_DIR"
STAGING="$(mktemp -d "$PATTERM_HOME/versions/.staging.XXXXXX")"
tar -xzf "$DOWNLOADS/$TARBALL" -C "$STAGING" --no-same-owner
TARGET="$PATTERM_HOME/versions/$RELEASE_VERSION"
[[ -d "$STAGING/patterm-$RELEASE_VERSION-linux-$ARCH" ]] || fail "$TARBALL has an unexpected layout"
NEW_NODE="$STAGING/patterm-$RELEASE_VERSION-linux-$ARCH/runtime/node"
"$NEW_NODE" -e 'require("node:sqlite")' || fail 'the bundled Node does not run on this system'

PREVIOUS_TARGET=""
[[ -L "$CURRENT" ]] && PREVIOUS_TARGET="$(readlink "$CURRENT")"
# Never replace the directory the running version uses.
[[ "versions/$RELEASE_VERSION" != "$PREVIOUS_TARGET" ]] || fail "$TARGET is in use"
rm -rf "$TARGET"
mv "$STAGING/patterm-$RELEASE_VERSION-linux-$ARCH" "$TARGET"

swap_current() {
  ln -sfn "$1" "$PATTERM_HOME/current.new"
  mv -T "$PATTERM_HOME/current.new" "$CURRENT"
}

# An installed service is re-pointed at current, and restarted only if it was running.
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
SERVICE_FILES=("$CONFIG_HOME/patterm/patterm.env" "$CONFIG_HOME/systemd/user/patterm.service" "$CONFIG_HOME/systemd/user/patterm-terminal@.service")
SERVICE_CONFIGURED=false
[[ -f "${SERVICE_FILES[0]}" ]] && SERVICE_CONFIGURED=true
SWAPPED=false
SERVICE_STOPPED=false
APP_STARTED=false
restore() {
  local status=$?
  if (( status != 0 )) && $SWAPPED && ! $APP_STARTED; then
    if [[ -n "$PREVIOUS_TARGET" ]]; then swap_current "$PREVIOUS_TARGET"; else rm -f "$CURRENT"; fi
    if $SERVICE_CONFIGURED; then
      for file in "${SERVICE_FILES[@]}"; do
        [[ -f "$DOWNLOADS/service-backup/$(basename "$file")" ]] && cp -p "$DOWNLOADS/service-backup/$(basename "$file")" "$file"
      done
      systemctl --user daemon-reload || true
      if $SERVICE_STOPPED; then systemctl --user start patterm.service || true; fi
    fi
  fi
  rm -rf "$DOWNLOADS" ${STAGING:+"$STAGING"}
  exit "$status"
}
trap restore EXIT

if $SERVICE_CONFIGURED; then
  # Check the new version can render the service before stopping the old one.
  "$TARGET/runtime/node" "$TARGET/scripts/install-service.mjs" --update --output-dir "$DOWNLOADS/service-preview" >/dev/null
  mkdir -p "$DOWNLOADS/service-backup"
  for file in "${SERVICE_FILES[@]}"; do [[ ! -f "$file" ]] || cp -p "$file" "$DOWNLOADS/service-backup/"; done
fi
if $SERVICE_ACTIVE; then
  systemctl --user stop patterm.service
  SERVICE_STOPPED=true
fi
SWAPPED=true
swap_current "versions/$RELEASE_VERSION"
if $SERVICE_CONFIGURED; then
  "$CURRENT/runtime/node" "$CURRENT/scripts/install-service.mjs" --update >/dev/null
  systemctl --user daemon-reload
fi

ln -sfn "$CURRENT/scripts/patterm.sh" "$BIN_DIR/patterm"
cat > "$APPLICATIONS_DIR/patterm.desktop" <<EOF
[Desktop Entry]
Name=Patterm
Comment=Project agent workbench
Exec=$BIN_DIR/patterm
Type=Application
Terminal=false
Categories=Development;Utility;
StartupWMClass=patterm-desktop
EOF
chmod 0644 "$APPLICATIONS_DIR/patterm.desktop"
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database "$APPLICATIONS_DIR" >/dev/null 2>&1 || true; fi

if $SERVICE_STOPPED; then
  # A start can migrate databases, so never switch back automatically after it.
  APP_STARTED=true
  systemctl --user start patterm.service
  HEALTH_URL="$(health_url)"
  for (( waited = 0; ; waited += 2 )); do
    if curl --fail --silent --max-time 2 --output /dev/null "$HEALTH_URL"; then break; fi
    if (( waited >= 600 )) || systemctl --user is-failed --quiet patterm.service; then
      printf 'error: patterm.service is not healthy at %s. Check: journalctl --user -u patterm.service -n 100\n' "$HEALTH_URL" >&2
      [[ -n "$PREVIOUS_TARGET" ]] && printf 'To roll back, point %s at %s and restore the newest backups/pre-migration-* set, as README.md describes.\n' "$CURRENT" "$PREVIOUS_TARGET" >&2
      exit 1
    fi
    sleep 2
  done
  HEALTHY=true
fi

# Keep the version in use and the one before it.
for directory in "$PATTERM_HOME"/versions/*/; do
  name="versions/$(basename "$directory")"
  [[ "$name" == "versions/$RELEASE_VERSION" || "$name" == "$PREVIOUS_TARGET" ]] || rm -rf "$directory"
done

printf 'Patterm %s installed in %s.\n' "$RELEASE_VERSION" "$TARGET"
remove_legacy

if ! $UPDATE; then
  printf 'Launch the desktop app with %s, or start the background service with: patterm --headless\n' "$BIN_DIR/patterm"
  case ":$PATH:" in *":$BIN_DIR:"*) ;; *) printf 'Add %s to your PATH to run patterm by name.\n' "$BIN_DIR" ;; esac
fi
