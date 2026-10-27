# Website

The Etude website: a landing page and a download page, built into `site/dist` as plain static files for GitHub Pages.

Only the free demo types listed in `public-content.ts` may ship in `decks/` and `src/type-assets/`. The build rejects other demos and assets before copying files. Keep paid content and local backups outside the public repository.

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

## Phone edition

At widths up to 640 px the landing page uses the app's Score vocabulary: a bottom dock names the current movement and opens a programme sheet; theme cards, drill panels and phone screenshots are swipe rails with a position meter. The founder letter, generator source and exam-method note fold behind explicit controls, and the final feature list is an accordion. All original copy stays available. Desktop keeps its full layouts and expanded content. The same `site.js` powers the real card examples and charts in both compositions.

The programme supports backdrop/close/Escape dismissal, a focus loop, and a downward swipe from the top. Its links navigate to the original section anchors. The dock appears after the hero actions leave the screen and hides for the closing CTA. The film shortcut plays the existing film; Get Etude goes to the existing download page. This does not advertise an unreleased mobile install.

For browser captures, disable smooth scrolling while positioning a section and check the evaluated scroll position before each shot. A reused top-level `const` in the CDP context throws on later evaluations; wrap capture expressions in an IIFE and fail on `exceptionDetails`. Full-page captures of scroll-revealed content can look empty after late layout shifts: inspect individual sections before diagnosing missing content.

Acceptance: build the site, run `tools/check.mjs` on landing and download at 320/390 and desktop widths, then exercise folding, market tabs/rail scrolling, feature accordion, programme open/close/navigation, and viewport overflow. Check real screenshots separately from DOM assertions. Intentional swipe rails are excluded from the checker's offscreen-descendant warning, while the document overflow check remains active.
