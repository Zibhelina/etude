# Scheduling control

## Where settings come from

The value a deck uses is resolved in this order, each layer overriding the one before:

1. Built-in defaults (`etude preset defaults`)
2. Parent decks (their resolved settings)
3. The deck's preset
4. The deck's own overrides

```sh
etude deck show "Networks::Week 1"   # resolved, inherited, presetBase, own config, and where each value comes from
```

| Goal | Command |
| --- | --- |
| Change one deck only | `etude deck set <deck> key=value...` |
| Change every deck using its preset | `etude deck set <deck> key=value --to-preset` or `etude preset set <id> key=value` |
| Reset a deck value to inherited | `etude deck unset <deck> key...` (`--all` for every override) |
| Attach or detach a preset | `etude deck preset <deck> <id\|none>` (`--clear-overrides` so the preset fully applies) |
| New preset from a deck's current settings | `etude preset create <id> --from-deck <deck> --apply` |
| Remove a preset | `etude preset decks <id>` (must be empty), then `etude preset delete <id> --yes` |

## Settings keys

| key | default | meaning |
| --- | --- | --- |
| `desiredRetention` | 0.9 | target recall probability; higher means more reviews |
| `learningSteps` | `["1m","10m"]` | steps for new cards (`"1m 10m 1h"` or a JSON list) |
| `relearningSteps` | `["10m"]` | steps after a lapse |
| `maximumInterval` | 36500 | days |
| `newPerDay` / `reviewsPerDay` | 20 / 200 | daily limits, counted across the deck and its subdecks |
| `newPerFace` | `{}` | a face's own new-card limit within `newPerDay`, by face name: `newPerFace.t1=5`; `0` holds a face back, `null` drops an inherited limit. `etude deck faces <deck>` lists the faces |
| `newOrder` | added | added \| random \| deck |
| `reviewOrder` | due | due \| retrievability \| random |
| `newMix` | mix | new cards mixed, first or last |
| `deadline` | null | exam mode: an ISO date-time with offset, e.g. `2026-10-23T16:30:00-07:00` |
| `deadlineMargin` | 12 | hours before the deadline that nothing may be due after |
| `autoRate.good` / `autoRate.hard` | 0.95 / 0.5 | score thresholds for the suggested rating |
| `autoApply` | false | the app applies the suggested rating without asking |
| `burySiblings` | true | other faces of the same item wait until tomorrow |
| `enableFuzz`, `enableShortTerm`, `weights` | | FSRS-6 options |

Changing retention, steps, maximum interval, weights or the deadline only affects future reviews. Add `--reschedule` (or run `etude card reschedule --deck X`) to replay history with the new settings. Commands print a `hint` when that's needed.

## Optimizing the weights

FSRS starts from published default weights. Once a preset's decks have a few hundred reviews, fit the weights to that history, as Anki's Optimize does (it is the same optimizer, fsrs-rs):

```sh
etude preset optimize exam                        # report only: reviews used, log loss and RMSE before and after
etude preset optimize exam --apply --reschedule   # save them if they fit better, then replay history with them
etude deck optimize "Networks"                    # the same for whatever weights this deck uses
```

Every deck whose weights come from the same place counts: a preset's decks, or a single deck that overrides `weights` itself. `--apply` only saves weights with a lower RMSE than the current ones. It needs at least 400 reviews and the optional package `@open-spaced-repetition/binding`, which `npm install` adds on supported platforms. Re-optimize every month or two, or after changing how you grade (moving from self-rated to typed answers changes your ratings).

## Exam deadlines

With `deadline` set, no card is scheduled past `deadline - deadlineMargin`. A card that would land later is pulled in, splitting the remaining time in half so even a well-known card gets one more look before the exam.

```sh
etude preset create exam --name "Midterm" deadline=2026-10-23T16:30:00-07:00 desiredRetention=0.92 newPerDay=60
etude deck preset "Networks" exam --reschedule
etude stats forecast --deck "Networks"      # daily due counts up to the deadline
etude preset unset exam deadline            # after the exam
```

## Moving individual cards

```sh
etude card show <cardId|itemId>          # state, due, stability, difficulty, retrievability now, intervals per rating
etude card intervals <cardId>            # what again/hard/good/easy would do
etude card due <ids|--query> --in 1d     # also --date 2026-10-22 (start of that study day), --now
etude card bury <ids|--query> [--in 3d]  # hide until the next study day (or longer); unbury to undo
etude card suspend <ids|--query>         # out of study until unsuspended
etude card reset <ids|--query>           # forget: back to new (history is kept)
```

`card due` moves the date without recording a review: stability and difficulty stay, and a new card stays new but waits until that date. Always `--dry-run` a `--query` first and check `count`.

## Finding weak material

```sh
etude stats tags --deck X                          # recall per tag, hierarchical
etude stats weak --deck X --lapses 3               # most-forgotten cards
etude card list 'deck:X rated:7:1' --order lapses  # failed in the last week
etude card list 'deck:X is:review' --order difficulty  # hardest first
```

Leeches: tag them first (`etude item tag --query 'deck:X prop:lapses>=4' -t leech`) so they can be found again, then suspend them or rewrite them. Rewriting usually helps more: split the item, add an explanation, or change the type.

## Study scopes

`study next`, `study counts` and `stats` take `--deck` and `--query`. A query narrows the deck's queue (custom study): `etude study next --deck X --query 'tag:http'`. Daily limits still apply. To go past them for extra practice, use `study card <id>` with `--practice` when submitting or rating.
