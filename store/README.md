# Store listing kit

Everything App Store Connect and Play Console ask for, except what only João can provide (accounts, signing, payment, ID).

| File | What it is |
|---|---|
| `listing.md` | Name, subtitle, keywords, short and full description, release notes, URLs, category |
| `apple.md` | App Store Connect answers: app information, content rights, privacy label, age rating, App Review notes, demo account plan, export compliance, screenshot slots |
| `google.md` | Play Console answers: store listing, app content, content rating, Data safety, account deletion, testing |
| `screenshots/<target>/` | 6 screenshots per size, PNG without alpha, numbered in store order |
| `graphics/` | Play icon 512 × 512 and feature graphic 1024 × 500 |
| `tools/screens.mjs` | Re-captures the screenshots from a running app |
| `tools/graphics.mjs` | Rebuilds the feature graphic and icon |
| `tools/check-lengths.py` | Checks the text in `listing.md` against the store limits |

Screenshot sizes: iPhone 6.9" 1320 × 2868, iPhone 6.5" 1284 × 2778, iPad 13" 2064 × 2752, Android phone 1080 × 1920, 7" tablet 1200 × 1920, 10" tablet 1600 × 2560.

## Regenerating the screenshots

They come from the real web app, the same build the phone apps wrap, on a scratch copy of a collection. Never point them at a live collection.

```sh
export ETUDE_HOME=$(mktemp -d)
sqlite3 ~/path/to/etude.db ".backup $ETUDE_HOME/etude.db"     # or import the Showcase and Market decks
node src/cli/main.ts deck archive "<deck you don't want shown>"
npm run build && npm run site                                  # the captions use the site's fonts from site/dist
node src/cli/main.ts serve --port 4632 &
node store/tools/screens.mjs http://127.0.0.1:4632 /tmp/etude-shots
node store/tools/graphics.mjs /tmp/etude-shots store/graphics path/to/icon-1024.png
for t in /tmp/etude-shots/*/; do n=$(basename $t); [ $n = raw ] && continue; mkdir -p store/screenshots/$n; for f in $t*.png; do magick $f -alpha off -define png:color-type=2 store/screenshots/$n/$(basename $f); done; done
```

`screens.mjs` fails on any console error. The scenes (deck names, captions) are at the top of the file; they expect the Countries of the World, Periodic table and Morse code decks.

The shots show the app at its Score phone layout below 700 px wide and the desktop layout on the tablets. The iOS and Android apps hide Publish and the GitHub link in the Market, so `screens.mjs` hides them too.
