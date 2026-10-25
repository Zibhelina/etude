# Changelog

## Unreleased

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
