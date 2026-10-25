# Website

The Etude website: a landing page and a download page, built into `site/dist` as plain static files for GitHub Pages.

```sh
npm run build        # the web app; the site copies its card runtime and editor kit
npm run site         # builds site/dist
npm run site:serve   # http://127.0.0.1:4620/etude/, served the way GitHub Pages serves it
```

The hero runs real card types from `examples/showcase/`: `build.ts` turns each type into a frame document with the same `cardFrame()` the server uses, and the page runs the type's `prepare` and `grade` scripts with the sandbox's own prelude (`std`, seeded `rng`). The exam chart runs the real scheduler (ts-fsrs) with Etude's deadline rule. Nothing on the page is a mockup of a card.

| | |
|---|---|
| `src/` | pages, styles and scripts; `{{VERSION}}` is filled from package.json |
| `build.ts` | copies `src/`, the card runtime and vendor files, writes the card frames and `data.js` |
| `tools/capture.sh` | regenerates the app screenshots from a demo collection (`tools/demo-db.ts`, `tools/shots.json`) |
| `tools/terminal.sh` | records the agent session and the AI-grading sample with real commands (needs an AI key) |
| `tools/og/og.html` | the social share image, rendered with `tools/shoot.mjs` |
| `tools/check.mjs` | loads a page in headless Chromium, scrolls it, reports errors and overflow, saves screenshots |
| `tools/interact.mjs` | plays the hero's chess and math cards with real clicks and reports the grades |

The tools need Chromium (`CHROME` overrides the binary) and ImageMagick.
