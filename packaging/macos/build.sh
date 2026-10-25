#!/usr/bin/env bash
# Builds Etude.app and Etude-<version>-<arch>.dmg on macOS.
# Needs: Xcode command line tools (swiftc), node + npm (to build the web app), curl.
# Usage: packaging/macos/build.sh [arm64|x64]   (default: this Mac's architecture)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/packaging/macos"
ARCH="${1:-$(uname -m)}"; [ "$ARCH" = "x86_64" ] && ARCH=x64
NODE_VERSION="${NODE_VERSION:-24.22.1}"
VERSION="$(node -p "require('$ROOT/package.json').version")"
OUT="$ROOT/dist/macos"
APP="$OUT/$ARCH/Etude.app"
RES="$APP/Contents/Resources"

echo "Etude $VERSION for macOS $ARCH (Node $NODE_VERSION)"
rm -rf "$OUT/$ARCH" && mkdir -p "$RES" "$APP/Contents/MacOS"

# 1. The web app.
if [ ! -f "$ROOT/web/dist/index.html" ] || [ "${REBUILD_WEB:-0}" = 1 ]; then (cd "$ROOT" && npm run build); fi

# 2. The Etude server, with only its runtime dependencies (the web app is prebuilt).
mkdir -p "$RES/app/web"
cp -R "$ROOT/bin" "$ROOT/src" "$ROOT/runtime" "$ROOT/types" "$ROOT/examples" "$ROOT/LICENSE" "$RES/app/"
cp -R "$ROOT/web/dist" "$RES/app/web/"
node -e '
  const p = require(process.argv[1]);
  const keep = ["hono", "@hono/node-server", "ts-fsrs", "quickjs-emscripten"];
  p.dependencies = Object.fromEntries(Object.entries(p.dependencies).filter(([k]) => keep.includes(k)));
  delete p.devDependencies; delete p.scripts;
  require("fs").writeFileSync(process.argv[2], JSON.stringify(p, null, 2));
' "$ROOT/package.json" "$RES/app/package.json"
(cd "$RES/app" && npm install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)

# 3. Node itself.
CACHE="$HERE/.cache"; mkdir -p "$CACHE"
TARBALL="node-v$NODE_VERSION-darwin-$ARCH.tar.gz"
[ -f "$CACHE/$TARBALL" ] || curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$TARBALL" -o "$CACHE/$TARBALL"
curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | grep " $TARBALL\$" | (cd "$CACHE" && shasum -a 256 -c -)
mkdir -p "$RES/node/bin"
tar -xzf "$CACHE/$TARBALL" -C "$CACHE"
cp "$CACHE/node-v$NODE_VERSION-darwin-$ARCH/bin/node" "$RES/node/bin/node"
cp "$CACHE/node-v$NODE_VERSION-darwin-$ARCH/LICENSE" "$RES/node/LICENSE"

# 4. The native window.
TARGET="arm64-apple-macos12"; [ "$ARCH" = x64 ] && TARGET="x86_64-apple-macos12"
swiftc -O -target "$TARGET" "$HERE/Etude.swift" -o "$APP/Contents/MacOS/Etude" -framework Cocoa -framework WebKit

# 5. Icon and Info.plist.
ICONSET="$OUT/Etude.iconset"; rm -rf "$ICONSET"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$HERE/icon1024.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$HERE/icon1024.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$RES/Etude.icns"
sed "s/{{VERSION}}/$VERSION/g" "$HERE/Info.plist" > "$APP/Contents/Info.plist"

# 6. Sign (ad hoc unless SIGN_IDENTITY is a Developer ID) and pack the disk image.
IDENTITY="${SIGN_IDENTITY:--}"
codesign --force --sign "$IDENTITY" --options runtime --entitlements "$HERE/entitlements.plist" "$RES/node/bin/node"
codesign --force --sign "$IDENTITY" --options runtime --entitlements "$HERE/entitlements.plist" "$APP"
codesign --verify --deep --strict "$APP"

NAME=$([ "$ARCH" = x64 ] && echo intel || echo apple-silicon)
DMG="$OUT/Etude-mac-$NAME.dmg"
STAGE="$OUT/$ARCH/dmg"; rm -rf "$STAGE"; mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/" && ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "Etude" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG" >/dev/null
rm -rf "$STAGE"
if [ "$IDENTITY" != "-" ]; then codesign --force --sign "$IDENTITY" "$DMG"; fi
echo "$DMG ($(du -h "$DMG" | cut -f1))"
