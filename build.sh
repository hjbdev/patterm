#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEBUG=false
if [[ "${1:-}" == --debug && $# == 1 ]]; then
  DEBUG=true
elif (( $# )); then
  printf 'Usage: build.sh [--debug]\n' >&2
  exit 1
fi

export PATH="$HOME/.cargo/bin:$PATH"

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

if ! command_exists pnpm; then
  printf 'error: pnpm is required\n' >&2
  exit 1
fi

if ! command_exists cargo; then
  printf 'error: cargo is required to build the terminal sidecar\n' >&2
  exit 1
fi

cd "$SCRIPT_DIR"

pnpm install --frozen-lockfile
# build:server builds the renderer, MCP shim and release sidecar for both apps.
pnpm run build:main
pnpm run build:server
if $DEBUG; then pnpm run build:sidecar; fi

printf 'Production build complete.\n'
