#!/usr/bin/env bash
# Build an offline Linux x86_64 tarball of ccb.
#
#   bun run package:linux            # builds dist first
#   bun run package:linux --no-build # reuse existing dist/
#
# Downloads bun and ripgrep release binaries into .cache/package/ (override
# with CCB_PKG_CACHE) the first time; later runs are offline.
set -euo pipefail
cd "$(dirname "$0")/.."

BUN_VERSION="${BUN_VERSION:-$(bun --version)}"
RG_VERSION="${RG_VERSION:-14.1.1}"
CACHE="${CCB_PKG_CACHE:-.cache/package}"
VERSION="$(bun -e 'console.log(require("./package.json").version)')"
NAME="ccb-${VERSION}-linux-x64"
OUT_DIR="${CCB_PKG_OUT:-release}"
BUILD=1
for arg in "$@"; do case "$arg" in --no-build) BUILD=0 ;; esac; done

fetch() { # url dest
  if [ ! -f "$2" ]; then
    echo "downloading $(basename "$2")"
    curl -fsSL --retry 3 -o "$2.part" "$1" && mv "$2.part" "$2"
  fi
}

mkdir -p "$CACHE" "$OUT_DIR"
BUN_BASE="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}"
fetch "$BUN_BASE/bun-linux-x64.zip" "$CACHE/bun-${BUN_VERSION}-linux-x64.zip"
fetch "$BUN_BASE/bun-linux-x64-baseline.zip" "$CACHE/bun-${BUN_VERSION}-linux-x64-baseline.zip"
fetch "https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-x86_64-unknown-linux-musl.tar.gz" "$CACHE/ripgrep-${RG_VERSION}-linux-x64.tar.gz"

if [ "$BUILD" = 1 ]; then
  echo "building dist/"
  bun run build:vite >/dev/null
fi
[ -f dist/cli.js ] || { echo "dist/cli.js missing — run without --no-build" >&2; exit 1; }

STAGE="$(mktemp -d)/$NAME"
mkdir -p "$STAGE/bin" "$STAGE/dist/vendor/ripgrep/x64-linux"
trap 'rm -rf "$(dirname "$STAGE")"' EXIT

cp -R dist/. "$STAGE/dist/"
rm -rf "$STAGE/dist/vendor/ripgrep/x64-darwin" "$STAGE/dist/vendor/ripgrep/arm64-darwin"
cp -R packages/devflow/skills "$STAGE/skills"

unzip -q -o "$CACHE/bun-${BUN_VERSION}-linux-x64.zip" -d "$STAGE/.bun"
unzip -q -o "$CACHE/bun-${BUN_VERSION}-linux-x64-baseline.zip" -d "$STAGE/.bun"
mv "$STAGE/.bun/bun-linux-x64/bun" "$STAGE/bin/bun"
mv "$STAGE/.bun/bun-linux-x64-baseline/bun" "$STAGE/bin/bun-baseline"
rm -rf "$STAGE/.bun"
tar xzf "$CACHE/ripgrep-${RG_VERSION}-linux-x64.tar.gz" -C "$STAGE" --strip-components=1 "ripgrep-${RG_VERSION}-x86_64-unknown-linux-musl/rg"
mv "$STAGE/rg" "$STAGE/dist/vendor/ripgrep/x64-linux/rg"

cp scripts/package/ccb "$STAGE/bin/ccb"
cp scripts/package/install.sh scripts/package/uninstall.sh scripts/package/README.md scripts/package/ccb-settings.example.json "$STAGE/"
echo "$VERSION" > "$STAGE/VERSION"
chmod +x "$STAGE/bin/"* "$STAGE/install.sh" "$STAGE/uninstall.sh" "$STAGE/dist/vendor/ripgrep/x64-linux/rg"

COPYFILE_DISABLE=1 tar --no-xattrs -C "$(dirname "$STAGE")" -czf "$OUT_DIR/$NAME.tar.gz" "$NAME"
(cd "$OUT_DIR" && shasum -a 256 "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
echo "wrote $OUT_DIR/$NAME.tar.gz ($(du -h "$OUT_DIR/$NAME.tar.gz" | cut -f1))"
