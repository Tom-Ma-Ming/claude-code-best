#!/bin/sh
# Remove the ccb install this script lives in. Leaves ~/.ccb untouched.
set -e
TARGET="$(cd "$(dirname "$0")" && pwd)"
for bin in /usr/local/bin/ccb "$HOME/.local/bin/ccb" "$(dirname "$TARGET")/bin/ccb"; do
  if [ -L "$bin" ] && [ "$(readlink -f "$bin")" = "$TARGET/bin/ccb" ]; then rm -f "$bin"; echo "removed $bin"; fi
done
rm -rf "$TARGET"
echo "removed $TARGET (your ~/.ccb config and sessions were kept)"
