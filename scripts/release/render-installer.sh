#!/usr/bin/env bash
# Prints install.sh with the repository and signing key filled in. The tarball
# and the published release asset both use this, so installed copies carry
# the key that later updates are checked with.
# Usage: render-installer.sh OWNER/NAME [minisign.pub] > install.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${1:-}"
KEY_FILE="${2:-$DIR/minisign.pub}"
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { printf 'Usage: render-installer.sh OWNER/NAME [minisign.pub]\n' >&2; exit 1; }
KEY="$(sed -n 2p "$KEY_FILE")"
# A minisign public key is 42 bytes, 56 base64 characters without padding.
[[ "$KEY" =~ ^[A-Za-z0-9+/]{56}$ ]] || { printf 'error: %s has no minisign public key\n' "$KEY_FILE" >&2; exit 1; }
sed -e "s|@PATTERM_REPO@|$REPO|g" -e "s|@MINISIGN_PUBLIC_KEY@|$KEY|g" "$DIR/install.sh"
