#!/usr/bin/env bash
# Regenerates the website's screenshots from a fresh demo collection.
# site/tools/capture.sh   (needs chromium, ImageMagick and a built web app: npm run build)
set -euo pipefail
cd "$(dirname "$0")/../.."
tmp="${TMPDIR:-/tmp}/etude-site-capture"
mkdir -p "$tmp"
node site/tools/demo-db.ts "$tmp/demo.db"
port=4697
node src/cli/main.ts --db "$tmp/demo.db" serve --port $port >"$tmp/serve.log" 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null || true' EXIT
for _ in $(seq 50); do curl -sf "http://127.0.0.1:$port/api/decks" >/dev/null && break; sleep 0.2; done
rm -rf "$tmp/png"
node site/tools/shoot.mjs "http://127.0.0.1:$port" "$tmp/png" site/tools/shots.json
out=site/src/assets/shots
mkdir -p "$out"
for f in "$tmp"/png/*.png; do
  n=$(basename "$f" .png)
  case "$n" in
    card-*) magick "$f" -resize 1200x\> -quality 86 "$out/$n.webp" ;;
    phone-*) magick "$f" -resize 804x\> -quality 88 "$out/$n.webp" ;;
    *) magick "$f" -resize 2400x\> -quality 84 "$out/$n.webp" ;;
  esac
done
ls -la "$out"
