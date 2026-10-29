# Changelog

## 2.4.0

- Etude Sync: end-to-end encrypted sync across your devices, as a subscription (US$5 a month or US$40 a year, 1 GB) bought on etude.study and handled by Polar. Settings → Account signs you in by email link; Settings → Sync sets up the vault (password and recovery key), pushes and pulls in the background, and merges changes from several devices without losing reviews. A shared folder works as a free transport, and the server is open source for self-hosting.
- Etude runs entirely in the browser (SQLite in WebAssembly, saved on the device) and as phone apps for iOS and Android.
- Score, a phone layout of its own: a floating tab bar with Ask Etude beside it, thumb-reach study controls, focus mode that gives the card the whole screen, and a + menu beside Check with a scratchpad you can draw on over the card, with pinch zoom.
- Adaptive decks (optional): card types can adapt each showing to the learner, with adaptive pace, levels, placement ("Find my level") and per-skill estimates, without confusing FSRS. Thanks to Victor Bonato.
- A grader can ask for another try with a hint instead of marking the answer wrong. Thanks to Victor Bonato.
- A card type can pick its own scheduler for decks that don't set one (a typing test runs as a drill anywhere). Thanks to Victor Bonato.
- Card preferences: card types can remember small settings per type (etude.prefs, etude.setPref). Thanks to Victor Bonato.
- Market product pages with a screenshot and video gallery; account, Library and Selling screens for the paid Market (opening later).
- Deck archive, confirmed deck deletion, daily new-card limits per face, deleting a type together with its items, and cleaning up leftover cards and unused media.
- Security: Markdown sanitized with DOMPurify, Content-Security-Policy on the app and card frames, foreign Host headers refused, Anki decompression capped, and Ask Etude can't redirect AI providers or write files.
- Faster saves (SQLite synchronous NORMAL with WAL).

## 2.3.0

- Image occlusion, a built-in card type. Drop, paste or pick an image (a diagram, a slide, an atlas page), drag boxes over the parts to hide and name them; every box, or group of boxes, becomes its own card. On the card you type the name under the image and the box opens with its name; small typos pass, another box's name never does (the feedback tells you which part you named), and an empty answer shows it. Pinch, Ctrl + scroll or double-click zooms big images. The editor has move, resize, duplicate, nudge, group, undo and redo, and works with touch. Boxes without a label are revealed and self-graded. Anki imports convert the built-in Image Occlusion notetype and the Image Occlusion Enhanced add-on (as self-graded boxes: Anki doesn't store names). CLI: `etude occlusion add <image> --box "x,y,w,h=Label" [--px]`; API: `POST /api/occlusion`. The Showcase gains a Gray's Anatomy heart.
- Packs can carry their own images: an item field holding a base64 `data:` URL is copied into media on import.
- Search that finds the card you meant. Lists show a readable title for every item (a type can pick it with **List title**, `titleField`), free text ignores case in every script (über finds Über) and skips markup, field names and media file names, `name:value` searches one field (`name:` alone finds it empty), and a new **Best match** order, now the default in Browse, the deck page and `etude search`, puts items whose title is the word first. Existing collections are indexed on first open. Thanks to Victor Bonato.
- Suspend while practicing, as in Anki: `@` suspends the current card, `!` its whole note, with Undo in the toast and a ⏸ menu in the header. Undo leaves cards that were already suspended alone. CLI: `etude card suspend|unsuspend --note`. Thanks to Victor Bonato.
- ← and → move between cards in Watch even when focus is inside the card.
- Fix: saving a type in the type editor no longer drops its demo, metrics, verdict setting or field languages.

## 2.2.0

- **Ask Etude**, an assistant inside the app. The round button in the bottom-right corner (or Ctrl/⌘+J) opens a chat on the right that can do anything the CLI can: make a deck from attached notes or PDFs, move and rename decks, switch or install themes, import Anki packages. It uses your configured AI (ChatGPT plan, OpenRouter or a custom endpoint) and you pick the model per chat. Deletes and other destructive commands wait for **Allow**, and every reply that changed something has **Undo these changes**. CLI: `etude agent ask|list|show|undo|delete|models`; API: `/api/agent/*`. See docs/agent.md.
- Pluggable schedulers. FSRS stays the default, and a deck can pick another scheduler in its Options (or `etude deck set "Deck" scheduler=drill`). **Drill** is for skills you train and measure: no rating buttons, the card comes back as many times a day as you set, **Go again** starts another run, and Stats charts every result (WPM, accuracy… from the type's new `metrics`). **Leitner boxes** ship too, and you can write your own as a small `schedule.js` that gets the grade's details and returns the next due date. Switching schedulers replays the review history. CLI: `etude scheduler list|show|export|import|validate|reset|delete`; API: `/api/schedulers`. See docs/schedulers.md.
- Updates have a clearer home. When this install is behind, an **Update Etude** button appears at the bottom of the sidebar (an icon with a dot when the sidebar is collapsed, a dot on Settings on phones) and opens the list of changes with **Update**. When it's current the corner stays empty. Settings now opens with **About**: version, update status, **Check for updates** and links. The corner pill from 2.1.0 is gone.
- Move a deck anywhere: drag it onto another deck or between rows, or use **Move to…**, **Move up a level** and **Make it a deck of its own** from its ⋯ menu; a toast offers Undo. CLI: `etude deck move <deck> <parent>|--top`; API: `POST /api/decks/move`.
- Card types can ship asset files (3D meshes, data) once with the type instead of inside every card: `assets/` in a type folder, `etude.asset(name)` in card code, served from `/type-assets/` with long caching. Packs, the Market and type export/import carry them.
- A card type can hide the verdict and feedback after an answer (Grader tab, **Show the verdict and feedback**), for skill cards like typing tests; the score is still recorded.
- Stats follow each deck's scheduler: retention and the forecast count FSRS cards, drill runs are counted apart, and a **By scheduler** panel summarises each one.
- Decks shows each deck's total card count, and **Study** is now **Practice** throughout.
- Fixes: an Anki template gated on a media-only field still makes its card; `etude market check` starts the sandbox before checking card types.

## 2.1.0

- Update from GitHub in one click. A small control in the bottom-right corner of Decks shows a check mark when Etude is current and a pink **N updates** when the repository has new commits; its popover lists them and **Update** pulls, reinstalls dependencies when they changed, rebuilds the app and restarts it. It refuses when the checkout has local changes or commits of its own. Installs that aren't a git checkout (the Mac app, npm) show the latest release with a link instead. CLI: `etude update`, `etude update --check`; API: `GET/POST /api/update`.
- Study ahead: a deck with nothing due gets **Ahead** on Decks and **Study ahead** on its page and on the All done screen. Every card in scope, soonest due first, no daily limits; ratings count as real reviews. CLI: `etude study next --ahead`; API: `?ahead=1`.
- Optimize FSRS weights from your own review history (optional `fsrs-rs` dependency).
- Bury with `=` and `-` during study, and undo works after you've moved to the next card.
- **Edit for me** and **Suggest changes**: describe a change and AI proposes the edited card for you to accept.
- Pasted media is copied into the collection, so cards keep working when the original file moves.
- A richer Stats page: recall against your target, a forgetting curve if you stopped today, memory strength, a study clock and card-state donuts.
- Drag decks by their grip to reorder them (mouse, touch or arrow keys). CLI: `etude deck reorder`.
- Market entries can have a cover picture.
- Dusk, a lighter slate dark theme for panels that crush near-black.
- Typing fields get focus before other controls; changing an item's type keeps its cards' history; AI features no longer use a sparkles icon.
- The Market: a new tab to browse and install themes, decks and card types other people shared, read from the public [etude-market](https://github.com/Zibhelina/etude-market) repository. Card types run live in their detail page before you install them; reinstalling updates in place and keeps your scheduling; entries with a newer version show Update. **Publish** opens a pull request with your GitHub CLI, forking the repository when needed; decks go without review history. CLI: `etude market list|show|install|installed|forget|publish|check|index`. See docs/market.md.
- Watch mode, for tour decks. A deck set to `mode: watch` shows a Watch button instead of Study and plays its cards in order: each card has **Show an answer**, which fills in an example answer and grades it the way a real one would be, then **Next card**. You can still try a card yourself; nothing is scheduled or recorded, and watch decks stay out of study queues. Example answers come from a type's new optional `demo.js` (every built-in and showcase type has one) or an item's `fields.demo`; AI-graded items can ship a recorded grade (`fields.demoGrade`). CLI: `etude study watch`.
- The Etude Showcase is now a tour of one card for each of the 27 card types, in six groups (Recall, Calculate, Arrange, Code, Play and listen, Draw and write), in watch mode. The website's repertoire keeps the extra variants in `site/variants.json`.
- Folders for card types. The Types page groups custom types in nested folders (`Courses::Networks::DNS`) that you can create, rename, move and delete, with drag and drop or a Move dialog that works on phones. Deleting a folder never deletes a type; its contents move up. A built-in can be filed too and stays unedited. A search box finds a type by name, id or description. CLI: `etude type move`, `etude type folder list|create|rename|delete`.

## 2.0.0

The first public release of Etude 2, a rewrite of the original Python app.

- Programmable card types: HTML, CSS and JavaScript in a sandboxed frame, with optional `prepare`, `grade` and generator scripts running in QuickJS. Built-in types: basic, typed answer, cloze, numeric, multiple choice, matching, ordering, free answer, math (graded by equivalence), code and drawing.
- FSRS-6 scheduling with presets that inherit down the deck tree, and exam deadlines that adapt intervals so cards are ready on the day.
- Optional AI grading: a decision model returns the verdict, a language model writes feedback, and images (drawings, photos) can be graded too. Providers are configurable.
- Search language over decks, tags, types, ids, states and review history.
- Packs: plain JSON files with decks, presets, types and items, imported idempotently.
- A command-line interface covering every action in the app, with JSON output, for scripts and agents.
- Web app with Decks, Browse, a card type editor, deck options, statistics with a review heatmap and a deadline forecast, themes, and a phone layout.
- Import from Anki: `.apkg` and `.colpkg` packages with their notetypes, decks, media, deck options and review history (`etude anki import`, or the Import button on Decks).
- Grade with your ChatGPT Plus or Pro plan through Sign in with ChatGPT, with no API key (Settings → AI grading, or `etude settings chatgpt login`).
- An embeddable study view (`/embed`).
