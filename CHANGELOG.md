# Changelog

## 3.0.1

- **Cards move like the Design Lab ones.** A self-rated card turns over to its back in one continuous turn, in Study and in Watch (the Showcase used to just swap). When you check an answer, the card glides into its result: what stays moves to its new place, what's new fades up in turn. Between cards the one you rated flies off and the next rises from the deck, in Watch too. Any card type gets this; games with their own result screen keep theirs, and a type can turn it off with `etude.morph = false`.
- **The built-in types have the Etude 3 look:** a big serif question on basic cards; typed and numeric answers with what you wrote struck through when it's wrong; choices lettered A, B, C; cloze blanks typed inside the sentence; math as a work-it-out card with one Answer field, help behind ?, a scratchpad on a computer or tablet and I'm stuck; code with a flat editor, the pass count and Your code / Reference tabs; drawing with a pen that follows pressure and your drawing beside the reference.
- **Showcase:** the map is a rounded sheet with a faint grid and one zoom pill, and flies to the answer; Morse has one key you tap for a dot and hold for a dash; Work it out keeps its scratchpad behind a switch and shows the solution in two steps.

## 3.0.0

- **Etude 3: every screen is new.** A white Snow theme by day and a neutral grey Night by dark (System follows the device and is the default for new installs), a green that only marks the main button, the εtude wordmark in ink, and a scrollbar that shows only while you scroll.
- **Minimi**, Etude's little wizard cat, sits in the corner. Drag him anywhere; tap him (or ⌘J) for a small chat with Ask Etude beside him. On AI-graded answers he's the one giving feedback, and you can ask him about your answer. Settings → Appearance → Fun mode turns him off, and the ε button comes back.
- **Sidebar:** Study and Make groups, you and Sync at the bottom; `[` or ⌘B folds it to a rail. On a phone, a tab island with labels and a separate Ask circle.
- **Studying:** a fixed shell (‹ back to the deck, a small progress bar), cards on paper that flip to show the answer, the rating buttons with a ring on the one Etude suggests, and the rated card flying off as the next one rises from the deck. When you check an answer, the card morphs into its result instead of jumping. The path above the card shows where it sits inside what you opened. Watch uses the same shell.
- **Card types look like Etude 3:** the question in a serif, no rule before the answer, underline inputs, cloze blanks as soft chips, rounder choices. Cards keep their pink accent for targets, so a green app no longer paints them the colour of correct.
- **Library:** today's session on top, with where the cards come from; a compact panel when you're done and a celebration every fifth day of a streak. Decks get an icon (one of 72 illustrations, an emoji or none), subdecks hang off faint rounded lines, and the ⋯ menu is a right-click.
- **Archive** is its own page: archived decks as boxes, each with how much you still remember; a box opens its forgetting curve, Restore with Undo and Delete for good.
- **Browse** is a sortable table (card, deck, type, next, interval, recall, misses, edited). The card you pick opens in a drawer you can drag wider; it has a live preview that flips and follows unsaved edits, Memory with the card's forgetting curve, and History. Select mode does bulk changes with Undo. Search sorts by title, type, interval and recall, and `--reverse` flips any order.
- **Stats** asks a question per section and answers it in a sentence, with the chart under it: memory and today first, then streak and heatmap, forecast, forgetting curve and your weak subdecks.
- **Settings** is one page with a table of contents on a computer, a section list on an iPad, and one section at a time on a phone. Every section opens with one plain sentence, search finds any row, and AI models and endpoints fold away until you need them.
- **Card types** is a gallery of live cards grouped by what you do. Each type has a page: its card, how it's checked, where it's used deck by deck (`etude type decks`) and its files. New type starts from a description, a copy or a blank.
- **Market:** a Featured row, shelves for decks, paid decks, card types and themes, and a Coming soon shelf. Every entry has its own page with a gallery, the live card preview, and likes, dislikes, downloads and comments (an account to vote or comment, downloads counted anonymously; `etude market vote`, `comment`, `report`, `block` and friends). Themes can be tried on across the whole app before you keep them. Rows that scroll sideways get arrows with a mouse and a fade on touch. Mate in one has the new look, with three new mates.
- **Showcase** has map, worked-math, Morse and Flippy Bit cards.
- **Security**, thanks to Victor Bonato: the web edition and the phone apps run only their own scripts (a per-load nonce); the server token leaves the address bar once the app has it, and no page sends a Referer; an older sign-in has to confirm the same device again before unlocking Sync.

## 2.6.0

- **Etude on the web**, at [etude.study/app](https://etude.study/app/): the whole app in the browser, on a computer, phone or tablet, with nothing to install. The collection is kept in the browser (SQLite in its private storage) and the app keeps working offline after the first visit. On a phone, Add to Home Screen opens it like an app. Market installs, Anki import, AI grading with an OpenRouter or OpenAI key, Ask Etude and Etude Sync work there too; ChatGPT sign-in, folder sync and publishing to the Market stay in the desktop app.
- **Sync runs on its own.** Changes on this device go up within about ten seconds, changes from your other devices come down every 30 seconds and as soon as you come back to Etude, and the screen updates when they arrive. No more pressing Sync now. During a study session it waits and syncs when the session ends.
- Settings → Sync is one card that walks through it: your email and the code, then the plan (yearly or monthly, side by side; the card waits for the payment and moves on by itself), then the sync password, which it now asks for only once Sync is active. After that it shows what Sync is doing: last sync, plan, storage and account. The first sync starts right after the password, and the old "needs an active subscription" error goes away once the plan is active. Your own server or a sync folder is under **Your own server or a folder**.
- Settings: Account and Sync come first and About last, and clicking a tab lands on its section (it used to stop on the one before).
- In the browser, Settings → Data downloads a backup of the whole collection (cards, review history, settings and media in one zip) and restores it, here or in another browser.
- In the browser, Etude opens in one tab at a time: a second tab offers **Use it here**, and the first one steps aside.
- Market covers and screenshots, drawings in Browse, Ask Etude attachments and the Export buttons work without a server (the browser build and the phone apps).
- In Safari, the web edition started its engine twice and opened the collection twice; it now starts once.
- Settings → Sync: without an active Sync, Storage shows a dash and says it appears once Sync is active, instead of "0 KB of 1 GB". **Manage subscription** shows only for a subscription bought on the website; a Sync given to an account by hand showed it too. An ended plan reads "Ended · Nov 3, 2026" instead of "Ended · Ended …".
- `etude sync now` exits 7 (`sync_required`) with a clear message when Sync isn't active on the account. It used to exit 1, the code for a bug.
- The terms, refunds and privacy pages cover Sync bought in the iPhone and iPad app: Apple sells, bills and refunds it, and Apple's Standard EULA applies to the App Store copy.
- **Anonymous error reports and usage counts.** When something breaks, the app sends Etude's server an anonymous report (the error and where in Etude's code it happened, scrubbed of paths, emails and anything quoted, never your cards); turn it off in Settings → Privacy. Daily counts of which features you use are off unless you tick **Help improve Etude** in setup or turn on **Share usage stats**. Neither is linked to your account, the `etude` command and agents never send either, and `ETUDE_TELEMETRY=0` turns both off.

## 2.5.0

- **Etude for desktop**: a real app for Mac, Windows and Linux, with nothing else to install. Mac: a .dmg for Apple Silicon or Intel (the 2.4.0 and 2.4.1 Mac downloads didn't start; this replaces them). Windows: an installer that needs no administrator. Linux: .deb, .rpm or AppImage. The collection stays in `~/.etude`, shared with the `etude` command and agents; the app reuses an `etude serve` already running for the same collection, and the engine it starts answers only its own window. Windows and the AppImage update themselves (in the background, installing when you restart or quit); the Mac app and the .deb and .rpm show a link to the new version for now. Settings → Desktop app installs the `etude` command (the Linux packages install it as `/usr/bin/etude`), running the app's own engine. Thanks to Victor Bonato.
- Much faster with a big collection. Decks, Stats and Card types load several times faster, and Settings opens at once: Clean up checks when you press **Check now**. Sync no longer freezes the app every few minutes: it rebuilds the collection only when another device sent changes, and reads only media files that changed. Thanks to Victor Bonato.
- Windows fixes: the app's scripts, styles and card media load, folder sync writes its files (their names had colons, which Windows forbids; they now use `~` everywhere, so a device on 2.4 sees files from 2.5 only after updating), and a git install updates itself. Thanks to Victor Bonato.
- `etude serve --token` works on every screen (Sync, account and onboarding didn't send the token), and a server on localhost refuses foreign host names even with a token.
- In the desktop app, Sync's folder field has a **Choose…** button.

## 2.4.1

- Etude is now licensed under the GNU AGPL-3.0 (it was MIT up to 2.4.0). A commercial license is available at hello@etude.study; contributions are made under the CLA in CLA.md, and the name and logo follow TRADEMARK.md.
- First-run setup: choose how much you want to tinker, whether to use AI and which accounts you have (ChatGPT sign-in, OpenRouter or OpenAI key with a live test), how to sync, and a first deck. Existing collections skip it.
- Etude Sync signs in with a 6-digit code from the email (onboarding, Settings, CLI); the link in the email still works. Subscribing (yearly or monthly) happens inside the setup, and Etude moves on by itself once Sync is active.
- Sync waits out 429 Too Many Requests instead of failing, shows progress, transfers media in parallel, syncs media edits both ways, handles media names with spaces and accents, and Settings → Sync shows a single error.
- Decks: right-click a deck row for its menu (Move to, Rename, Archive, Delete).

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
