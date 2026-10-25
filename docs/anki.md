# Importing from Anki

Etude imports Anki packages (`.apkg` deck exports and `.colpkg` collection exports) in both the current zstd format and the older schema. Notes, cards, notetype templates and CSS, decks, tags, media, presets and review history come across; imported cards are studied and scheduled by Etude from then on.

```sh
etude anki import spanish.apkg            # content and scheduling
etude anki import spanish.apkg --dry-run  # report only, nothing written
etude anki import spanish.apkg --no-scheduling
etude anki import backlog.colpkg --deck-prefix "Anki"
```

The same import is on the Decks page's Import button (`.apkg` and `.colpkg`, with packs in the same picker) and at `POST /api/anki/import`, where the package is the request body:

```sh
curl -X POST --data-binary @spanish.apkg -H 'Content-Type: application/octet-stream' \
  'http://127.0.0.1:4610/api/anki/import?dryRun=1&scheduling=1&deckPrefix=Anki'
```

The response is the report described below.

## What comes across

| Anki | Etude |
|---|---|
| notetype (fields, templates, CSS) | one card type, `anki-<name>`; fields keep their labels, templates become the type's `prepare` script and its faces are the templates (`t0`, `t1`, …) |
| note | one item, id `anki-<guid>`; each field is stored as HTML (`html` field kind) and shown in the editor as source |
| card | one card, face `t0`… for templates and `c1`… for clozes; only the clozes the note actually has get a card |
| deck, `Parent::Child` | deck of the same path; only decks that hold cards are created |
| filtered deck | skipped (listed in `skipped`); its cards go to their home deck |
| deck description | deck description (HTML, media references rewritten) |
| deck config | preset `anki-<name>`: learning and relearning steps (minutes → `2m`/`1d`), new and review limits, maximum interval, desired retention, sibling burying, FSRS weights |
| tag, `topic::sub` | tag of the same name, hierarchy kept |
| media file | copied to `<collection>/media/anki/<name>` and referenced as `/media/anki/<name>` from `<img src>`, `url()` and `[sound:]` |
| review log (`revlog`) | Etude reviews with the original timestamps and answer durations; ease 1–4 is the rating |
| FSRS memory state (`data`: `s`, `d`, `lrt`) | card stability, difficulty and last review |
| suspended card (queue -1) | suspended |
| buried card (queue -2/-3) | buried until the next day |
| new card | new |
| `{{FrontSide}}`, `{{#F}}`, `{{^F}}`, `{{cloze:F}}`, `{{type:F}}`, `{{type:cloze:F}}`, `{{hint:F}}`, `{{text:F}}`, `{{furigana:F}}`, `{{Tags}}`, `{{Deck}}`, `{{Subdeck}}`, `{{Card}}`, `{{Type}}` | expanded the way Anki does, inside the card frame |
| MathJax `\(…\)` and `\[…\]` | rendered by the card runtime's TeX renderer |
| `.nightMode` CSS | Etude's dark theme; Anki's forced white backgrounds are dropped so the theme shows through |
| type-in-answer cards | a text input; graded by comparing with the field (loose comparison), so they still self-grade if the script can't run |

Templates with `{{type:}}` get a script grader; every other imported type is self-graded, which is how Anki's basic cards work too.

## What doesn't

- **Image occlusion.** The add-on's notetypes import, but its occlusion boxes are drawn by add-on JavaScript, so a card shows the underlying image with no boxes. Notes made with Anki's built-in image occlusion likewise lose their boxes.
- **Add-on and JavaScript template tags.** Scripts in templates and add-on fields (`{{#tag}}` blocks from add-ons, `{{TTS}}`, `{{tts}}`) don't run: unknown fields render empty. `{{kanji:Field}}` (the kanji-writing add-on) becomes its plain text, without a writing canvas.
- **`{{Tags}}` and `{{Deck}}` are a snapshot.** They are stored as hidden fields (`Anki_Tags`, `Anki_Deck`) when the note is imported, so moving the item to another deck or retagging it later doesn't change what an old card shows. Re-importing refreshes them.
- **Cards are never deleted.** If a re-import (or an edit) removes a cloze or empties an optional-reverse field, the card that existed stays in the collection with its history; new imports stop creating cards for that face. Delete the card by hand if you want it gone.
- **Scheduling is one-way.** Etude reads Anki's history; it doesn't write it back. Re-importing doesn't overwrite progress made in Etude: a card with reviews here keeps its state and its reviews.
- **Notetype-level extras.** Anki's per-notetype "options" (such as card appearance overrides for the browser) have no Etude equivalent; the CSS and templates are what carry over.

## The report

```json
{
  "format": "new",
  "dryRun": false,
  "scheduling": true,
  "types": { "created": 7, "updated": 0, "unchanged": 0 },
  "presets": { "created": 2, "updated": 0, "unchanged": 0 },
  "decks": 3,
  "items": { "created": 10, "updated": 0, "unchanged": 0 },
  "cards": 14,
  "reviews": 16,
  "read": { "notes": 10, "cards": 14, "reviews": 16 },
  "media": { "files": 3, "bytes": 8123 },
  "skipped": [{ "what": "deck", "name": "Cram", "reason": "filtered deck; its cards go to their home deck" }]
}
```

`read` is what the package held, before de-duplication. `skipped` lists what was left out and why: filtered decks, notetypes with no notes, reviews that were manual or ungraded, unsafe media names.

## Re-importing

Item ids come from note guids and type/preset ids from their names, so importing a newer export of the same collection updates in place: content changes are applied, unchanged items and presets are reported as unchanged, and no reviews or cards are duplicated. Progress made in Etude survives (a card with reviews here isn't reset to Anki's state), and media is overwritten with the package's copy. A dry run runs the whole import in a transaction and rolls it back, so its report is exactly what a real import would do.
