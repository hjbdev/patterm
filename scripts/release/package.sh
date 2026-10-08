#!/usr/bin/env bash
# Packages a built checkout as a Linux release tarball with bundled Node,
# Electron, and a static terminal sidecar. Run the builds first:
#   pnpm run build:main && pnpm exec tsc -p tsconfig.server.json
#   pnpm run build:renderer && pnpm run build:mcp
# Usage: package.sh --version 1.2.0 --arch x64|arm64 --sidecar PATH --repo OWNER/NAME --out DIR
set -euo pipefail

# Node's current LTS line, checked against hashes pinned here.
NODE_VERSION=24.21.0
declare -A NODE_SHA256=(
  [x64]=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
  [arm64]=6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2
)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION="" ARCH="" SIDECAR="" REPO="" OUT=""
while (( $# )); do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --arch) ARCH="${2:-}"; shift 2 ;;
    --sidecar) SIDECAR="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    *) printf 'Usage: package.sh --version VERSION --arch x64|arm64 --sidecar PATH --repo OWNER/NAME --out DIR\n' >&2; exit 1 ;;
  esac
done
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { printf 'error: --version must be a semantic version without a leading v\n' >&2; exit 1; }
[[ -n "${NODE_SHA256[$ARCH]:-}" ]] || { printf 'error: --arch must be x64 or arm64\n' >&2; exit 1; }
[[ -x "$SIDECAR" ]] || { printf 'error: --sidecar must name the built release sidecar\n' >&2; exit 1; }
[[ -n "$OUT" ]] || { printf 'error: --out is required\n' >&2; exit 1; }
# The sidecar runs on any distribution only if nothing links it to glibc.
if file -b "$SIDECAR" | grep -q 'dynamically linked'; then
  printf 'error: %s is dynamically linked; build it for the musl target\n' "$SIDECAR" >&2
  exit 1
fi
for file in dist/main/desktop/main/main.js dist/server/server/main.js dist/renderer/index.html dist/mcp/patterm-mcp.js; do
  [[ -f "$ROOT/$file" ]] || { printf 'error: %s is missing; build first\n' "$file" >&2; exit 1; }
done
# Shiki's GPL-3.0 grammars and theme must stay out of releases. The renderer
# bundles only the languages in resources/js/lib/shiki.ts.
GPL_SHIKI=(ada gnuplot nginx racket aurora-x)
# Grammars name themselves in JSON, escaped inside the published modules.
GPL_SHIKI_PATTERN='\\?"name\\?":\\?"('"$(IFS='|'; printf '%s' "${GPL_SHIKI[*]}")"')\\?"'
if grep -rlE "$GPL_SHIKI_PATTERN" "$ROOT/dist/renderer"; then
  printf 'error: the renderer build includes a GPL-3.0 Shiki grammar or theme\n' >&2
  exit 1
fi

NAME="patterm-$VERSION-linux-$ARCH"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
STAGE="$OUT/$NAME"
DOWNLOADS="$(mktemp -d)"
trap 'rm -rf "$DOWNLOADS"' EXIT
rm -rf "$STAGE" "$OUT/$NAME.tar.gz" "$OUT/$NAME.tar.gz.sha256"
mkdir -p "$STAGE/dist" "$STAGE/runtime" "$STAGE/resources/native" "$STAGE/resources/mcp" "$STAGE/scripts" "$STAGE/deploy" "$STAGE/native/terminal-core/target/release"

cp -a "$ROOT/dist/main" "$ROOT/dist/server" "$ROOT/dist/renderer" "$ROOT/dist/mcp" "$STAGE/dist/"
cp "$ROOT/package.json" "$ROOT/LICENSE" "$ROOT/THIRD_PARTY_NOTICES.md" "$STAGE/"
# The tag is the version; package.json in the repository stays at its placeholder.
node -e 'const fs = require("fs"); const file = process.argv[1]; const data = JSON.parse(fs.readFileSync(file, "utf8")); data.version = process.argv[2]; fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);' "$STAGE/package.json" "$VERSION"

# Production dependencies only. None are native, so one install serves both architectures.
cp "$ROOT/pnpm-lock.yaml" "$ROOT/pnpm-workspace.yaml" "$STAGE/"
(cd "$STAGE" && pnpm install --prod --frozen-lockfile --ignore-scripts --config.node-linker=hoisted --reporter=silent)
rm -f "$STAGE/pnpm-lock.yaml" "$STAGE/pnpm-workspace.yaml"
[[ ! -e "$STAGE/node_modules/electron" ]] || { printf 'error: the production install includes electron\n' >&2; exit 1; }
# Remove them, and shiki's re-exports of them.
for name in "${GPL_SHIKI[@]}"; do
  rm -f "$STAGE"/node_modules/{@shikijs/langs/dist,@shikijs/themes/dist,shiki/dist/langs,shiki/dist/themes}/"$name".{mjs,d.mts}
done
if grep -rlE "$GPL_SHIKI_PATTERN" "$STAGE/node_modules"; then
  printf 'error: the production install still includes a GPL-3.0 Shiki grammar or theme\n' >&2
  exit 1
fi

# Electron for the desktop app, checked against the hashes in its npm package.
ELECTRON_VERSION="$(node -p 'require(process.argv[1]).version' "$ROOT/node_modules/electron/package.json")"
ELECTRON_ZIP="electron-v$ELECTRON_VERSION-linux-$ARCH.zip"
curl --fail --silent --show-error --location --retry 3 --output "$DOWNLOADS/$ELECTRON_ZIP" "https://github.com/electron/electron/releases/download/v$ELECTRON_VERSION/$ELECTRON_ZIP"
ELECTRON_SHA256="$(node -p 'require(process.argv[1])[process.argv[2]] ?? ""' "$ROOT/node_modules/electron/checksums.json" "$ELECTRON_ZIP")"
printf '%s  %s\n' "$ELECTRON_SHA256" "$DOWNLOADS/$ELECTRON_ZIP" | sha256sum --check --quiet
unzip -q "$DOWNLOADS/$ELECTRON_ZIP" -d "$STAGE/electron"

# Node for the headless service, which must not need GTK or a system Node.
NODE_TARBALL="node-v$NODE_VERSION-linux-$ARCH.tar.xz"
curl --fail --silent --show-error --location --retry 3 --output "$DOWNLOADS/$NODE_TARBALL" "https://nodejs.org/dist/v$NODE_VERSION/$NODE_TARBALL"
printf '%s  %s\n' "${NODE_SHA256[$ARCH]}" "$DOWNLOADS/$NODE_TARBALL" | sha256sum --check --quiet
tar -xJf "$DOWNLOADS/$NODE_TARBALL" -C "$DOWNLOADS" "node-v$NODE_VERSION-linux-$ARCH/bin/node" "node-v$NODE_VERSION-linux-$ARCH/LICENSE"
mv "$DOWNLOADS/node-v$NODE_VERSION-linux-$ARCH/bin/node" "$STAGE/runtime/node"
mv "$DOWNLOADS/node-v$NODE_VERSION-linux-$ARCH/LICENSE" "$STAGE/runtime/LICENSE"

# One sidecar serves both apps; the service finds it at its source-tree path.
install -m 0755 "$SIDECAR" "$STAGE/resources/native/patterm-terminal-core"
ln -s ../../../../resources/native/patterm-terminal-core "$STAGE/native/terminal-core/target/release/patterm-terminal-core"
cp "$ROOT/dist/mcp/patterm-mcp.js" "$STAGE/resources/mcp/patterm-mcp.js"
install -m 0755 "$ROOT/scripts/patterm.sh" "$STAGE/scripts/patterm.sh"
cp "$ROOT/scripts/install-service.mjs" "$ROOT/scripts/start-tailscale-service.mjs" "$ROOT/scripts/release/verify-minisign.mjs" "$STAGE/scripts/"
# Installed copies keep the signing key that later updates are checked with.
"$ROOT/scripts/release/render-installer.sh" "$REPO" > "$OUT/install.sh"
install -m 0755 "$OUT/install.sh" "$STAGE/scripts/install-release.sh"
install -m 0755 "$ROOT/scripts/release/uninstall.sh" "$STAGE/scripts/uninstall.sh"
cp "$ROOT/deploy/patterm.service" "$ROOT/deploy/patterm-terminal@.service" "$STAGE/deploy/"

COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
{
  printf 'version=%s\n' "$VERSION"
  printf 'commit=%s\n' "$COMMIT"
  if [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then printf 'dirty=true\n'; fi
  printf 'built_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$STAGE/BUILD"

# Stable ordering, ownership, and times, so the tarball depends only on its contents.
EPOCH="$(git -C "$ROOT" log -1 --format=%ct)"
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$EPOCH" -C "$OUT" -cf - "$NAME" | gzip -n -9 > "$OUT/$NAME.tar.gz"
(cd "$OUT" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
rm -rf "$STAGE"
printf '%s\n' "$OUT/$NAME.tar.gz"
