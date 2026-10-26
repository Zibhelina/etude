---
name: etude
description: Use when a user wants to create, edit, organize, schedule or study flashcards in Etude (a spaced-repetition app with programmable card types and AI grading), quiz them in chat from their decks, check their progress, or author packs and card types. Drives everything through the `etude` CLI, which prints JSON.
---

# Etude

Etude is a spaced-repetition app, like Anki, with card types written in HTML/CSS/JS, scripted or AI grading, and an FSRS scheduler. Everything the web app does is a command: `etude <group> <verb> [args] [flags]`. Output is JSON on stdout; errors are `{"error","code"}` on stderr with a non-zero exit.

## Find the CLI and the database

```sh
etude version || node ~/path/to/etude/src/cli/main.ts version   # from a checkout; Node 24+ runs .ts directly
etude db path            # which database, and why (--db, $ETUDE_DB, $ETUDE_HOME/etude.db, ~/.etude/etude.db)
etude commands           # machine-readable catalog of every command, flag and output shape
etude <group> --help     # verbs in a group; `etude <group> <verb> --help` for flags and examples
```

The CLI opens the SQLite database directly. The server doesn't need to run, and it's safe to use while it does. If the user has more than one collection, ask which one, then pass `--db PATH` on every call. For experiments, use a scratch home: `ETUDE_HOME=$(mktemp -d) etude ...`.

Read `docs/cli.md` in the repo for the full reference and recipes. Don't guess flags: check `--help` first.

## Mental model

- **Item**: one piece of content with a `type`, `fields`, a deck, tags, `source` and `notes`. Ids are stable strings (`net.w1.dtrans-1`); choose readable ones.
- **Card**: each item has one card per face of its type (usually just `main`). Cards carry the FSRS state (new, learning, review, relearning), due date, stability and difficulty. A deck can use another scheduler (`etude scheduler list`): on one without ratings (`drill`), submit and then `study rate <card> next`, or use `study answer`. Card commands take numeric `cardId`s or item ids.
- **Deck**: a tree named with `::` (`"Networks::Week 1"`). Settings resolve as built-in defaults → parent decks → the deck's preset → the deck's own overrides. `etude deck show <deck>` reports each value and where it comes from.
- **Preset**: named settings shared by several decks (retention, steps, daily limits, an exam `deadline`).
- **Tag**: hierarchical with `::`. `tag:a::b` matches `a::b` and everything below it. Tags and decks can carry AI grading instructions.
- **Type**: fields schema, template, an optional `prepare` script, and a grader (`self`, `script`, `ai`, `hybrid`). **Private fields** (answers, references) stay hidden from the learner until they submit. Built-ins: `basic`, `typed`, `numeric`, `mcq`, `order`, `match`, `cloze`, `free`, `draw`. Run `etude type show <id> --fields-only` for field names.
- **Generated items**: a `generator` field (sandboxed JS with a seeded `rng`) makes new numbers on every review. The `seed` picks the variant.
- **Grading**: script graders return a score, and the preset's `autoRate` thresholds turn it into a suggested rating. AI graders use a decision model for the verdict and a language model for feedback. Instructions are read most specific first: the item's rubric, its tags (deepest first), the deck and its parents, then the type.
- **Search** (used by `--query`, `item list`, `card list`): `deck:"X"`, `tag:a::b`, `type:numeric`, `id:pre.*`, `is:new|due|review|suspended|buried|archived`, `prop:lapses>=3`, `rated:7:1`, free words, `-neg`, `OR`, parentheses.

## Core workflows

**Look around**

```sh
etude deck list --format table
etude stats overview --deck "Networks"
etude item list 'deck:"Networks" tag:delay'
etude item show <item-id>              # fields, cards, reviews, attempts
```

**Add content.** For one or two cards, use `item add`. For anything bigger, write a pack (see [references/authoring.md](references/authoring.md)).

```sh
etude item add --deck Spanish --front "el perro" --back "the dog" -t vocab::animals
etude item add --type typed --deck Chem --id chem.au --prompt "Symbol for gold?" --set answers='["Au"]'
etude item add --type free --deck Bio --prompt "Explain osmosis." --reference-file ref.md
etude item add --type mcq --deck Quiz --fields-file q.json           # or --fields '{...}', or - for stdin
etude item preview <id> --with-key                                    # check what the learner sees and the key
```

Every field is also a flag (`--prompt`, `--answer`, `--reference-file`, `--prompt -` reads stdin). `--set k=v` parses JSON values. `item add --id X` is an upsert, so running it again is safe.

**Edit and organize**

```sh
etude item edit <id> --set answer=1.2 --unset extra --add-tag review
etude item move --query 'tag:hard' --to "Physics::Hard"
etude item tag <id>... -t exam::core            # ids, --query, or ids on stdin with -
etude item archive --query 'tag:outdated'       # archive is the normal way to remove
etude tag rename old::name new::name
etude deck rename "Inbox::Networking" "Networks::Transport"
```

**Settings and deadlines.** These recipes live in [references/scheduling.md](references/scheduling.md).

```sh
etude preset create exam --name "Exam" deadline=2026-10-23T16:30:00-07:00 desiredRetention=0.92
etude deck preset "Networks" exam --reschedule
etude deck set "Networks" newPerDay=40           # this deck only; --to-preset writes to its preset
etude deck unset "Networks" newPerDay            # back to inherited
etude card due --query 'tag:http is:due' --in 1d # push to tomorrow without faking a review
etude card suspend --query 'deck:"Networks" prop:lapses>=4'
```

**Themes.** `etude theme list`, then `etude theme set paper`. Make one with `etude theme create sea --from midnight --var highlight="oklch(0.7 0.12 210)" --use`, and change it later with `theme edit` (variables, scheme, `--css-file`). `theme export`/`import` move themes between collections.

## Quizzing a user in chat

Use this when the user wants to practise with you instead of in the app. Every rating you record is a real review that changes their schedule.

1. `etude study next --deck "<deck>"` (or `--query`). Keep `card.cardId` and `card.seed`. If `card` is `null`, nothing is due: say so. For extra practice, pick cards with `etude card list '<search>'`, show one with `etude study card <cardId>`, and pass `--practice` when you submit and rate.
2. Show the question from `card.view` only (render markdown and `$math$`). `card.answerFormat` says how to encode the answer. **Never reveal private fields or the key before the user answers.** Don't call `item show` or `item preview --with-key` on a card you're about to ask. For `basic` (self-graded), show the front and wait.
3. Submit exactly what the user said, verbatim, even when it's wrong or partial: `etude study submit <cardId> --seed <seed> --answer "<their words>"` (or `--answer-file`, or `-` for stdin). For structured types, encode per `answerFormat` (e.g. mcq `["o1"]`, match `{"l0":"r2"}`). A plain string is fine for a one-blank cloze or a one-part numeric. Anything that doesn't start with `[`, `{` or `"` is submitted exactly as typed. Don't correct, complete or improve the answer before submitting.
4. Show the result: the `grade.verdict` and `score`, the `key` (the correct answer and explanation), and feedback if present. For AI-graded cards, `etude study feedback <attemptId>` writes feedback on request.
5. Rate: `etude study rate <cardId> <again|hard|good|easy> --attempt <attemptId>`. Use `suggested.name` unless the user picks a rating. For self-graded cards, ask the user how well they recalled it; don't decide for them. `study answer` combines submit and rate (`--rate auto`).
6. If something went wrong (a mis-typed answer, the wrong card), `etude study undo` reverts the last rating.
7. Repeat with `study next`. Before asking each card, tell the user how many are left (`counts`).

Never invent a grade, rate a card the user didn't answer, or rate on their behalf without their say on a self-graded card. Use `--practice` when they want to try a card again without moving its schedule.

## Authoring packs and types

- Packs are JSON (`etude: "pack/1"`) with presets, decks, types and items. Start from `etude pack new file.json --deck X --prefix x`, which has one working item of every built-in type.
- Always `etude pack check file.json` (it runs generators over many seeds), then `etude pack import file.json --dry-run`, then import. Re-importing updates by id and keeps review history, so **never change an id** of an item someone has studied. Changing it creates a new card and orphans the history.
- Custom types: `etude type new <id> -o dir`, edit, `etude type validate dir`, `etude type preview --from dir --fields '...'`, `etude type test-grade --from dir ... --answer ...`, `etude type import dir`. Details in [references/types.md](references/types.md). Folders on the Types page (`etude type folder create Networks::DNS`, `etude type move <id> <folder>`, `etude type folder list`) only organize; they never change a type.
- Check generated items with `etude item variants <id> -n 20`. Look at the keys: wrong arithmetic in a generator teaches the wrong thing on every review.

## Rules

- **Back up before bulk changes**: `etude db backup` before mass edits, deletes, imports that touch existing items, reschedules or `db restore`. Report the backup path.
- **Preview first**: most writes take `--dry-run`. Use it on anything driven by `--query`, and check the count before running for real.
- **Archive over delete.** Deletes need `--yes`. Only delete what the user explicitly asked to delete.
- **Report what was actually written**: quote counts and ids from the JSON output, not what you meant to do. If a command failed, show the error `code`.
- **Don't fake reviews.** To move cards, use `card due`, `card bury` or `card reset`, never `study rate`. Only record ratings for answers the user actually gave.
- **Don't print API keys.** `settings get` shows only whether each key's environment variable is set. Keys belong in the environment or `$ETUDE_HOME/.env`.
- Exit codes: 2 usage, 3 not found, 4 validation, 5 conflict, 6 AI/network, 1 internal. On a 2, read `--help` and retry. On a 5, inspect state before forcing anything.

## References

- [references/authoring.md](references/authoring.md): pack format, built-in type fields, generators, building a deck from notes.
- [references/scheduling.md](references/scheduling.md): settings keys, presets vs overrides, deadlines, due dates, leeches, rescheduling.
- [references/types.md](references/types.md): writing custom card types (points to `docs/types.md`).
- `docs/cli.md`: every command, flag and output shape, plus recipes. `docs/packs.md` and `docs/types.md` hold the formats.
