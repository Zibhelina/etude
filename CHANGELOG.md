# Changelog

## Unreleased

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
