#!/usr/bin/env bash
# Per-user macOS install/update. Quit Patterm, then rerun this script.
# curl -fsSL https://github.com/hjbdev/patterm/releases/latest/download/install-macos.sh | bash
set -euo pipefail

REPO=hjbdev/patterm
APPLICATIONS_DIR="${PATTERM_MAC_APPLICATIONS_DIR:-$HOME/Applications}"
if [[ -z "${PATTERM_MAC_APPLICATIONS_DIR:-}" && -d /Applications/Patterm.app ]]; then APPLICATIONS_DIR=/Applications; fi
VERSION="" ALLOW_DOWNGRADE=false
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
while (( $# )); do
  case "$1" in
    --version) VERSION="${2:-}"; VERSION="${VERSION#v}"; [[ -n "$VERSION" ]] || fail '--version needs a value'; shift 2 ;;
    --allow-downgrade) ALLOW_DOWNGRADE=true; shift ;;
    -h|--help) printf 'Usage: install-macos.sh [--version VERSION] [--allow-downgrade]\nInstalls in ~/Applications; set PATTERM_MAC_APPLICATIONS_DIR to choose another directory.\n'; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done
[[ "$(uname -s)" == Darwin ]] || fail 'this installer requires macOS'
case "$(uname -m)" in arm64) ARCH=arm64 ;; x86_64) ARCH=x64 ;; *) fail 'unsupported Mac architecture' ;; esac
for command in curl shasum ditto plutil codesign unzip pgrep; do
  command -v "$command" >/dev/null 2>&1 || fail "$command is required"
done

# Keep staging on the destination filesystem so the final renames are atomic.
mkdir -p "$APPLICATIONS_DIR"
APPLICATIONS_DIR="$(cd "$APPLICATIONS_DIR" && pwd -P)"
[[ -w "$APPLICATIONS_DIR" ]] || fail "$APPLICATIONS_DIR is not writable; choose a writable PATTERM_MAC_APPLICATIONS_DIR"
TARGET="$APPLICATIONS_DIR/Patterm.app"
PREVIOUS="$APPLICATIONS_DIR/Patterm.previous.app"
LOCK="$APPLICATIONS_DIR/.patterm-install.lock"
mkdir "$LOCK" 2>/dev/null || fail "another installer is running; if it was interrupted, remove $LOCK and retry"
STAGING="" SWAPPED=false
cleanup() {
  local status=$?
  # The installer never launches the app or migrates data, so a failed switch
  # can safely put the original bundle back.
  if (( status != 0 )) && $SWAPPED && [[ ! -e "$TARGET" && -d "$PREVIOUS" ]]; then
    mv "$PREVIOUS" "$TARGET" || true
  fi
  [[ -z "$STAGING" ]] || rm -rf "$STAGING"
  rmdir "$LOCK"
  exit "$status"
}
trap cleanup EXIT
STAGING="$(mktemp -d "$APPLICATIONS_DIR/.patterm-staging.XXXXXX")"
if [[ -z "$VERSION" ]]; then
  curl --fail --silent --show-error --location --retry 3 --output "$STAGING/release.json" "https://api.github.com/repos/$REPO/releases/latest"
  VERSION="$(plutil -extract tag_name raw -o - "$STAGING/release.json")"
  VERSION="${VERSION#v}"
fi
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || fail 'invalid release version'
RELEASE_URL="${PATTERM_MAC_RELEASE_URL:-https://github.com/$REPO/releases/download/v$VERSION}"
NAME="patterm-$VERSION-macos-$ARCH.zip"
printf 'Downloading Patterm %s for macos-%s...\n' "$VERSION" "$ARCH"
for file in "$NAME" "$NAME.sha256"; do
  curl --fail --silent --show-error --location --retry 3 --output "$STAGING/$file" "${RELEASE_URL%/}/$file"
done
read -r HASH HASH_NAME < "$STAGING/$NAME.sha256"
[[ "$HASH" =~ ^[0-9a-fA-F]{64}$ && "$HASH_NAME" == "$NAME" ]] || fail 'invalid package checksum file'
HASH="$(printf '%s' "$HASH" | tr '[:upper:]' '[:lower:]')"
ACTUAL="$(shasum -a 256 "$STAGING/$NAME")"
[[ "${ACTUAL%% *}" == "$HASH" ]] || fail 'package checksum verification failed'
unzip -Z1 "$STAGING/$NAME" > "$STAGING/entries"
while IFS= read -r entry; do
  case "$entry" in
    Patterm.app/|Patterm.app/*|__MACOSX/|__MACOSX/*) ;;
    *) fail "unsafe archive entry: $entry" ;;
  esac
  case "/$entry" in *'/../'*|*'/./'*|*'\'*) fail "unsafe archive entry: $entry" ;; esac
done < "$STAGING/entries"
ditto -x -k "$STAGING/$NAME" "$STAGING/extracted"
BUNDLE="$STAGING/extracted/Patterm.app"
BUILD="$BUNDLE/Contents/Resources/app/BUILD"
[[ -x "$BUNDLE/Contents/MacOS/Patterm" && -f "$BUILD" ]] || fail 'package is missing the Patterm app or BUILD'
[[ "$(sed -n 's/^version=//p' "$BUILD")" == "$VERSION" ]] || fail 'package version does not match the release'
[[ "$(plutil -extract CFBundleIdentifier raw -o - "$BUNDLE/Contents/Info.plist")" == cloud.bayliss.patterm ]] || fail 'unexpected app identity'
codesign --verify --deep --strict "$BUNDLE" || fail 'app signature verification failed'

# Semantic version precedence, including numeric prerelease identifiers.
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
assert_stopped() {
  local status
  # Match the kernel process name, not argv[0], which may be ./Patterm.
  # Refuse while any Patterm app runs, including a manually installed copy.
  if pgrep -x Patterm >/dev/null; then
    fail 'Patterm is running. Quit it, then rerun this installer to update.'
  else
    status=$?
    [[ "$status" == 1 ]] || fail 'cannot check running apps; quit Patterm and retry'
  fi
}
assert_stopped
if [[ -e "$TARGET" ]]; then
  INSTALLED_BUILD="$TARGET/Contents/Resources/app/BUILD"
  [[ -f "$INSTALLED_BUILD" ]] || fail 'existing Patterm.app has no BUILD; replace it manually'
  INSTALLED_VERSION="$(sed -n 's/^version=//p' "$INSTALLED_BUILD")"
  [[ "$INSTALLED_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || fail 'invalid installed version'
  if version_lt "$VERSION" "$INSTALLED_VERSION" && ! $ALLOW_DOWNGRADE; then
    fail "Patterm $INSTALLED_VERSION is newer than $VERSION. Use --allow-downgrade only with a matching database backup."
  fi
  if [[ "$INSTALLED_VERSION" == "$VERSION" ]]; then
    printf 'Patterm %s is already installed.\n' "$VERSION"
    exit 0
  fi
  rm -rf "$PREVIOUS"
  mv "$TARGET" "$PREVIOUS"
  SWAPPED=true
fi
mv "$BUNDLE" "$TARGET"
printf 'Patterm %s installed in %s. Open it from Finder.\n' "$VERSION" "$TARGET"
printf 'macOS builds are experimental and not notarized; macOS may require Privacy & Security > Open Anyway.\n'
