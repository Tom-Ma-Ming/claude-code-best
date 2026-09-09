#!/bin/sh
# Install ccb from this unpacked directory.
#   sudo ./install.sh                 → /opt/ccb, symlink /usr/local/bin/ccb
#   ./install.sh --prefix ~/.local    → ~/.local/ccb, symlink ~/.local/bin/ccb
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
PREFIX=""
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --prefix=*) PREFIX="${1#--prefix=}"; shift ;;
    -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$PREFIX" ]; then
  if [ "$(id -u)" = "0" ]; then PREFIX=/opt; BIN_DIR=/usr/local/bin
  else PREFIX="$HOME/.local"; BIN_DIR="$HOME/.local/bin"; fi
else
  BIN_DIR="$PREFIX/bin"
fi
TARGET="$PREFIX/ccb"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) ;;
  *) echo "This package is built for Linux x86_64; this machine is $(uname -s)-$(uname -m)." >&2; exit 1 ;;
esac

VERSION="$(cat "$HERE/VERSION")"
echo "Installing ccb $VERSION → $TARGET"
mkdir -p "$TARGET" "$BIN_DIR"
# Replace in place; keep nothing from an older version.
rm -rf "$TARGET/bin" "$TARGET/dist" "$TARGET/skills"
cp -R "$HERE/bin" "$HERE/dist" "$HERE/skills" "$TARGET/"
cp "$HERE/VERSION" "$HERE/uninstall.sh" "$HERE/ccb-settings.example.json" "$TARGET/"
chmod +x "$TARGET/bin/"* "$TARGET/dist/vendor/ripgrep/x64-linux/rg" "$TARGET/uninstall.sh"
ln -sfn "$TARGET/bin/ccb" "$BIN_DIR/ccb"

# Smoke test with the freshly linked binary.
"$BIN_DIR/ccb" --version >/dev/null

cat <<MSG

ccb $VERSION installed.
  binary   $BIN_DIR/ccb
  files    $TARGET
  config   ~/.ccb/settings.json   (example: $TARGET/ccb-settings.example.json)

Next:
  1. mkdir -p ~/.ccb && cp $TARGET/ccb-settings.example.json ~/.ccb/settings.json
     then edit ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / model names.
  2. ccb doctor
  3. ccb devflow skills install     (optional, for the devflow pipeline)
MSG
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "NOTE: $BIN_DIR is not on your PATH." ;; esac
