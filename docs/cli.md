# The etude command line

Everything the web app can do is also a command. The CLI is built for scripts and agents first: every command prints JSON, takes its input from flags, files or stdin, and describes itself (`etude --help`, `etude <group> --help`, `etude <group> <verb> --help`, `etude commands`).

```sh
etude <group> <verb> [args] [flags]
etude deck list
etude item add --deck Spanish --front "el perro" --back "the dog"
etude study next --deck Spanish
```

Run it as `etude` (after `npm link` or through `bin/etude.js`) or straight from a checkout with `node src/cli/main.ts`. Node 26 runs the TypeScript directly; there is no build step for the CLI.

## Conventions

**Output.** Success prints one JSON value on stdout: an object or an array, with stable keys listed under "Output" for each command below. JSON is indented when stdout is a terminal and one line otherwise; `--pretty` and `--compact` force either. List commands also accept `--format table` for people. A few commands print plain text on purpose: `--ids` (one id per line), `type frame` (HTML), and scaffolds written to stdout.

**Errors.** Failures print `{"error": "...", "code": "..."}` on stderr (sometimes with `details`) and exit non-zero. The exit code tells the kind of failure:

| Exit | `code` | When |
| --- | --- | --- |
| 2 | `usage` | Unknown command or flag, a missing argument, a destructive command without `--yes` |
| 3 | `not_found` | No such deck, item, card, type, preset or attempt |
| 4 | `validation` | Bad fields or settings, a search that doesn't parse, a pack or type that fails its check |
| 5 | `conflict` | The id is taken, the preset or type is still in use, the attempt was already rated |
| 6 | `external` | An AI provider or the network failed |
| 1 | `internal` | Anything else (a bug); set `ETUDE_DEBUG=1` to get the stack |

**Input that survives shells.** Long or awkward values never have to go through quoting:

- Text fields: `--front "..."`, `--front-file q.md`, or `--front -` to read stdin. This works for every field of every card type (`--prompt`, `--reference-file`, `--answer`, ...), because `item add` and `item edit` accept any field name as a flag.
- Whole field objects: `--fields '{"prompt": "...", "answer": 4}'` or `--fields-file f.json` (or `-`).
- `--set key=value` parses the value as JSON when it can (`--set answer=0.1`, `--set tags='["a","b"]'`, `--set shuffle=false`) and keeps it as text otherwise. `--unset key` removes a field.
- Settings take `key=value` pairs the same way: `etude deck set "Networks" desiredRetention=0.92 learningSteps="1m 10m"`.
- Bulk commands take ids as arguments, from `--query "<search>"`, or one per line on stdin with `-`: `etude card list "prop:lapses>=4" --ids | etude card suspend -`.
- Only one input per command can read stdin.

**Safe writes.**

- Commands that change something are marked *writes* in the reference. Most of them accept `--dry-run`, which runs the change inside a transaction, prints the result with `"dryRun": true`, and rolls it back.
- `item add` with `--id` and `pack import` are upserts by id: running them again updates in place (`"result": "unchanged"` when nothing differs) and keeps review history.
- Archiving is the normal way to remove things (`item archive`, `deck archive`). Real deletes (`item delete`, `deck delete`, `preset delete`, `type delete`, `type reset`, `db restore`) refuse to run without `--yes`.
- `etude db backup` takes a consistent copy of the database. Do it before any bulk change.

**Ids.** Items have string ids you choose (`net.w1.dtrans-1`; lowercase, dots and dashes) or that are generated from the deck and content. Each item has one card per face, and cards have numeric ids (`cardId`). Commands that work on cards also accept an item id and expand it to that item's cards (`--face` picks one). Decks are named by their full path with `::` (`"Networks::Week 1"`); presets and card types by a lowercase slug.

**Search language.** `--query`, `item list`, `card list` and `search` all take the same searches as the app's Browse page:

```text
deck:"Networks"       the deck and everything below it      (deck:net* wildcards)
tag:net::w1           the tag and every tag below it        (tag:exam::* wildcards)
type:numeric  id:net.w1.*  source:ch1
is:new is:learning is:review is:relearning is:due is:suspended is:buried is:archived
prop:lapses>=2  prop:reps=0  prop:stability<3  prop:difficulty>7  prop:due<=1 (days from now)
rated:1  rated:7:1     reviewed in the last N days (optionally with that rating)
word  "a phrase"       text anywhere in the item's fields
-term  a OR b  (grouping)   terms are ANDed by default
```

Archived items only show up when the search mentions `is:archived`.

## Which database

The CLI opens the SQLite database itself. It does not need the server, and it is safe to use while `etude serve` (or the systemd service) is running: the database is in WAL mode, so each write is atomic and the app sees it on its next request.

The database is chosen in this order:

1. `--db PATH`
2. `$ETUDE_DB`
3. `$ETUDE_HOME/etude.db`
4. `~/.etude/etude.db`

Media files live in a `media/` folder next to the database. `$ETUDE_HOME/.env` is loaded if it exists, which is where AI provider keys go (settings only store the name of the environment variable, never the key). `etude db path` shows which database a command would use and why.

## Recipes

### Build a deck from notes

```sh
etude db backup
etude deck create "Biology::Cells" --description-file cells-overview.md
etude item add --deck "Biology::Cells" --id bio.cells.mito --front "What does the mitochondrion do?" --back "Makes ATP by cellular respiration." -t bio::cells
etude item add --deck "Biology::Cells" --type cloze --text "The {{nucleus}} holds the cell's DNA." -t bio::cells
etude item add --deck "Biology::Cells" --type free --prompt "Explain osmosis." --reference-file osmosis.md
etude item list deck:"Biology::Cells"
```

For more than a handful of items, write a pack instead (next recipe) so the whole deck is one reviewable file.

### Write and import a pack

```sh
etude pack new bio.pack.json --deck Biology --prefix bio   # one example item of every built-in type
$EDITOR bio.pack.json
etude pack check bio.pack.json                              # fields, ids, generators over many seeds
etude pack import bio.pack.json --dry-run
etude pack import bio.pack.json
```

Importing again after editing updates items in place. See [packs.md](packs.md) for the format.

### Add a generated numeric card

A `generator` field holds JavaScript that runs in a sandbox with a seeded `rng` and returns field values, so every review can show new numbers.

```sh
etude item add --type numeric --deck "Networks::Delay" --id net.dtrans-gen --unit ms \
  --prompt "A packet on a link. Transmission delay in ms?" --answer 1 \
  --generator 'const L = rng.pick([500,1000,1500]); const R = rng.pick([1,10,100]);
const ms = Number((L*8/(R*1e6)*1e3).toPrecision(6));
return { prompt: `A ${L}-byte packet on a ${R} Mbps link. Transmission delay in ms?`, answer: ms };'
etude item variants net.dtrans-gen -n 10      # check the outputs and keys
```

### Write a custom card type

```sh
etude type new vocab -o my-types/vocab         # a working type: prompt, a private answer, a script grader
$EDITOR my-types/vocab/type.json my-types/vocab/template.html my-types/vocab/grade.js
etude type validate my-types/vocab
etude type preview --from my-types/vocab --fields '{"prompt": "saudade", "answer": "longing"}'
etude type test-grade --from my-types/vocab --fields '{"prompt": "saudade", "answer": "longing"}' --answer longing
etude type import my-types/vocab
```

[types.md](types.md) explains the type format: fields (private ones are hidden until the answer is submitted), the template, `prepare` and graders.

### Quiz someone in a chat

```sh
etude study next --deck "Networks"         # card.view is what to show; card.answerFormat says how to answer
# ask the question from card.view, wait for the person's answer
etude study submit 42 --seed 1234 --answer "their answer, verbatim"
# show grade, key and feedback; then record the review with the suggested rating, or the one they pick
etude study rate 42 good --attempt 118
```

`study answer` does submit and rate in one step (`--rate auto` uses the suggested rating). Use `--practice` to grade without moving the card's schedule.

### Set an exam deadline

```sh
etude preset create exam --name "Exam cram" deadline=2026-10-23T16:30:00-07:00 desiredRetention=0.92 newPerDay=50
etude deck preset "Networks" exam --reschedule
etude deck show "Networks"                 # resolved settings, and where each one comes from
etude stats forecast --deck "Networks"
```

`deck set` overrides one deck only; `deck set ... --to-preset` writes into its preset instead; `deck unset` resets a value to inherited.

### Push some cards to tomorrow

```sh
etude card due --query 'deck:"Networks" tag:http is:due' --in 1d --dry-run
etude card due --query 'deck:"Networks" tag:http is:due' --in 1d
etude card bury 42 43                      # or just hide them until the next study day
```

`card due` moves the due date without faking a review. `--date 2026-10-22`, `--in 3d` and `--now` all work.

### Find weak cards and suspend leeches

```sh
etude stats tags --deck "Networks"                        # recall per tag
etude stats weak --deck "Networks" --lapses 3             # cards forgotten 3+ times
etude card list 'deck:"Networks" prop:lapses>=4' --ids | etude card suspend -
etude item tag --query 'deck:"Networks" prop:lapses>=4' -t leech
```

### Back up and export

```sh
etude db backup                                  # ~/.etude/backups/etude-<time>.db
etude db check
etude pack export --deck "Networks" -o net.pack.json
etude pack export -o everything.pack.json
```

A pack carries content, decks, presets, tags and custom types; review history stays in the database. Use `db backup` to keep history too.

<!-- Everything below is generated by scripts/gen-cli-docs.ts from the command registry. Edit src/cli/commands/*.ts, not this. -->

## Command reference

### Global flags

These work on every command, before or after the command words.

| Flag | Type | Description |
| --- | --- | --- |
| `--db <PATH>` | string | Database file. Defaults to $ETUDE_DB, then $ETUDE_HOME/etude.db, then ~/.etude/etude.db. |
| `--pretty` | boolean | Indent JSON output (the default when stdout is a terminal). |
| `--compact` | boolean | One-line JSON output (the default when stdout is not a terminal). |
| `--format <json\|table>` | string | Output format. `table` renders lists for humans. Default `"json"`. |
| `-h, --help` | boolean | Show help for the command. |

### Exit codes

| Exit | `code` | Meaning |
| --- | --- | --- |
| 0 | `ok` | Success. |
| 1 | `internal` | Unexpected failure (a bug, or the database is unreadable). |
| 2 | `usage` | Bad arguments, unknown command, or a destructive command without --yes. |
| 3 | `not_found` | A deck, item, card, type, preset or attempt doesn't exist. |
| 4 | `validation` | Input was rejected (fields, settings, search syntax, a failing pack or type check). |
| 5 | `conflict` | The operation clashes with existing state (id taken, preset or type in use, already rated). |
| 6 | `external` | An AI provider or the network failed. |

### Command tree

- **deck**: Decks: the tree, settings inheritance, presets, description and grading instructions (`etude deck` alone runs `list`)
  - [`deck list`](#deck-list) The deck tree with due counts.
  - [`deck show`](#deck-show) A deck with its effective settings and where each one comes from.
  - [`deck create`](#deck-create) Create a deck (and any missing parents).
  - [`deck rename`](#deck-rename) Rename or move a deck, with its subdecks. Merges into an existing deck of the same name.
  - [`deck move`](#deck-move) Move a deck, with its subdecks, under another deck or out to the top level. Keeps its name.
  - [`deck reorder`](#deck-reorder) Set the order of sibling decks in the deck list.
  - [`deck archive`](#deck-archive) Hide a deck from the deck list and study. Cards and history are kept.
  - [`deck unarchive`](#deck-unarchive) Bring an archived deck back.
  - [`deck delete`](#deck-delete) Delete an empty deck and its empty subdecks. Decks holding items can't be deleted: move or archive them.
  - [`deck description`](#deck-description) Get or set a deck's markdown description.
  - [`deck instructions`](#deck-instructions) Get or set a deck's AI grading instructions (they apply to its subdecks too).
  - [`deck set`](#deck-set) Override settings on this deck (they win over its preset and parents).
  - [`deck unset`](#deck-unset) Remove this deck's own overrides so the values are inherited again.
  - [`deck optimize`](#deck-optimize) Fit the FSRS weights this deck uses to the history of every deck sharing them (Anki's Optimize).
  - [`deck preset`](#deck-preset) Attach a preset to a deck, or detach it with `none`.
- **preset**: Presets: named settings shared by several decks (`etude preset` alone runs `list`)
  - [`preset list`](#preset-list) Every preset with the decks that use it.
  - [`preset show`](#preset-show) A preset: its own values, the full settings it produces on a top-level deck, and its decks.
  - [`preset create`](#preset-create) Create a preset from key=value pairs, or copy a deck's effective settings with --from-deck.
  - [`preset set`](#preset-set) Change settings in a preset. Every deck using it is affected.
  - [`preset unset`](#preset-unset) Remove keys from a preset so they fall back to the defaults (or the deck's parents).
  - [`preset rename`](#preset-rename) Change a preset's display name (the id stays).
  - [`preset delete`](#preset-delete) Delete a preset no deck uses (archived decks count).
  - [`preset decks`](#preset-decks) Decks that use a preset.
  - [`preset optimize`](#preset-optimize) Fit the preset's FSRS weights to the review history of the decks using it (Anki's Optimize).
  - [`preset defaults`](#preset-defaults) The built-in default for every scheduling setting (what applies when no deck or preset sets it).
- **item**: Items: the content (fields, tags, source) behind one or more cards (`etude item` alone runs `list`)
  - [`item list`](#item-list) Items matching a search (one row per item, not per card).
  - [`item show`](#item-show) An item with its fields, cards, scheduling, reviews and attempts.
  - [`item ai-edit`](#item-ai-edit) Ask the configured language model to propose changes to a card's content. Nothing is saved.
  - [`item add`](#item-add) Add an item. Re-running with the same --id and content is a no-op.
  - [`item edit`](#item-edit) Change an item's fields, deck, tags, source, notes or type. Scheduling is kept.
  - [`item move`](#item-move) Move items to another deck.
  - [`item tag`](#item-tag) Add tags to items.
  - [`item untag`](#item-untag) Remove tags from items.
  - [`item archive`](#item-archive) Archive items: hidden from study and search, history kept. The safe way to remove content.
  - [`item unarchive`](#item-unarchive) Restore archived items.
  - [`item delete`](#item-delete) Permanently delete items with their cards and review history. Prefer `item archive`.
  - [`item duplicate`](#item-duplicate) Copy an item's content (not its scheduling) under a new id.
  - [`item preview`](#item-preview) What a card of this item shows (view), for a seed. The answer key only with --with-key.
  - [`item variants`](#item-variants) Sample a generated item's outputs over several seeds (with keys), to check a generator.
- **card**: Cards: per-card scheduling (suspend, bury, reset, due dates, intervals)
  - [`card show`](#card-show) A card's scheduling: state, due, stability, difficulty, recall probability now, and what each rating would do.
  - [`card list`](#card-list) Cards matching a search (one row per card), with scheduling.
  - [`card intervals`](#card-intervals) When the card would next be due for each rating (again, hard, good, easy), right now.
  - [`card suspend`](#card-suspend) Suspend cards: they never come up until unsuspended.
  - [`card unsuspend`](#card-unsuspend) Unsuspend cards.
  - [`card unbury`](#card-unbury) Unbury cards so they can come up today.
  - [`card reset`](#card-reset) Forget cards: back to new, as if never studied. Review history is kept (and `card reschedule` would rebuild from it).
  - [`card bury`](#card-bury) Hide cards until the next study day, or until a date.
  - [`card due`](#card-due) Set when cards are next due, without recording a review.
  - [`card reschedule`](#card-reschedule) Rebuild cards' scheduling from their review history with the current settings (after changing retention, steps, weights or a deadline).
- **tag**: Tags: hierarchical labels (a::b), with grading instructions and descriptions (`etude tag` alone runs `list`)
  - [`tag list`](#tag-list) Tags in use, with item counts, instructions and descriptions.
  - [`tag show`](#tag-show) A tag's instructions, description, item count and subtags.
  - [`tag rename`](#tag-rename) Rename a tag on every item, with every tag below it (a::b → c::b).
  - [`tag instructions`](#tag-instructions) Get or set a tag's AI grading instructions (apply to every item with the tag or a tag below it).
  - [`tag description`](#tag-description) Get or set a tag's description.
  - [`tag items`](#tag-items) Items with a tag (or a tag below it).
- **type**: Card types: fields, template (HTML/CSS/JS), prepare script and grader (`etude type` alone runs `list`)
  - [`type list`](#type-list) Card types with their grader, item count and whether they are shipped, edited or custom.
  - [`type show`](#type-show) A type's full definition: fields (with kinds, private flags, defaults), template, prepare and grader code.
  - [`type export`](#type-export) Write a type as editable files (type.json, template.html, style.css, card.js, prepare.js, grade.js), or print it as JSON.
  - [`type import`](#type-import) Create or update a type from a directory, a JSON file, or JSON on stdin (`-`). Saving an edited built-in makes it yours.
  - [`type validate`](#type-validate) Check a type definition without saving it. Exits 4 when it has problems.
  - [`type preview`](#type-preview) Run a type on sample fields and show what the card gets (view) and what grading uses (key).
  - [`type test-grade`](#type-test-grade) Run a type's grader on an answer without saving anything.
  - [`type reset`](#type-reset) Restore an edited built-in type to the shipped version.
  - [`type delete`](#type-delete) Delete a custom type no item uses (archived items count).
  - [`type move`](#type-move) Put a type in a folder of the Types page (created if needed); `--root` takes it out of every folder.
  - [`type folder list`](#type-folder-list) Folders of the Types page with the types directly inside each one.
  - [`type folder create`](#type-folder-create) Create a folder (and its parents) in the Types page.
  - [`type folder rename`](#type-folder-rename) Rename or move a folder with every folder and type inside it.
  - [`type folder delete`](#type-folder-delete) Delete a folder and the folders inside it. Types are kept and move up to the parent folder.
  - [`type copy`](#type-copy) Copy a type (built-in or custom) under a new id, as a starting point.
  - [`type new`](#type-new) Scaffold a minimal working type directory to edit and then `etude type import`.
  - [`type frame`](#type-frame) The HTML document a card of this type renders in (what the app loads into its sandboxed iframe).
- **scheduler**: Schedulers: who decides when a card comes back (FSRS, a drill, Leitner boxes, or your own script) (`etude scheduler` alone runs `list`)
  - [`scheduler list`](#scheduler-list) Every scheduler: FSRS (built in) and the script ones, with whether they ask for ratings, their options and how many decks use them.
  - [`scheduler show`](#scheduler-show) A script scheduler's definition, including its schedule.js.
  - [`scheduler export`](#scheduler-export) Write a script scheduler as editable files (scheduler.json + schedule.js), or print it as JSON.
  - [`scheduler import`](#scheduler-import) Create or update a scheduler from a directory (scheduler.json + schedule.js), a JSON file, or `-`.
  - [`scheduler validate`](#scheduler-validate) Check a scheduler definition without saving it. Exits 4 when it has problems.
  - [`scheduler reset`](#scheduler-reset) Restore an edited built-in scheduler to the shipped version.
  - [`scheduler delete`](#scheduler-delete) Delete a custom scheduler no deck or preset uses.
- **study**: Studying: the queue, presenting a card, submitting answers, ratings, undo
  - [`study counts`](#study-counts) Today's queue for a scope: new, learning, review, done today, next due.
  - [`study next`](#study-next) The next card to study in a scope, with its view and how to answer it. Private fields are never included.
  - [`study card`](#study-card) Present a specific card (any time, due or not). A seed reproduces a variant; a new seed gives a new one.
  - [`study submit`](#study-submit) Grade an answer and store the attempt. Returns the grade, the suggested rating and the answer key. Doesn't schedule: follow with `study rate`.
  - [`study feedback`](#study-feedback) AI feedback for an attempt (written once, then cached).
  - [`study rate`](#study-rate) Record a rating and reschedule the card. Pass --attempt to link the graded attempt.
  - [`study answer`](#study-answer) Submit and rate in one step: grades the answer, then applies the suggested rating (or the one you give).
  - [`study undo`](#study-undo) Undo the most recent review (any card): the card returns exactly to its previous state.
  - [`study watch`](#study-watch) Watch mode: the cards of a scope in order, one per item, each with an example answer and its grade. Records nothing.
- **stats**: Statistics: overview, forecast, recall per tag (`etude stats` alone runs `overview`)
  - [`stats overview`](#stats-overview) Everything the Stats page shows for a scope: card states, retention, recall, daily activity, forecast, ratings, verdicts, streak, deadline.
  - [`stats forecast`](#stats-forecast) Cards due per day for the next 30 days (overdue counts on today).
  - [`stats tags`](#stats-tags) Predicted recall per tag (with parent tags), weakest first.
  - [`stats weak`](#stats-weak) Cards most likely forgotten or most often lapsed: candidates for rewording, splitting or suspending.
- **settings**: App settings: AI providers and models, day start, learn-ahead, ChatGPT sign-in (`etude settings` alone runs `get`)
  - [`settings get`](#settings-get) Current settings, or one dotted key. Key values are never printed: only whether each key's env var is set.
  - [`settings set`](#settings-set) Change settings with dotted key=value pairs (JSON values when they parse).
  - [`settings unset`](#settings-unset) Reset dotted keys to their defaults.
  - [`settings test-ai`](#settings-test-ai) Grade a fixed sample answer with the configured providers, to check keys and models. Costs a fraction of a cent.
  - [`settings chatgpt login`](#settings-chatgpt-login) Sign in with ChatGPT, so grading uses the user's ChatGPT Plus or Pro plan instead of an API key.
  - [`settings chatgpt status`](#settings-chatgpt-status) Whether this install is signed in with ChatGPT, for which account, and whether plan usage is granted.
  - [`settings chatgpt logout`](#settings-chatgpt-logout) End the ChatGPT session and delete the saved tokens. The app registration is kept for a later sign-in.
  - [`settings chatgpt models`](#settings-chatgpt-models) The models the signed-in ChatGPT account offers for plan usage (slug and display name).
  - [`settings chatgpt import`](#settings-chatgpt-import) Adopt a chatgpt.json signed in on another machine (the self-hosted-VM path). This host gets its own host id.
- **theme**: Themes: pick the app's colors, or make your own with CSS variables and extra CSS (`etude theme` alone runs `list`)
  - [`theme list`](#theme-list) Every theme, built-in first, with which one is selected.
  - [`theme show`](#theme-show) A theme's variables and extra CSS. Without an id, the selected theme.
  - [`theme set`](#theme-set) Use a theme in the app (every device; open pages pick it up on their next load).
  - [`theme create`](#theme-create) Make a custom theme from an existing one, changing variables and adding CSS.
  - [`theme edit`](#theme-edit) Change a custom theme: name, scheme, variables or extra CSS.
  - [`theme delete`](#theme-delete) Delete a custom theme. If it was selected, the app goes back to Midnight.
  - [`theme export`](#theme-export) Write a theme as JSON to share or back up.
  - [`theme import`](#theme-import) Add a theme from a JSON file made by `theme export` (or the app's Export).
- **pack**: Packs: JSON files with decks, presets, tags, types and items (import, export, check, scaffold)
  - [`pack import`](#pack-import) Add or update everything in one or more packs. Idempotent: items match by id and keep their scheduling.
  - [`pack export`](#pack-export) Write a pack of the items in a scope, with their decks, presets, tag instructions and custom types. Scheduling is not included.
  - [`pack check`](#pack-check) Validate pack files without a database: structure per type, ids, and every generator over many seeds. Exits 4 on errors.
  - [`pack new`](#pack-new) Write a starter pack with one valid item of each built-in type, to edit.
- **anki**: Anki: bring an .apkg or .colpkg collection in (types, decks, items, cards, media, history)
  - [`anki import`](#anki-import) Import an Anki package: card types, presets, decks, items, cards, media and review history.
- **media**: Media copied into the collection's own folder
  - [`media path`](#media-path) Show the collection's media folder.
  - [`media add`](#media-add) Copy an image, audio or video file into the collection's media folder.
- **market**: Market: browse, install and publish shared themes, decks and card types (`etude market` alone runs `list`)
  - [`market list`](#market-list) Entries in the market, newest first, with whether each is installed here.
  - [`market show`](#market-show) One entry: its details from the index and what it contains.
  - [`market install`](#market-install) Add an entry to your collection. Installing again updates it; decks keep your scheduling.
  - [`market installed`](#market-installed) What you installed from the market, with what each put in your collection.
  - [`market forget`](#market-forget) Stop tracking an installed entry. What it added stays in your collection; delete that with `theme delete`, `deck delete` or `type delete`.
  - [`market publish`](#market-publish) Share a theme, deck or card type: opens a pull request on the market repository with your GitHub account.
  - [`market check`](#market-check) Validate market entry files without a database. Exits 4 on problems.
  - [`market index`](#market-index) For the market repository: check every file under entries/ (each deck and type is dry-run imported) and write index.json.
- **db**: The database file: path, backups, integrity, schema version
  - [`db path`](#db-path) Which database and media directory the CLI uses, and how it was chosen.
  - [`db backup`](#db-backup) Copy the database consistently (SQLite online backup; safe while the server runs).
  - [`db check`](#db-check) Run SQLite's integrity and foreign-key checks. Exits 4 when something is wrong.
  - [`db info`](#db-info) Schema version, SQLite version, journal mode, sizes and row counts.
  - [`db restore`](#db-restore) Replace the database with a backup. The current file is backed up first. Stop the server before restoring.
- **top level**
  - [`serve`](#serve) Run the web app and HTTP API.
  - [`update`](#update) Update this copy of Etude from its GitHub repo: fetch, fast-forward, install dependencies, rebuild the web app.
  - [`search`](#search) Find cards with the search language (one row per card). Same as `etude card list`.
  - [`commands`](#commands) The catalog of every command: args, flags with types and defaults, examples, whether it writes. JSON for agents.
  - [`version`](#version) Print the Etude version.

## deck

Decks: the tree, settings inheritance, presets, description and grading instructions.

### etude deck list

<a id="deck-list"></a>

The deck tree with due counts.

Each row has the deck's name, depth, card totals and today's queue (new, learning, review). Archived decks are hidden unless --archived.

```
etude deck list [flags]
```

*read-only*

| Flag | Type | Description |
| --- | --- | --- |
| `--archived` | boolean | Include archived decks. |

Output: array of decks: { name, depth, presetId, cards, unseen, new, learning, review, doneToday, nextDue, deadline, archived }

```sh
etude deck list
etude deck list --format table
```

### etude deck show

<a id="deck-show"></a>

A deck with its effective settings and where each one comes from.

`resolved` is what applies to the deck's cards. `config` is the deck's own overrides, `inherited` what applies without them (parents and preset), `presetBase` what applies without the preset. `sources` names, per setting, the layer it comes from: default, parent-preset, parent, preset or deck.

```
etude deck show <deck>
```

*read-only*

| Argument | Description |
| --- | --- |
| `deck` | Deck name; `::` separates levels. |

```sh
etude deck show "Networks::Week 1"
```

### etude deck create

<a id="deck-create"></a>

Create a deck (and any missing parents).

```
etude deck create <deck> [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `deck` | Full deck path, e.g. `Course::Unit 1`. |

| Flag | Type | Description |
| --- | --- | --- |
| `--preset <VALUE>` | string | Use this preset. |
| `--description <VALUE>` | string | Markdown description (`-` reads stdin). |
| `--description-file <PATH>` | string | Read the description from a file (`-` for stdin). |
| `--instructions <VALUE>` | string | AI grading instructions for every card in the deck (`-` reads stdin). |
| `--instructions-file <PATH>` | string | Read the instructions from a file. |
| `--set <KEY=VALUE> (repeatable)` | string | Own setting override, key=value (see `deck set`). |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { created: bool, deck } with the deck as `deck show` returns it

```sh
etude deck create "Physics::Waves" --preset exam --instructions "Units must be right."
```

### etude deck rename

<a id="deck-rename"></a>

Rename or move a deck, with its subdecks. Merges into an existing deck of the same name.

```
etude deck rename <from> <to> [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `from` | Current deck name. |
| `to` | New full path. `A::B` → `C::B` moves it under C. |

| Flag | Type | Description |
| --- | --- | --- |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { from, to, decks: [{ from, to }] }

```sh
etude deck rename "Physics::Waves" "Physics::Oscillations and waves"
etude deck rename "Inbox::Networking" "Networks::Transport"
```

### etude deck move

<a id="deck-move"></a>

Move a deck, with its subdecks, under another deck or out to the top level. Keeps its name.

The deck keeps its own name and goes under `parent`, or becomes a deck of its own with `--top`. `--index` puts it at that place among its new siblings (0 is first); without it, it goes last. Refuses when the new parent already has a deck of that name. To move and rename at once, use `deck rename` with a full path.

```
etude deck move <deck> [parent] [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `deck` | Deck to move. |
| `parent` (optional) | New parent deck. Leave out with --top. |

| Flag | Type | Description |
| --- | --- | --- |
| `--top` | boolean | Make it a top-level deck. |
| `--index <N>` | number | Place among the new siblings, 0 first. Default: last. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: the moved deck, as `deck show` returns it (without counts)

```sh
etude deck move "Inbox::Networking" "Networks"
etude deck move "Networks::Week 1" --top
etude deck move "Chess" "Games" --index 0
```

### etude deck reorder

<a id="deck-reorder"></a>

Set the order of sibling decks in the deck list.

Give two or more decks under the same parent (or all top level) in the order you want. Siblings you leave out keep their order after the listed ones. Subdecks move with their deck. Without an order, decks sort by name.

```
etude deck reorder <decks...> [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `decks...` | Full deck names, in the new order. |

| Flag | Type | Description |
| --- | --- | --- |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { parent, order: [full names of every sibling, in the new order] }

```sh
etude deck reorder "Morse code" "Networks"
etude deck reorder "Networks::Week 2" "Networks::Week 1"
```

### etude deck archive

<a id="deck-archive"></a>

Hide a deck from the deck list and study. Cards and history are kept.

```
etude deck archive <deck> [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `deck` | Deck name. |

| Flag | Type | Description |
| --- | --- | --- |
| `--subdecks` | boolean | Also archive every deck below it. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { decks: [names changed], archived }

```sh
etude deck archive "Old course" --subdecks
```

### etude deck unarchive

<a id="deck-unarchive"></a>

Bring an archived deck back.

```
etude deck unarchive <deck> [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `deck` | Deck name. |

| Flag | Type | Description |
| --- | --- | --- |
| `--subdecks` | boolean | Also unarchive every deck below it. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { decks: [names changed], archived }

```sh
etude deck unarchive "Old course" --subdecks
```

### etude deck delete

<a id="deck-delete"></a>

Delete an empty deck and its empty subdecks. Decks holding items can't be deleted: move or archive them.

```
etude deck delete <deck> [flags]
```

*writes · `--dry-run` · needs `--yes`*

| Argument | Description |
| --- | --- |
| `deck` | Deck name. |

| Flag | Type | Description |
| --- | --- | --- |
| `--dry-run` | boolean | Show what would change without writing anything. |
| `-y, --yes` | boolean | Confirm a destructive operation. |

Output: { deleted: [names] }

```sh
etude deck delete "Scratch" --yes
```

### etude deck description

<a id="deck-description"></a>

Get or set a deck's markdown description.

```
etude deck description <deck> [text] [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `deck` | Deck name. |
| `text` (optional) | New text; `-` reads stdin. Omit to print the current value. |

| Flag | Type | Description |
| --- | --- | --- |
| `--file <PATH>` | string | Read the new text from a file. |
| `--clear` | boolean | Set it to empty. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { deck, description }

```sh
etude deck description "Networks"
etude deck description "Networks" --file notes.md
```

### etude deck instructions

<a id="deck-instructions"></a>

Get or set a deck's AI grading instructions (they apply to its subdecks too).

The AI grader reads instructions from most to least specific: the item's rubric, its tags (deepest first), the deck and each parent deck, then the card type.

```
etude deck instructions <deck> [text] [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `deck` | Deck name. |
| `text` (optional) | New text; `-` reads stdin. Omit to print the current value. |

| Flag | Type | Description |
| --- | --- | --- |
| `--file <PATH>` | string | Read the new text from a file. |
| `--clear` | boolean | Set it to empty. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { deck, instructions }

```sh
etude deck instructions "Networks"
etude deck instructions "Networks" --file notes.md
```

### etude deck set

<a id="deck-set"></a>

Override settings on this deck (they win over its preset and parents).

Values are JSON when they parse, text otherwise. Steps accept "1m 10m" or '["1m","10m"]'. Dates accept anything Date can read. Keys: desiredRetention, learningSteps, relearningSteps, maximumInterval, enableFuzz, enableShortTerm, newPerDay, reviewsPerDay, newOrder, reviewOrder, newMix, deadline, deadlineMargin, autoRate, autoApply, burySiblings, mode, scheduler, schedulerOptions, weights; also autoRate.good and autoRate.hard.

```
etude deck set <deck> <pairs...> [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `deck` | Deck name. |
| `pairs...` | key=value pairs. |

| Flag | Type | Description |
| --- | --- | --- |
| `--to-preset` | boolean | Write the values into the deck's preset instead (every deck using it changes) and drop this deck's own overrides of those keys, like “Save to preset” in the app. |
| `--reschedule` | boolean | Replay the deck's review history with the new settings afterwards (what the app offers after changing retention, steps or a deadline). |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { deck, config (own overrides), changed: { key: { from, to } } (effective values), rescheduled? }

```sh
etude deck set "Networks" deadline=2026-10-23T16:30:00-07:00 desiredRetention=0.92 --reschedule
etude deck set "Spanish" newPerDay=30 learningSteps="1m 10m 1h"
etude deck set "Networks" newPerDay=40 --to-preset
etude deck set "Typing" scheduler=drill schedulerOptions.perDay=3
```

### etude deck unset

<a id="deck-unset"></a>

Remove this deck's own overrides so the values are inherited again.

```
etude deck unset <deck> [keys...] [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `deck` | Deck name. |
| `keys...` (optional) | Setting names. Omit with --all. |

| Flag | Type | Description |
| --- | --- | --- |
| `--all` | boolean | Remove every override. |
| `--reschedule` | boolean | Replay the deck's review history with the new settings afterwards (what the app offers after changing retention, steps or a deadline). |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { deck, removed, config, changed }

```sh
etude deck unset "Networks" deadline
etude deck unset "Networks" --all
```

### etude deck optimize

<a id="deck-optimize"></a>

Fit the FSRS weights this deck uses to the history of every deck sharing them (Anki's Optimize).

The weights belong to the deck's preset, or to the deck itself when it overrides them, and --apply saves them there. Trains FSRS-6 on the review history (practice reviews don't count) of every deck that shares these weights, with fsrs-rs, the optimizer Anki uses, and compares how well the current and the new weights predict that history: log loss and RMSE, lower is better. Nothing changes without --apply, and --apply only saves weights that fit better (lower RMSE). Needs at least 400 reviews and the optional package @open-spaced-repetition/binding, which `npm install` adds on supported platforms.

```
etude deck optimize <deck> [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `deck` | Deck name. |

| Flag | Type | Description |
| --- | --- | --- |
| `--apply` | boolean | Save the new weights where the current ones come from, if they fit the history better. |
| `--reschedule` | boolean | With --apply: replay every card's history in those decks with the new weights. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { source: { kind: preset|deck, id|name }, decks, cards, reviews, items, current, weights, before: { logLoss, rmse }, after: { logLoss, rmse }, better, applied, rescheduled? }

```sh
etude deck optimize "Networks"
etude deck optimize "Networks" --apply --reschedule
```

### etude deck preset

<a id="deck-preset"></a>

Attach a preset to a deck, or detach it with `none`.

```
etude deck preset <deck> <preset> [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `deck` | Deck name. |
| `preset` | Preset id, or `none`. |

| Flag | Type | Description |
| --- | --- | --- |
| `--clear-overrides` | boolean | Also drop the deck's own overrides so the preset fully applies. |
| `--reschedule` | boolean | Replay the deck's review history with the new settings afterwards (what the app offers after changing retention, steps or a deadline). |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { deck, presetId, changed }

```sh
etude deck preset "Networks" exam
etude deck preset "Networks" none
```

## preset

Presets: named settings shared by several decks.

### etude preset list

<a id="preset-list"></a>

Every preset with the decks that use it.

```
etude preset list
```

*read-only*

Output: array of { id, name, config, decks: [names] }

### etude preset show

<a id="preset-show"></a>

A preset: its own values, the full settings it produces on a top-level deck, and its decks.

```
etude preset show <id>
```

*read-only*

| Argument | Description |
| --- | --- |
| `id` | Preset id. |

Output: { id, name, config, resolved, decks: [{ deck, archived }] }

### etude preset create

<a id="preset-create"></a>

Create a preset from key=value pairs, or copy a deck's effective settings with --from-deck.

With --from-deck the preset captures every setting the deck uses now (what the app's “New preset from these settings” does). Add --apply to attach it to that deck and move the deck's own overrides into it.

```
etude preset create <id> [pairs...] [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `id` | Lowercase slug (a-z, 0-9, -). |
| `pairs...` (optional) | key=value settings. |

| Flag | Type | Description |
| --- | --- | --- |
| `--name <VALUE>` | string | Display name. Defaults to the id. |
| `--from-deck <DECK>` | string | Start from this deck's effective settings. |
| `--apply` | boolean | With --from-deck: use the new preset on that deck and clear its own overrides. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { preset, applied? }

```sh
etude preset create exam --name "Exam cram" desiredRetention=0.92 deadline=2026-10-23T16:30-07:00 newPerDay=50
etude preset create net --from-deck "Networks" --apply
```

### etude preset set

<a id="preset-set"></a>

Change settings in a preset. Every deck using it is affected.

Keys: desiredRetention, learningSteps, relearningSteps, maximumInterval, enableFuzz, enableShortTerm, newPerDay, reviewsPerDay, newOrder, reviewOrder, newMix, deadline, deadlineMargin, autoRate, autoApply, burySiblings, mode, scheduler, schedulerOptions, weights; also autoRate.good / autoRate.hard. Use `--name` to rename.

```
etude preset set <id> [pairs...] [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `id` | Preset id. |
| `pairs...` (optional) | key=value pairs. |

| Flag | Type | Description |
| --- | --- | --- |
| `--name <VALUE>` | string | New display name. |
| `--reschedule` | boolean | Replay review history for every deck using the preset. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { preset, decks, rescheduled? }

```sh
etude preset set exam desiredRetention=0.95
etude preset set exam --name "Final exam"
```

### etude preset unset

<a id="preset-unset"></a>

Remove keys from a preset so they fall back to the defaults (or the deck's parents).

```
etude preset unset <id> <keys...> [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `id` | Preset id. |
| `keys...` | Setting names. |

| Flag | Type | Description |
| --- | --- | --- |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { preset, removed }

```sh
etude preset unset exam deadline
```

### etude preset rename

<a id="preset-rename"></a>

Change a preset's display name (the id stays).

```
etude preset rename <id> <name> [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `id` | Preset id. |
| `name` | New display name. |

| Flag | Type | Description |
| --- | --- | --- |
| `--dry-run` | boolean | Show what would change without writing anything. |

```sh
etude preset rename exam "Midterm cram"
```

### etude preset delete

<a id="preset-delete"></a>

Delete a preset no deck uses (archived decks count).

```
etude preset delete <id> [flags]
```

*writes · `--dry-run` · needs `--yes`*

| Argument | Description |
| --- | --- |
| `id` | Preset id. |

| Flag | Type | Description |
| --- | --- | --- |
| `--dry-run` | boolean | Show what would change without writing anything. |
| `-y, --yes` | boolean | Confirm a destructive operation. |

Output: { deleted: id }

```sh
etude preset delete old-exam --yes
```

### etude preset decks

<a id="preset-decks"></a>

Decks that use a preset.

```
etude preset decks <id>
```

*read-only*

| Argument | Description |
| --- | --- |
| `id` | Preset id. |

Output: array of { deck, archived }

### etude preset optimize

<a id="preset-optimize"></a>

Fit the preset's FSRS weights to the review history of the decks using it (Anki's Optimize).

Trains FSRS-6 on the review history (practice reviews don't count) of every deck that shares these weights, with fsrs-rs, the optimizer Anki uses, and compares how well the current and the new weights predict that history: log loss and RMSE, lower is better. Nothing changes without --apply, and --apply only saves weights that fit better (lower RMSE). Needs at least 400 reviews and the optional package @open-spaced-repetition/binding, which `npm install` adds on supported platforms.

```
etude preset optimize <id> [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `id` | Preset id. |

| Flag | Type | Description |
| --- | --- | --- |
| `--apply` | boolean | Save the new weights where the current ones come from, if they fit the history better. |
| `--reschedule` | boolean | With --apply: replay every card's history in those decks with the new weights. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { source: { kind: preset|deck, id|name }, decks, cards, reviews, items, current, weights, before: { logLoss, rmse }, after: { logLoss, rmse }, better, applied, rescheduled? }

```sh
etude preset optimize exam
etude preset optimize exam --apply --reschedule
```

### etude preset defaults

<a id="preset-defaults"></a>

The built-in default for every scheduling setting (what applies when no deck or preset sets it).

```
etude preset defaults
```

*read-only · no database*

Output: the default settings object

## item

Items: the content (fields, tags, source) behind one or more cards.

### etude item list

<a id="item-list"></a>

Items matching a search (one row per item, not per card).

```
etude item list [query...] [flags]
```

*read-only*

| Argument | Description |
| --- | --- |
| `query...` (optional) | Search (see `Search language`); several words are joined. |

| Flag | Type | Description |
| --- | --- | --- |
| `--deck <NAME>` | string | Limit to this deck and its subdecks. |
| `--order <added\|deck\|updated\|created\|due\|lapses\|id>` | string | Sort order (due: soonest due card first, new cards last). Default `"added"`. |
| `--limit <N>` | number | Maximum rows to return. Default `100`. |
| `--offset <N>` | number | Rows to skip (for paging). Default `0`. |
| `--ids` | boolean | Print only item ids, one per line (handy for piping into bulk commands). |

Output: { total, rows: [{ id, type, deck, tags, title, source, cards, suspended, archived, generated, updated }] }

```sh
etude item list deck:"Networks" tag:delay
etude item list type:numeric --ids | etude item tag - -t numeric
```

### etude item show

<a id="item-show"></a>

An item with its fields, cards, scheduling, reviews and attempts.

```
etude item show <id>
```

*read-only*

| Argument | Description |
| --- | --- |
| `id` | Item id. |

Output: { id, type, deck, fields, tags, source, notes, archived, created, updated, cards: [...], reviews: [...], attempts: [...] }

### etude item ai-edit

<a id="item-ai-edit"></a>

Ask the configured language model to propose changes to a card's content. Nothing is saved.

Uses the language model configured for feedback. Pass --fields or --fields-file to work from an unsaved draft. Review the returned fields, then use `item edit --replace-fields --fields` to save them.

```
etude item ai-edit <id> [flags]
```

*read-only*

| Argument | Description |
| --- | --- |
| `id` | Item id. |

| Flag | Type | Description |
| --- | --- | --- |
| `--instruction <TEXT>` | string | Describe the change (`-` reads stdin). |
| `--instruction-file <PATH>` | string | Read the requested change from a file. |
| `--fields <JSON>` | string | Fields as a JSON object (`-` reads stdin). |
| `--fields-file <PATH>` | string | Read the fields JSON object from a file (`-` for stdin). |

Output: { itemId, fields, changed: [fieldNames], model, ms, cost? }

```sh
etude item ai-edit net.router --instruction "Make the answer shorter and add an example"
etude item ai-edit sp.perro --instruction-file change.txt --fields-file draft.json
```

### etude item add

<a id="item-add"></a>

Add an item. Re-running with the same --id and content is a no-op.

Fields come from --fields JSON, --fields-file, --set field=value, --set-file field=path, or a flag per field (`--front "..."`, `--back-file a.md`, `--answer 0.1`). Values are parsed by the field's kind: number fields need numbers, list fields take JSON arrays (or one string), json fields take JSON. Without --id an id is made from the deck and the first text field. If --id already exists with different content the command fails unless --upsert.

```
etude item add [flags]
```

*writes · `--dry-run`*

| Flag | Type | Description |
| --- | --- | --- |
| `--type <VALUE>` | string | Card type id (see `etude type list`). Default `"basic"`. |
| `--deck <NAME>` | string | Deck path (created if missing). |
| `--id <VALUE>` | string | Stable item id, e.g. course.unit.topic-1. Generated when omitted. |
| `--fields <JSON>` | string | Fields as a JSON object (`-` reads stdin). |
| `--fields-file <PATH>` | string | Read the fields JSON object from a file (`-` for stdin). |
| `--set <KEY=VALUE> (repeatable)` | string | field=value; the value is parsed as the field's kind (numbers, lists, JSON). Prefix with `fields.` if a field shares a name with deck, tags, source or notes. |
| `--set-file <KEY=PATH> (repeatable)` | string | field=path: read a field's text from a file (`-` for stdin). |
| `-t, --tag <VALUE> (repeatable)` | string | A tag (repeatable; commas also split). `::` makes a hierarchy: course::week1. |
| `--source <VALUE>` | string | Where the content comes from (shown after answering). |
| `--notes <VALUE>` | string | Private notes (`-` reads stdin). |
| `--notes-file <PATH>` | string | Read notes from a file. |
| `--upsert` | boolean | Update the item when the id exists with different content. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Any other `--<field> VALUE` or `--<field>-file PATH` sets that field of the item (see `etude type show <type>` for field names).

Output: { result: created|updated|unchanged, item: { id, type, deck, tags, title, cards: [{ cardId, face, state, due }] } }

```sh
etude item add --deck "Spanish" --front "el perro" --back "the dog" -t vocab
etude item add --type numeric --deck "Networks::Delay" --id net.dtrans-1 --prompt "1500 B on 10 Mbps: $d_{trans}$ in ms?" --answer 1.2 --unit ms
etude item add --type mcq --deck Quiz --fields-file q.json
cat prompt.md | etude item add --type free --deck Essays --prompt - --reference-file ref.md
```

### etude item edit

<a id="item-edit"></a>

Change an item's fields, deck, tags, source, notes or type. Scheduling is kept.

Field values merge into the existing ones; --unset removes a field; --replace-fields starts from an empty set. --tag replaces all tags; --add-tag / --remove-tag adjust them. A `--<field> VALUE` flag works like --set.

```
etude item edit <id> [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `id` | Item id. |

| Flag | Type | Description |
| --- | --- | --- |
| `--fields <JSON>` | string | Fields as a JSON object (`-` reads stdin). |
| `--fields-file <PATH>` | string | Read the fields JSON object from a file (`-` for stdin). |
| `--set <KEY=VALUE> (repeatable)` | string | field=value; the value is parsed as the field's kind (numbers, lists, JSON). Prefix with `fields.` if a field shares a name with deck, tags, source or notes. |
| `--set-file <KEY=PATH> (repeatable)` | string | field=path: read a field's text from a file (`-` for stdin). |
| `--unset <VALUE> (repeatable)` | string | Remove a field (back to its default). |
| `--replace-fields` | boolean | Discard existing fields first. |
| `--deck <VALUE>` | string | Move to this deck. |
| `--type <VALUE>` | string | Change the card type (fields must fit the new type). |
| `-t, --tag <VALUE> (repeatable)` | string | A tag (repeatable; commas also split). `::` makes a hierarchy: course::week1. |
| `--add-tag <VALUE> (repeatable)` | string | Add a tag. |
| `--remove-tag <VALUE> (repeatable)` | string | Remove a tag. |
| `--source <VALUE>` | string | New source. |
| `--notes <VALUE>` | string | New notes (`-` reads stdin). |
| `--notes-file <PATH>` | string | Read notes from a file. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Any other `--<field> VALUE` or `--<field>-file PATH` sets that field of the item (see `etude type show <type>` for field names).

Output: { result, changed: [keys], item }

```sh
etude item edit net.dtrans-1 --set answer=1.2 --set unit=ms
etude item edit sp.perro --back-file back.md --add-tag review
etude item edit q1 --set tags='["a","b"]' --unset extra
```

### etude item move

<a id="item-move"></a>

Move items to another deck.

```
etude item move [ids...] [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `ids...` (optional) | Item ids; `-` reads ids from stdin, one per line. Or use --query / --deck. |

| Flag | Type | Description |
| --- | --- | --- |
| `--to <DECK>` | string | Destination deck (created if missing). |
| `--deck <NAME>` | string | Limit to this deck and its subdecks. |
| `--query <SEARCH>` | string | Limit to cards matching a search (see `Search language`). Also `--q`. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { count, ids, deck }

```sh
etude item move q1 q2 --to "Networks::Review"
etude item move --query "tag:hard" --to "Hard ones"
```

### etude item tag

<a id="item-tag"></a>

Add tags to items.

```
etude item tag [ids...] [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `ids...` (optional) | Item ids; `-` reads ids from stdin, one per line. Or use --query / --deck. |

| Flag | Type | Description |
| --- | --- | --- |
| `-t, --tag <VALUE> (repeatable)` | string | Tag to add (repeatable; commas split). |
| `--deck <NAME>` | string | Limit to this deck and its subdecks. |
| `--query <SEARCH>` | string | Limit to cards matching a search (see `Search language`). Also `--q`. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { count, ids, tags }

```sh
etude item tag q1 q2 -t exam::core
etude item tag --query "deck:Physics prop:lapses>=3" -t leech
```

### etude item untag

<a id="item-untag"></a>

Remove tags from items.

```
etude item untag [ids...] [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `ids...` (optional) | Item ids; `-` reads ids from stdin, one per line. Or use --query / --deck. |

| Flag | Type | Description |
| --- | --- | --- |
| `-t, --tag <VALUE> (repeatable)` | string | Tag to remove (repeatable; commas split). |
| `--deck <NAME>` | string | Limit to this deck and its subdecks. |
| `--query <SEARCH>` | string | Limit to cards matching a search (see `Search language`). Also `--q`. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { count, ids, tags }

```sh
etude item untag q1 q2 -t exam::core
etude item untag --query "deck:Physics prop:lapses>=3" -t leech
```

### etude item archive

<a id="item-archive"></a>

Archive items: hidden from study and search, history kept. The safe way to remove content.

```
etude item archive [ids...] [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `ids...` (optional) | Item ids; `-` reads ids from stdin, one per line. Or use --query / --deck. |

| Flag | Type | Description |
| --- | --- | --- |
| `--deck <NAME>` | string | Limit to this deck and its subdecks. |
| `--query <SEARCH>` | string | Limit to cards matching a search (see `Search language`). Also `--q`. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { count, ids }

```sh
etude item archive --query "tag:outdated"
```

### etude item unarchive

<a id="item-unarchive"></a>

Restore archived items.

```
etude item unarchive [ids...] [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `ids...` (optional) | Item ids; `-` reads ids from stdin, one per line. Or use --query / --deck. |

| Flag | Type | Description |
| --- | --- | --- |
| `--deck <NAME>` | string | Limit to this deck and its subdecks. |
| `--query <SEARCH>` | string | Limit to cards matching a search (see `Search language`). Also `--q`. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { count, ids }

```sh
etude item unarchive q1
```

### etude item delete

<a id="item-delete"></a>

Permanently delete items with their cards and review history. Prefer `item archive`.

```
etude item delete [ids...] [flags]
```

*writes · `--dry-run` · needs `--yes`*

| Argument | Description |
| --- | --- |
| `ids...` (optional) | Item ids; `-` reads ids from stdin, one per line. Or use --query / --deck. |

| Flag | Type | Description |
| --- | --- | --- |
| `--deck <NAME>` | string | Limit to this deck and its subdecks. |
| `--query <SEARCH>` | string | Limit to cards matching a search (see `Search language`). Also `--q`. |
| `--archived` | boolean | With --query: match archived items too. |
| `--dry-run` | boolean | Show what would change without writing anything. |
| `-y, --yes` | boolean | Confirm a destructive operation. |

Output: { count, ids }

```sh
etude item delete scratch.1 --yes
etude item delete --query "deck:Scratch" --archived --dry-run
```

### etude item duplicate

<a id="item-duplicate"></a>

Copy an item's content (not its scheduling) under a new id.

```
etude item duplicate <id> [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `id` | Item to copy. |

| Flag | Type | Description |
| --- | --- | --- |
| `--id <VALUE>` | string | Id for the copy. Default: <id>-2, -3, ... Also `--new-id`. |
| `--to <DECK>` | string | Put the copy in this deck. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { id, from, item }

```sh
etude item duplicate net.dtrans-1
etude item duplicate q1 --id q1-reverse --to Other
```

### etude item preview

<a id="item-preview"></a>

What a card of this item shows (view), for a seed. The answer key only with --with-key.

Doesn't record anything. For generated items each seed is a different variant; the same seed always gives the same one.

```
etude item preview <id> [flags]
```

*read-only*

| Argument | Description |
| --- | --- |
| `id` | Item id. |

| Flag | Type | Description |
| --- | --- | --- |
| `--seed <N>` | number | Variant seed. Default `1`. |
| `--face <VALUE>` | string | With item ids: only the card for this face. |
| `--with-key` | boolean | Include the private answer key and the generated fields. Don't show these to a learner before they answer. |

Output: { itemId, face, seed, view, key?, fields? }

```sh
etude item preview net.dtrans-1 --seed 7
etude item preview q1 --with-key
```

### etude item variants

<a id="item-variants"></a>

Sample a generated item's outputs over several seeds (with keys), to check a generator.

```
etude item variants <id> [flags]
```

*read-only*

| Argument | Description |
| --- | --- |
| `id` | Item id. |

| Flag | Type | Description |
| --- | --- | --- |
| `-n, --count <N>` | number | How many variants. Default `5`. |
| `--seed <N>` | number | First seed. Default `1`. |
| `--face <VALUE>` | string | With item ids: only the card for this face. |

Output: { itemId, generated, distinct, variants: [{ seed, view, key }] }

```sh
etude item variants net.dtrans-1 -n 10
```

## card

Cards: per-card scheduling (suspend, bury, reset, due dates, intervals).

### etude card show

<a id="card-show"></a>

A card's scheduling: state, due, stability, difficulty, recall probability now, and what each rating would do.

```
etude card show <ref> [flags]
```

*read-only*

| Argument | Description |
| --- | --- |
| `ref` | Card id, or an item id with a single card (or --face). |

| Flag | Type | Description |
| --- | --- | --- |
| `--face <VALUE>` | string | With item ids: only the card for this face. |

Output: { cardId, itemId, face, deck, state, stateName, due, stability, difficulty, reps, lapses, lastReview, suspended, buriedUntil, retrievability, intervals, deadline }

```sh
etude card show 42
etude card show net.dtrans-1
```

### etude card list

<a id="card-list"></a>

Cards matching a search (one row per card), with scheduling.

```
etude card list [query...] [flags]
```

*read-only*

| Argument | Description |
| --- | --- |
| `query...` (optional) | Search; words are joined. |

| Flag | Type | Description |
| --- | --- | --- |
| `--deck <NAME>` | string | Limit to this deck and its subdecks. |
| `--order <added\|due\|deck\|lapses\|difficulty\|updated>` | string | Sort order. Default `"added"`. |
| `--limit <N>` | number | Maximum rows. Default `100`. |
| `--offset <N>` | number | Rows to skip. Default `0`. |
| `--ids` | boolean | Print only card ids, one per line. |

Output: { total, rows: [{ cardId, itemId, face, type, deck, tags, title, state, stateName, due, reps, lapses, stability, difficulty, suspended, archived, generated, retrievability }] }

```sh
etude card list is:due --order due
etude card list "prop:lapses>=3" --ids | etude card suspend -
```

### etude card intervals

<a id="card-intervals"></a>

When the card would next be due for each rating (again, hard, good, easy), right now.

```
etude card intervals <ref> [flags]
```

*read-only*

| Argument | Description |
| --- | --- |
| `ref` | Card id, or an item id with a single card. |

| Flag | Type | Description |
| --- | --- | --- |
| `--face <VALUE>` | string | With item ids: only the card for this face. |

Output: { cardId, state, intervals: { again: { rating, due, in }, hard, good, easy } }

```sh
etude card intervals 42
```

### etude card suspend

<a id="card-suspend"></a>

Suspend cards: they never come up until unsuspended.

```
etude card suspend [refs...] [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `refs...` (optional) | Card ids, or item ids (all of an item's cards; narrow with --face). `-` reads them from stdin. Or use --query / --deck. |

| Flag | Type | Description |
| --- | --- | --- |
| `--deck <NAME>` | string | Limit to this deck and its subdecks. |
| `--query <SEARCH>` | string | Limit to cards matching a search (see `Search language`). Also `--q`. |
| `--face <VALUE>` | string | With item ids: only the card for this face. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { count, cards: [{ cardId, itemId, face, state, due, suspended, buriedUntil }] }

```sh
etude card suspend 42 43
etude card suspend --query "deck:Physics prop:lapses>=4"
```

### etude card unsuspend

<a id="card-unsuspend"></a>

Unsuspend cards.

```
etude card unsuspend [refs...] [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `refs...` (optional) | Card ids, or item ids (all of an item's cards; narrow with --face). `-` reads them from stdin. Or use --query / --deck. |

| Flag | Type | Description |
| --- | --- | --- |
| `--deck <NAME>` | string | Limit to this deck and its subdecks. |
| `--query <SEARCH>` | string | Limit to cards matching a search (see `Search language`). Also `--q`. |
| `--face <VALUE>` | string | With item ids: only the card for this face. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { count, cards: [{ cardId, itemId, face, state, due, suspended, buriedUntil }] }

```sh
etude card unsuspend 42 43
etude card unsuspend --query "deck:Physics prop:lapses>=4"
```

### etude card unbury

<a id="card-unbury"></a>

Unbury cards so they can come up today.

```
etude card unbury [refs...] [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `refs...` (optional) | Card ids, or item ids (all of an item's cards; narrow with --face). `-` reads them from stdin. Or use --query / --deck. |

| Flag | Type | Description |
| --- | --- | --- |
| `--deck <NAME>` | string | Limit to this deck and its subdecks. |
| `--query <SEARCH>` | string | Limit to cards matching a search (see `Search language`). Also `--q`. |
| `--face <VALUE>` | string | With item ids: only the card for this face. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { count, cards: [{ cardId, itemId, face, state, due, suspended, buriedUntil }] }

```sh
etude card unbury 42 43
etude card unbury --query "deck:Physics prop:lapses>=4"
```

### etude card reset

<a id="card-reset"></a>

Forget cards: back to new, as if never studied. Review history is kept (and `card reschedule` would rebuild from it).

```
etude card reset [refs...] [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `refs...` (optional) | Card ids, or item ids (all of an item's cards; narrow with --face). `-` reads them from stdin. Or use --query / --deck. |

| Flag | Type | Description |
| --- | --- | --- |
| `--deck <NAME>` | string | Limit to this deck and its subdecks. |
| `--query <SEARCH>` | string | Limit to cards matching a search (see `Search language`). Also `--q`. |
| `--face <VALUE>` | string | With item ids: only the card for this face. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { count, cards: [{ cardId, itemId, face, state, due, suspended, buriedUntil }] }

```sh
etude card reset 42 43
etude card reset --query "deck:Physics prop:lapses>=4"
```

### etude card bury

<a id="card-bury"></a>

Hide cards until the next study day, or until a date.

```
etude card bury [refs...] [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `refs...` (optional) | Card ids, or item ids (all of an item's cards; narrow with --face). `-` reads them from stdin. Or use --query / --deck. |

| Flag | Type | Description |
| --- | --- | --- |
| `--deck <NAME>` | string | Limit to this deck and its subdecks. |
| `--query <SEARCH>` | string | Limit to cards matching a search (see `Search language`). Also `--q`. |
| `--face <VALUE>` | string | With item ids: only the card for this face. |
| `--date <DATE>` | string | A date (2026-10-22 means the start of that study day) or ISO date-time; also `today`, `tomorrow`. |
| `--in <DURATION>` | string | A duration from now: 30m, 12h, 3d, 2w. |
| `--note` | boolean | Bury every card of the selected cards' items. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { count, until, cards }

```sh
etude card bury 42
etude card bury 42 --note
etude card bury --query tag:hard --in 3d
```

### etude card due

<a id="card-due"></a>

Set when cards are next due, without recording a review.

Review and learning cards keep their stability and difficulty; only the date moves, so the next review is scored as if it happened at the new time. New cards stay new and won't be introduced before the date. `--now` makes cards due immediately. A deck deadline is not applied here: you set the date explicitly.

```
etude card due [refs...] [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `refs...` (optional) | Card ids, or item ids (all of an item's cards; narrow with --face). `-` reads them from stdin. Or use --query / --deck. |

| Flag | Type | Description |
| --- | --- | --- |
| `--deck <NAME>` | string | Limit to this deck and its subdecks. |
| `--query <SEARCH>` | string | Limit to cards matching a search (see `Search language`). Also `--q`. |
| `--face <VALUE>` | string | With item ids: only the card for this face. |
| `--date <DATE>` | string | A date (2026-10-22 means the start of that study day) or ISO date-time; also `today`, `tomorrow`. |
| `--in <DURATION>` | string | A duration from now: 30m, 12h, 3d, 2w. |
| `--now` | boolean | Right now. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { count, due, cards }

```sh
etude card due 42 --date 2026-10-22
etude card due --query "deck:\"Networks\" is:due" --in 1d
etude card due 42 --now
```

### etude card reschedule

<a id="card-reschedule"></a>

Rebuild cards' scheduling from their review history with the current settings (after changing retention, steps, weights or a deadline).

```
etude card reschedule [flags]
```

*writes · `--dry-run`*

| Flag | Type | Description |
| --- | --- | --- |
| `--deck <NAME>` | string | Limit to this deck and its subdecks. |
| `--query <SEARCH>` | string | Limit to cards matching a search (see `Search language`). Also `--q`. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { rescheduled: number }

```sh
etude card reschedule --deck "Networks"
```

## tag

Tags: hierarchical labels (a::b), with grading instructions and descriptions.

### etude tag list

<a id="tag-list"></a>

Tags in use, with item counts, instructions and descriptions.

```
etude tag list [flags]
```

*read-only*

| Flag | Type | Description |
| --- | --- | --- |
| `--prefix <VALUE>` | string | Only this tag and the tags below it. |

Output: array of { tag, items, instructions, description }

### etude tag show

<a id="tag-show"></a>

A tag's instructions, description, item count and subtags.

```
etude tag show <tag>
```

*read-only*

| Argument | Description |
| --- | --- |
| `tag` | Tag. |

Output: { tag, items, instructions, description, subtags }

### etude tag rename

<a id="tag-rename"></a>

Rename a tag on every item, with every tag below it (a::b → c::b).

```
etude tag rename <from> <to> [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `from` | Current tag. |
| `to` | New tag. |

| Flag | Type | Description |
| --- | --- | --- |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { from, to, tags: [{ from, to }] }

```sh
etude tag rename delay net::delay
```

### etude tag instructions

<a id="tag-instructions"></a>

Get or set a tag's AI grading instructions (apply to every item with the tag or a tag below it).

```
etude tag instructions <tag> [text] [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `tag` | Tag. |
| `text` (optional) | New text; `-` reads stdin. Omit to print the current value. |

| Flag | Type | Description |
| --- | --- | --- |
| `--file <PATH>` | string | Read the text from a file. |
| `--clear` | boolean | Set it to empty. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { tag, instructions }

```sh
etude tag instructions net::delay "Accept ms or s when the conversion is right."
```

### etude tag description

<a id="tag-description"></a>

Get or set a tag's description.

```
etude tag description <tag> [text] [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `tag` | Tag. |
| `text` (optional) | New text; `-` reads stdin. Omit to print the current value. |

| Flag | Type | Description |
| --- | --- | --- |
| `--file <PATH>` | string | Read the text from a file. |
| `--clear` | boolean | Set it to empty. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { tag, description }

```sh
etude tag description net::delay
```

### etude tag items

<a id="tag-items"></a>

Items with a tag (or a tag below it).

```
etude tag items <tag> [flags]
```

*read-only*

| Argument | Description |
| --- | --- |
| `tag` | Tag. |

| Flag | Type | Description |
| --- | --- | --- |
| `--limit <N>` | number | Maximum rows to return. Default `100`. |
| `--offset <N>` | number | Rows to skip (for paging). Default `0`. |
| `--ids` | boolean | Print only item ids. |

Output: same as `item list`

## type

Card types: fields, template (HTML/CSS/JS), prepare script and grader.

### etude type list

<a id="type-list"></a>

Card types with their grader, item count and whether they are shipped, edited or custom.

```
etude type list
```

*read-only*

Output: array of { id, name, description, builtin, shipped, edited, updated, items, grader, folder }

### etude type show

<a id="type-show"></a>

A type's full definition: fields (with kinds, private flags, defaults), template, prepare and grader code.

```
etude type show <id> [flags]
```

*read-only*

| Argument | Description |
| --- | --- |
| `id` | Type id. |

| Flag | Type | Description |
| --- | --- | --- |
| `--fields-only` | boolean | Only the field list (what an item of this type takes). |

```sh
etude type show numeric --fields-only
```

### etude type export

<a id="type-export"></a>

Write a type as editable files (type.json, template.html, style.css, card.js, prepare.js, grade.js), or print it as JSON.

```
etude type export <id> [flags]
```

*writes*

| Argument | Description |
| --- | --- |
| `id` | Type id. |

| Flag | Type | Description |
| --- | --- | --- |
| `-o, --out <DIR>` | string | Directory to write. Default: ./<id>. |
| `--json` | boolean | Print the definition as one JSON object instead of writing files. |

Output: { written: dir, files } or the definition with --json

```sh
etude type export numeric -o my-numeric
etude type export numeric --json > numeric.json
```

### etude type import

<a id="type-import"></a>

Create or update a type from a directory, a JSON file, or JSON on stdin (`-`). Saving an edited built-in makes it yours.

The type is validated first (fields, grader, script syntax). Items of the type get cards for any new faces. Unchanged definitions are a no-op.

```
etude type import <source> [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `source` | Type directory, type.json / JSON file, or `-`. |

| Flag | Type | Description |
| --- | --- | --- |
| `--id <VALUE>` | string | Save under this id instead of the one in the source. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { result: created|updated|unchanged, type: { id, name, fields, grader } }

```sh
etude type import ./vocab
etude type import vocab.json --dry-run
etude type export basic --json | jq '.id="basic2"' | etude type import -
```

### etude type validate

<a id="type-validate"></a>

Check a type definition without saving it. Exits 4 when it has problems.

```
etude type validate <source>
```

*read-only*

| Argument | Description |
| --- | --- |
| `source` | Type directory, JSON file, `-`, or a stored type id. |

Output: { id, ok, errors }

### etude type preview

<a id="type-preview"></a>

Run a type on sample fields and show what the card gets (view) and what grading uses (key).

Works on stored types or, with --from, on an unsaved directory. Placeholder values fill fields you don't give. Nothing is stored.

```
etude type preview [id] [flags]
```

*read-only*

| Argument | Description |
| --- | --- |
| `id` (optional) | Type id (ignored with --from). |

| Flag | Type | Description |
| --- | --- | --- |
| `--fields <JSON>` | string | Sample fields as JSON (`-` reads stdin). |
| `--fields-file <PATH>` | string | Read sample fields from a file. |
| `--item <VALUE>` | string | Use an existing item's fields as the sample. |
| `--seed <N>` | number | Seed for prepare scripts and generators. Default `1`. |
| `--face <VALUE>` | string | Face to render (types with several faces). |
| `--from <DIR\|FILE>` | string | Use an unsaved type from a directory or JSON file instead of the stored one. |

Output: { errors, view, key, seed }

```sh
etude type preview numeric --fields '{"prompt":"2+2?","answer":4}'
etude type preview --from ./unit-circle --item showcase.unit-circle.mixed
```

### etude type test-grade

<a id="type-test-grade"></a>

Run a type's grader on an answer without saving anything.

Script and hybrid graders run locally on sample fields (or --item's fields). AI graders need a real card: pass --item and the configured AI providers are called (no attempt is stored). Answers are JSON when they parse (`["1.2"]`, `{"l0":"r0"}`), text otherwise.

```
etude type test-grade [id] [flags]
```

*read-only*

| Argument | Description |
| --- | --- |
| `id` (optional) | Type id (ignored with --from). |

| Flag | Type | Description |
| --- | --- | --- |
| `--fields <JSON>` | string | Sample fields as JSON (`-` reads stdin). |
| `--fields-file <PATH>` | string | Read sample fields from a file. |
| `--item <VALUE>` | string | Use an existing item's fields as the sample. |
| `--seed <N>` | number | Seed for prepare scripts and generators. Default `1`. |
| `--face <VALUE>` | string | Face to render (types with several faces). |
| `--from <DIR\|FILE>` | string | Use an unsaved type from a directory or JSON file instead of the stored one. |
| `--answer <VALUE>` | string | The answer (`-` reads stdin). |
| `--answer-file <PATH>` | string | Read the answer from a file. |

Output: { grade: { score, verdict, details, feedback }, key }

```sh
etude type test-grade typed --fields '{"prompt":"Capital of France?","answers":["Paris"]}' --answer paris
etude type test-grade --item showcase.math.factor --answer "(x-2)(x-3)"
```

### etude type reset

<a id="type-reset"></a>

Restore an edited built-in type to the shipped version.

```
etude type reset <id> [flags]
```

*writes · `--dry-run` · needs `--yes`*

| Argument | Description |
| --- | --- |
| `id` | Built-in type id. |

| Flag | Type | Description |
| --- | --- | --- |
| `--dry-run` | boolean | Show what would change without writing anything. |
| `-y, --yes` | boolean | Confirm a destructive operation. |

```sh
etude type reset numeric --yes
```

### etude type delete

<a id="type-delete"></a>

Delete a custom type no item uses (archived items count).

```
etude type delete <id> [flags]
```

*writes · `--dry-run` · needs `--yes`*

| Argument | Description |
| --- | --- |
| `id` | Type id. |

| Flag | Type | Description |
| --- | --- | --- |
| `--dry-run` | boolean | Show what would change without writing anything. |
| `-y, --yes` | boolean | Confirm a destructive operation. |

```sh
etude type delete my-old-type --yes
```

### etude type move

<a id="type-move"></a>

Put a type in a folder of the Types page (created if needed); `--root` takes it out of every folder.

Folders only organize the Types page. Moving never changes the type's definition, so a built-in stays unedited.

```
etude type move <id> [folder] [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `id` | Type id. |
| `folder` (optional) | Folder path, `::` between levels (e.g. `Networks::DNS`). |

| Flag | Type | Description |
| --- | --- | --- |
| `--root` | boolean | Take the type out of every folder. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { id, folder }

```sh
etude type move dns-trace Networks::DNS
etude type move dns-trace --root
```

### etude type folder list

<a id="type-folder-list"></a>

Folders of the Types page with the types directly inside each one.

```
etude type folder list [flags]
```

*read-only*

| Flag | Type | Description |
| --- | --- | --- |
| `--tree` | boolean | Also list types that aren't in any folder, under the folder "". |

Output: array of { folder, depth, types: [ids] }

### etude type folder create

<a id="type-folder-create"></a>

Create a folder (and its parents) in the Types page.

```
etude type folder create <path> [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `path` | Folder path, `::` between levels. |

| Flag | Type | Description |
| --- | --- | --- |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { path }

```sh
etude type folder create Networks::DNS
```

### etude type folder rename

<a id="type-folder-rename"></a>

Rename or move a folder with every folder and type inside it.

```
etude type folder rename <from> <to> [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `from` | Current folder path. |
| `to` | New folder path. |

| Flag | Type | Description |
| --- | --- | --- |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { from, to, folders, types }

```sh
etude type folder rename Networks Courses::Networks
```

### etude type folder delete

<a id="type-folder-delete"></a>

Delete a folder and the folders inside it. Types are kept and move up to the parent folder.

```
etude type folder delete <path> [flags]
```

*writes · `--dry-run` · needs `--yes`*

| Argument | Description |
| --- | --- |
| `path` | Folder path. |

| Flag | Type | Description |
| --- | --- | --- |
| `--dry-run` | boolean | Show what would change without writing anything. |
| `-y, --yes` | boolean | Confirm a destructive operation. |

Output: { deleted, folders, moved: [type ids] }

```sh
etude type folder delete Networks::Old --yes
```

### etude type copy

<a id="type-copy"></a>

Copy a type (built-in or custom) under a new id, as a starting point.

```
etude type copy <id> <new-id> [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `id` | Type to copy. |
| `new-id` | Id for the copy. |

| Flag | Type | Description |
| --- | --- | --- |
| `--name <VALUE>` | string | Display name for the copy. |
| `--dry-run` | boolean | Show what would change without writing anything. |

```sh
etude type copy numeric numeric-units --name "Numeric with units"
```

### etude type new

<a id="type-new"></a>

Scaffold a minimal working type directory to edit and then `etude type import`.

```
etude type new <id> [flags]
```

*writes · no database*

| Argument | Description |
| --- | --- |
| `id` | New type id (lowercase slug). |

| Flag | Type | Description |
| --- | --- | --- |
| `-o, --out <DIR>` | string | Directory to create. Default: ./<id>. |
| `--name <VALUE>` | string | Display name. |
| `--grader <script\|self\|ai>` | string | Starting grader. Default `"script"`. |
| `--force` | boolean | Write into a non-empty directory. |

Output: { written: dir, files, next }

```sh
etude type new vocab -o types/vocab && $EDITOR types/vocab/template.html && etude type import types/vocab
```

### etude type frame

<a id="type-frame"></a>

The HTML document a card of this type renders in (what the app loads into its sandboxed iframe).

Runtime and KaTeX assets load from --base, so open the file while `etude serve` runs. Useful to debug a template outside the app.

```
etude type frame [id] [flags]
```

*read-only*

| Argument | Description |
| --- | --- |
| `id` (optional) | Type id (ignored with --from). |

| Flag | Type | Description |
| --- | --- | --- |
| `--from <DIR\|FILE>` | string | Use an unsaved type from a directory or JSON file. |
| `--base <VALUE>` | string | Server URL the frame loads its runtime from. Default `"http://127.0.0.1:4610/"`. |
| `-o, --out <FILE>` | string | Write the HTML to a file instead of stdout. |

Output: the HTML, or { written } with --out

```sh
etude type frame numeric -o numeric.html
```

## scheduler

Schedulers: who decides when a card comes back (FSRS, a drill, Leitner boxes, or your own script).

### etude scheduler list

<a id="scheduler-list"></a>

Every scheduler: FSRS (built in) and the script ones, with whether they ask for ratings, their options and how many decks use them.

```
etude scheduler list
```

*read-only*

Output: array of { id, name, description, ratings, options, builtin, shipped, edited, script, updated, decks }

### etude scheduler show

<a id="scheduler-show"></a>

A script scheduler's definition, including its schedule.js.

```
etude scheduler show <id>
```

*read-only*

| Argument | Description |
| --- | --- |
| `id` | Scheduler id. |

```sh
etude scheduler show drill
```

### etude scheduler export

<a id="scheduler-export"></a>

Write a script scheduler as editable files (scheduler.json + schedule.js), or print it as JSON.

```
etude scheduler export <id> [flags]
```

*writes*

| Argument | Description |
| --- | --- |
| `id` | Scheduler id. |

| Flag | Type | Description |
| --- | --- | --- |
| `-o, --out <DIR>` | string | Directory to write. Default: ./<id>. |
| `--json` | boolean | Print the definition as one JSON object instead of writing files. |

Output: { written: dir, files } or the definition with --json

```sh
etude scheduler export drill -o my-drill
etude scheduler export leitner --json
```

### etude scheduler import

<a id="scheduler-import"></a>

Create or update a scheduler from a directory (scheduler.json + schedule.js), a JSON file, or `-`.

schedule.js is the body of `function (card, attempt, options, ctx)` and returns `{ due, state }`. `card.state` is what it returned last time; `attempt` has the rating (when the scheduler asks for ratings), the grader's score and its `details`; `ctx.day[n]` is the start of the study day n days from today. See docs/schedulers.md.

```
etude scheduler import <source> [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `source` | Directory, JSON file, or `-`. |

| Flag | Type | Description |
| --- | --- | --- |
| `--id <VALUE>` | string | Save under this id instead of the one in the source. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { result: created|updated|unchanged, scheduler: { id, name, ratings } }

```sh
etude scheduler import ./every-monday
etude scheduler export drill --json | jq '.id="drill2"' | etude scheduler import -
```

### etude scheduler validate

<a id="scheduler-validate"></a>

Check a scheduler definition without saving it. Exits 4 when it has problems.

```
etude scheduler validate <source>
```

*read-only*

| Argument | Description |
| --- | --- |
| `source` | Directory, JSON file, or `-`. |

Output: { id, ok, errors }

### etude scheduler reset

<a id="scheduler-reset"></a>

Restore an edited built-in scheduler to the shipped version.

```
etude scheduler reset <id> [flags]
```

*writes · `--dry-run` · needs `--yes`*

| Argument | Description |
| --- | --- |
| `id` | Built-in scheduler id. |

| Flag | Type | Description |
| --- | --- | --- |
| `--dry-run` | boolean | Show what would change without writing anything. |
| `-y, --yes` | boolean | Confirm a destructive operation. |

```sh
etude scheduler reset drill --yes
```

### etude scheduler delete

<a id="scheduler-delete"></a>

Delete a custom scheduler no deck or preset uses.

```
etude scheduler delete <id> [flags]
```

*writes · `--dry-run` · needs `--yes`*

| Argument | Description |
| --- | --- |
| `id` | Scheduler id. |

| Flag | Type | Description |
| --- | --- | --- |
| `--dry-run` | boolean | Show what would change without writing anything. |
| `-y, --yes` | boolean | Confirm a destructive operation. |

```sh
etude scheduler delete every-monday --yes
```

## study

Studying: the queue, presenting a card, submitting answers, ratings, undo.

### etude study counts

<a id="study-counts"></a>

Today's queue for a scope: new, learning, review, done today, next due.

```
etude study counts [flags]
```

*read-only*

| Flag | Type | Description |
| --- | --- | --- |
| `--deck <NAME>` | string | Limit to this deck and its subdecks. |
| `--query <SEARCH>` | string | Limit to cards matching a search (see `Search language`). Also `--q`. |
| `--ahead` | boolean | Study ahead: nothing has to be due. Every card in the scope, soonest due first, no daily limits; ratings are real reviews. |

Output: { new, learning, learningSoon, review, doneToday, nextDue }

```sh
etude study counts --deck "Networks"
etude study counts --deck "Networks" --ahead
```

### etude study next

<a id="study-next"></a>

The next card to study in a scope, with its view and how to answer it. Private fields are never included.

Use `view` to present the card (render its markdown for the learner). Keep `cardId` and `seed`: submit with them so the answer is graded against exactly this variant. Respects daily limits and the preset's ordering; `--exclude` skips the card just answered. With `--ahead`, nothing has to be due: every card in the scope comes up, soonest due first.

```
etude study next [flags]
```

*read-only*

| Flag | Type | Description |
| --- | --- | --- |
| `--deck <NAME>` | string | Limit to this deck and its subdecks. |
| `--query <SEARCH>` | string | Limit to cards matching a search (see `Search language`). Also `--q`. |
| `--ahead` | boolean | Study ahead: nothing has to be due. Every card in the scope, soonest due first, no daily limits; ratings are real reviews. |
| `--exclude <N>` | number | Card id to avoid repeating right away. |

Output: { card: { cardId, itemId, face, seed, type, deck, tags, state, title, grader, view, answerFormat, intervals } | null, counts }

```sh
etude study next --deck "Networks"
etude study next --query "tag:delay is:due"
etude study next --deck "Networks" --ahead
```

### etude study card

<a id="study-card"></a>

Present a specific card (any time, due or not). A seed reproduces a variant; a new seed gives a new one.

```
etude study card <ref> [flags]
```

*read-only*

| Argument | Description |
| --- | --- |
| `ref` | Card id, or an item id with a single card. |

| Flag | Type | Description |
| --- | --- | --- |
| `--seed <N>` | number | Variant seed. Random when omitted. |
| `--face <VALUE>` | string | With item ids: only the card for this face. |

Output: { cardId, itemId, face, seed, view, answerFormat, ... }

```sh
etude study card 42 --seed 7
```

### etude study submit

<a id="study-submit"></a>

Grade an answer and store the attempt. Returns the grade, the suggested rating and the answer key. Doesn't schedule: follow with `study rate`.

```
etude study submit <ref> [flags]
```

*writes*

| Argument | Description |
| --- | --- |
| `ref` | Card id (or item id with one card). |

| Flag | Type | Description |
| --- | --- | --- |
| `--seed <N>` | number | The seed from `study next`/`study card`. Required, so the grade matches what was shown. |
| `-a, --answer <VALUE>` | string | The learner's answer, verbatim (`-` reads stdin). Parsed as JSON when it starts with `[`, `{` or `"` (`["1.2"]` for numeric parts, `["o0"]` for mcq); anything else is kept as typed. --text forces text. |
| `--answer-file <PATH>` | string | Read the answer from a file (`-` for stdin). |
| `--text` | boolean | Treat the answer as plain text even if it looks like JSON. |
| `--practice` | boolean | Practice only: the review is logged but the card's schedule doesn't move (like “another variant” in the app). |
| `--feedback` | boolean | Also write AI feedback now (when the grade has none). |
| `--face <VALUE>` | string | With item ids: only the card for this face. |

Output: { attemptId, cardId, grade: { score, verdict, feedback, details, suggested, grader }, suggested: { rating, name }, key, wantsFeedback, feedback? }

```sh
etude study submit 42 --seed 7 --answer '["1.2 ms"]'
etude study submit 43 --seed 3 --answer-file answer.md
```

### etude study feedback

<a id="study-feedback"></a>

AI feedback for an attempt (written once, then cached).

```
etude study feedback <attempt>
```

*writes*

| Argument | Description |
| --- | --- |
| `attempt` | Attempt id from `study submit`. |

Output: { feedback, model?, cached? }

### etude study rate

<a id="study-rate"></a>

Record a rating and reschedule the card. Pass --attempt to link the graded attempt.

```
etude study rate <ref> <rating> [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `ref` | Card id (or item id with one card). |
| `rating` | 1-4 or again, hard, good, easy. On a scheduler without ratings (a drill) use `next`. |

| Flag | Type | Description |
| --- | --- | --- |
| `--attempt <N>` | number | Attempt id from `study submit`. |
| `--duration <N>` | number | Milliseconds the learner spent (for stats). |
| `--practice` | boolean | Practice only: the review is logged but the card's schedule doesn't move (like “another variant” in the app). |
| `--face <VALUE>` | string | With item ids: only the card for this face. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { reviewId, cardId, rating, due, in, state }

```sh
etude study rate 42 good --attempt 118
etude study rate 42 1
```

### etude study answer

<a id="study-answer"></a>

Submit and rate in one step: grades the answer, then applies the suggested rating (or the one you give).

`--rate auto` (default) uses the grader's suggestion and fails, without rating, when there is none (self-graded cards, or a grading error): then ask the learner and run `study rate`. The attempt is still stored.

```
etude study answer <ref> [flags]
```

*writes*

| Argument | Description |
| --- | --- |
| `ref` | Card id (or item id with one card). |

| Flag | Type | Description |
| --- | --- | --- |
| `--seed <N>` | number | The seed the card was shown with. |
| `-a, --answer <VALUE>` | string | The learner's answer, verbatim (`-` reads stdin). Parsed as JSON when it starts with `[`, `{` or `"` (`["1.2"]` for numeric parts, `["o0"]` for mcq); anything else is kept as typed. --text forces text. |
| `--answer-file <PATH>` | string | Read the answer from a file (`-` for stdin). |
| `--text` | boolean | Treat the answer as plain text even if it looks like JSON. |
| `--rate <VALUE>` | string | auto, 1-4, or again/hard/good/easy. Default `"auto"`. |
| `--practice` | boolean | Practice only: the review is logged but the card's schedule doesn't move (like “another variant” in the app). |
| `--duration <N>` | number | Milliseconds spent. |
| `--face <VALUE>` | string | With item ids: only the card for this face. |

Output: { attemptId, grade, key, rated: { reviewId, rating, due, in } | null, needsRating? }

```sh
etude study answer 42 --seed 7 --answer '["1.2"]'
etude study answer 50 --seed 1 --answer "" --rate good
```

### etude study undo

<a id="study-undo"></a>

Undo the most recent review (any card): the card returns exactly to its previous state.

```
etude study undo [flags]
```

*writes · `--dry-run`*

| Flag | Type | Description |
| --- | --- | --- |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { undone: { cardId, itemId } | null }

### etude study watch

<a id="study-watch"></a>

Watch mode: the cards of a scope in order, one per item, each with an example answer and its grade. Records nothing.

What the app's Watch button shows, for decks in watch mode (a tour) or any scope. Each card carries `demo.answer` (the item's own `fields.demo`, or what its type's `demo.js` makes) and `demo.grade`: a recorded grade when the item ships one, otherwise the script grader's verdict on that answer. AI-graded cards without a recorded grade come back ungraded instead of calling a model.

```
etude study watch [flags]
```

*read-only*

| Flag | Type | Description |
| --- | --- | --- |
| `--deck <NAME>` | string | Limit to this deck and its subdecks. |
| `--query <SEARCH>` | string | Limit to cards matching a search (see `Search language`). Also `--q`. |
| `--limit <N>` | number | At most this many cards. |

Output: { cards: [{ cardId, itemId, type, deck, title, seed, view, demo: { answer, grade } }] }

```sh
etude study watch --deck "Etude Showcase"
etude study watch --query "type:chess"
```

## stats

Statistics: overview, forecast, recall per tag.

### etude stats overview

<a id="stats-overview"></a>

Everything the Stats page shows for a scope: card states, retention, recall, daily activity, forecast, ratings, verdicts, streak, deadline.

```
etude stats overview [flags]
```

*read-only*

| Flag | Type | Description |
| --- | --- | --- |
| `--deck <NAME>` | string | Limit to this deck and its subdecks. |
| `--query <SEARCH>` | string | Limit to cards matching a search (see `Search language`). Also `--q`. |
| `--days <N>` | number | Activity window in days (heatmap, ratings, verdicts). Default `30`. |

Output: the engine's stats object (cards, retention, trueRetention, recall, days, forecast, overdue, tags, tagTree, today, ratings, verdicts, streak, window, deadline, schedulers: one row per scheduler with cards, due, pass rate and state groups, practice)

```sh
etude stats --deck "Networks"
etude stats overview --days 90
```

### etude stats forecast

<a id="stats-forecast"></a>

Cards due per day for the next 30 days (overdue counts on today).

```
etude stats forecast [flags]
```

*read-only*

| Flag | Type | Description |
| --- | --- | --- |
| `--deck <NAME>` | string | Limit to this deck and its subdecks. |
| `--query <SEARCH>` | string | Limit to cards matching a search (see `Search language`). Also `--q`. |

Output: { overdue, forecast: [{ day, due }], deadline }

### etude stats tags

<a id="stats-tags"></a>

Predicted recall per tag (with parent tags), weakest first.

```
etude stats tags [flags]
```

*read-only*

| Flag | Type | Description |
| --- | --- | --- |
| `--deck <NAME>` | string | Limit to this deck and its subdecks. |
| `--query <SEARCH>` | string | Limit to cards matching a search (see `Search language`). Also `--q`. |
| `--min-cards <N>` | number | Skip tags with fewer seen cards. Default `1`. |

Output: array of { tag, depth, cards, seen, recall }

```sh
etude stats tags --deck "Networks"
```

### etude stats weak

<a id="stats-weak"></a>

Cards most likely forgotten or most often lapsed: candidates for rewording, splitting or suspending.

Sorted by lapses, then by recall probability now. Leeches are cards with at least --lapses lapses.

```
etude stats weak [flags]
```

*read-only*

| Flag | Type | Description |
| --- | --- | --- |
| `--deck <NAME>` | string | Limit to this deck and its subdecks. |
| `--query <SEARCH>` | string | Limit to cards matching a search (see `Search language`). Also `--q`. |
| `--lapses <N>` | number | Minimum lapses to count as weak. Default `2`. |
| `--limit <N>` | number | Rows. Default `20`. |

Output: { total, rows: [card rows as in `card list`] }

```sh
etude stats weak --deck "Networks" --lapses 3
```

## settings

App settings: AI providers and models, day start, learn-ahead, ChatGPT sign-in.

### etude settings get

<a id="settings-get"></a>

Current settings, or one dotted key. Key values are never printed: only whether each key's env var is set.

```
etude settings get [key] [flags]
```

*read-only*

| Argument | Description |
| --- | --- |
| `key` (optional) | Dotted key, e.g. ai.feedback.model. |

| Flag | Type | Description |
| --- | --- | --- |
| `--defaults` | boolean | Show the built-in defaults instead. |

```sh
etude settings
etude settings get ai.feedback.model
```

### etude settings set

<a id="settings-set"></a>

Change settings with dotted key=value pairs (JSON values when they parse).

Examples of keys: dayStartHour, learnAheadMinutes, ai.autoFeedback (ai-graded|always|never), ai.language, ai.decision (null disables the decision model), ai.decision.model, ai.feedback.model, ai.feedback.url, ai.feedback.apiKeyEnv, ai.vision. API keys themselves live in the environment or $ETUDE_HOME/.env, never in settings.

```
etude settings set <pairs...> [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `pairs...` | key=value pairs. |

| Flag | Type | Description |
| --- | --- | --- |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { changed: { key: { from, to } }, settings }

```sh
etude settings set dayStartHour=4
etude settings set ai.feedback.model=deepseek/deepseek-v4.1-flash-1017
etude settings set ai.decision=null
```

### etude settings unset

<a id="settings-unset"></a>

Reset dotted keys to their defaults.

```
etude settings unset <keys...> [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `keys...` | Dotted keys. |

| Flag | Type | Description |
| --- | --- | --- |
| `--dry-run` | boolean | Show what would change without writing anything. |

```sh
etude settings unset ai.feedback.model dayStartHour
```

### etude settings test-ai

<a id="settings-test-ai"></a>

Grade a fixed sample answer with the configured providers, to check keys and models. Costs a fraction of a cent.

```
etude settings test-ai
```

*read-only*

Output: { verdict?, verdictError?, feedback?, feedbackError? }

### etude settings chatgpt login

<a id="settings-chatgpt-login"></a>

Sign in with ChatGPT, so grading uses the user's ChatGPT Plus or Pro plan instead of an API key.

Opens OpenAI's sign-in page in the system browser and waits for the loopback callback on 127.0.0.1. The browser must run on this machine: a 127.0.0.1 callback never reaches a server on another host. Tokens are saved to $ETUDE_HOME/chatgpt.json with owner-only permissions.

```
etude settings chatgpt login [flags]
```

*writes · no database*

| Flag | Type | Description |
| --- | --- | --- |
| `--no-open` | boolean | Don't launch a browser; the URL is printed instead. |
| `--timeout <N>` | number | Seconds to wait for the callback. Default 600. |

Output: { signedIn, email, plan, clientId, hostId, credentialsPath, opened }

```sh
etude settings chatgpt login
etude settings chatgpt login --no-open
```

### etude settings chatgpt status

<a id="settings-chatgpt-status"></a>

Whether this install is signed in with ChatGPT, for which account, and whether plan usage is granted.

```
etude settings chatgpt status
```

*read-only · no database*

Output: { signedIn, email, plan, planType, expiresAt, needsReauth, usageUrl, credentialsPath, hostId }

```sh
etude settings chatgpt status
```

### etude settings chatgpt logout

<a id="settings-chatgpt-logout"></a>

End the ChatGPT session and delete the saved tokens. The app registration is kept for a later sign-in.

```
etude settings chatgpt logout
```

*writes · no database*

Output: { signedIn: false, revoked, warning?, email, clientId, hostId, credentialsPath }

```sh
etude settings chatgpt logout
```

### etude settings chatgpt models

<a id="settings-chatgpt-models"></a>

The models the signed-in ChatGPT account offers for plan usage (slug and display name).

```
etude settings chatgpt models
```

*read-only · no database*

Output: { models: [{ slug, displayName }] }

```sh
etude settings chatgpt models
```

### etude settings chatgpt import

<a id="settings-chatgpt-import"></a>

Adopt a chatgpt.json signed in on another machine (the self-hosted-VM path). This host gets its own host id.

```
etude settings chatgpt import <file>
```

*writes · no database*

| Argument | Description |
| --- | --- |
| `file` | The credential file copied from the other machine. |

Output: { signedIn, email, hostId, credentialsPath, plan }

```sh
scp laptop:~/.etude/chatgpt.json /tmp/ && etude settings chatgpt import /tmp/chatgpt.json
```

## theme

Themes: pick the app's colors, or make your own with CSS variables and extra CSS.

### etude theme list

<a id="theme-list"></a>

Every theme, built-in first, with which one is selected.

```
etude theme list
```

*read-only*

Output: array of { id, name, scheme, builtin, selected, accent, background, css (length of extra CSS) }

### etude theme show

<a id="theme-show"></a>

A theme's variables and extra CSS. Without an id, the selected theme.

```
etude theme show [id] [flags]
```

*read-only*

| Argument | Description |
| --- | --- |
| `id` (optional) | Theme id. |

| Flag | Type | Description |
| --- | --- | --- |
| `--css` | boolean | Print the compiled stylesheet as text instead of JSON. |

Output: { id, name, scheme, vars, css?, base?, builtin, selected }, or CSS text with --css

```sh
etude theme show
etude theme show paper
etude theme show my-theme --css
```

### etude theme set

<a id="theme-set"></a>

Use a theme in the app (every device; open pages pick it up on their next load).

```
etude theme set <id> [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `id` | Theme id (see `etude theme list`). |

| Flag | Type | Description |
| --- | --- | --- |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { selected, theme: { id, name, scheme } }

```sh
etude theme set paper
etude theme set midnight
```

### etude theme create

<a id="theme-create"></a>

Make a custom theme from an existing one, changing variables and adding CSS.

Starts from --from (default: the selected theme) and applies --var pairs and --css on top. Variables: --background, --card, --popover, --muted, --secondary, --accent, --foreground, --card-foreground, --popover-foreground, --muted-foreground, --secondary-foreground, --accent-foreground, --primary, --primary-foreground, --border, --input, --ring, --destructive, --highlight, --success, --warning, --danger, --again, --hard, --good, --easy, --new, --learn, --review, --chart-1, --chart-2, --chart-3, --chart-4, --chart-5, --sidebar, --sidebar-foreground, --sidebar-accent, --sidebar-accent-foreground, --sidebar-border, --sidebar-primary, --sidebar-primary-foreground, --sidebar-ring, --radius, --font-sans, --font-mono. Any other --name is accepted too and can be used from the extra CSS.

```
etude theme create [id] [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `id` (optional) | Lowercase slug for the new theme. Omit to derive one from --name. |

| Flag | Type | Description |
| --- | --- | --- |
| `--name <VALUE>` | string | Display name. Defaults to the id. |
| `--from <THEME>` | string | Theme to copy. Default: the selected theme. |
| `--var <NAME=VALUE> (repeatable)` | string | Set a CSS variable, name=value (e.g. highlight=oklch(0.7 0.15 200)). The leading -- is optional. |
| `--css <CSS>` | string | Extra CSS rules for the app (`-` reads stdin). Remote @import and url() are removed. |
| `--css-file <PATH>` | string | Read the extra CSS from a file. |
| `--scheme <dark\|light>` | string | Light or dark (sets the browser's color-scheme for form controls and scrollbars). |
| `--use` | boolean | Also select the new theme. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { theme, removed (CSS that was stripped), selected }

```sh
etude theme create ocean --name "Ocean" --from midnight --var highlight="oklch(0.75 0.12 210)" --use
etude theme create big-cards --css-file big.css
```

### etude theme edit

<a id="theme-edit"></a>

Change a custom theme: name, scheme, variables or extra CSS.

```
etude theme edit <id> [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `id` | Custom theme id. |

| Flag | Type | Description |
| --- | --- | --- |
| `--name <VALUE>` | string | New display name. |
| `--var <NAME=VALUE> (repeatable)` | string | Set a CSS variable, name=value (e.g. highlight=oklch(0.7 0.15 200)). The leading -- is optional. |
| `--css <CSS>` | string | Extra CSS rules for the app (`-` reads stdin). Remote @import and url() are removed. |
| `--css-file <PATH>` | string | Read the extra CSS from a file. |
| `--scheme <dark\|light>` | string | Light or dark (sets the browser's color-scheme for form controls and scrollbars). |
| `--unset-var <NAME> (repeatable)` | string | Reset a variable to the value of the theme it was made from. |
| `--rename <ID>` | string | Change the id (keeps it selected if it was). |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { theme, removed, changed: [variable names and fields] }

```sh
etude theme edit ocean --var radius=0.5rem --var "--good=oklch(0.8 0.15 160)"
etude theme edit ocean --css-file ocean.css
etude theme edit ocean --rename deep-ocean
```

### etude theme delete

<a id="theme-delete"></a>

Delete a custom theme. If it was selected, the app goes back to Midnight.

```
etude theme delete <id> [flags]
```

*writes · `--dry-run` · needs `--yes`*

| Argument | Description |
| --- | --- |
| `id` | Custom theme id. |

| Flag | Type | Description |
| --- | --- | --- |
| `--dry-run` | boolean | Show what would change without writing anything. |
| `-y, --yes` | boolean | Confirm a destructive operation. |

Output: { deleted, selected }

```sh
etude theme delete ocean --yes
```

### etude theme export

<a id="theme-export"></a>

Write a theme as JSON to share or back up.

```
etude theme export [id] [flags]
```

*writes*

| Argument | Description |
| --- | --- |
| `id` (optional) | Theme id. Default: the selected theme. |

| Flag | Type | Description |
| --- | --- | --- |
| `-o, --out <FILE>` | string | Write to this file instead of stdout. |
| `--force` | boolean | Overwrite an existing --out file. |

Output: { etudeTheme: 1, id, name, scheme, vars, css? }, or { written, id } with --out

```sh
etude theme export ocean -o ocean.theme.json
etude theme export > current.theme.json
```

### etude theme import

<a id="theme-import"></a>

Add a theme from a JSON file made by `theme export` (or the app's Export).

A theme whose id is taken gets a new id unless --replace is given. Missing variables are filled from Midnight or Daylight, matching the scheme. Remote @import and url() in its CSS are removed.

```
etude theme import <file> [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `file` | Theme file (`-` for stdin). |

| Flag | Type | Description |
| --- | --- | --- |
| `--id <VALUE>` | string | Store it under this id. |
| `--replace` | boolean | Overwrite a custom theme with the same id. |
| `--use` | boolean | Also select it. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { theme, removed, created, selected }

```sh
etude theme import ocean.theme.json --use
cat t.json | etude theme import -
```

## pack

Packs: JSON files with decks, presets, tags, types and items (import, export, check, scaffold).

### etude pack import

<a id="pack-import"></a>

Add or update everything in one or more packs. Idempotent: items match by id and keep their scheduling.

Each pack runs in one transaction: if any item fails, nothing from that pack is written. With --dry-run the import runs and is rolled back, so the report shows exactly what would be created, updated or left unchanged. Run `etude pack check` first for generator and field checks across many seeds.

```
etude pack import <files...> [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `files...` | Pack files; `-` reads one pack from stdin. |

| Flag | Type | Description |
| --- | --- | --- |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: array of { file, presets, decks, types: { created, updated, unchanged }, items: { created, updated, unchanged }, tags, errors }; with --dry-run, { dryRun: true, reports: [that array] }

```sh
etude pack import course.pack.json --dry-run
etude pack import course.pack.json
```

### etude pack export

<a id="pack-export"></a>

Write a pack of the items in a scope, with their decks, presets, tag instructions and custom types. Scheduling is not included.

```
etude pack export [flags]
```

*writes*

| Flag | Type | Description |
| --- | --- | --- |
| `--deck <NAME>` | string | Limit to this deck and its subdecks. |
| `--query <SEARCH>` | string | Limit to cards matching a search (see `Search language`). Also `--q`. |
| `--name <VALUE>` | string | Pack name. |
| `-o, --out <FILE>` | string | Write to this file instead of stdout. |
| `--force` | boolean | Overwrite an existing --out file. |

Output: the pack, or { written, items, decks, types } with --out

```sh
etude pack export --deck "Networks" -o net.pack.json
etude pack export > everything.pack.json
```

### etude pack check

<a id="pack-check"></a>

Validate pack files without a database: structure per type, ids, and every generator over many seeds. Exits 4 on errors.

Custom types defined in the pack are validated too. Items of types that exist only in your collection are accepted with --known-types (or --with-db).

```
etude pack check <files...> [flags]
```

*read-only · no database*

| Argument | Description |
| --- | --- |
| `files...` | Pack files (`-` for stdin). |

| Flag | Type | Description |
| --- | --- | --- |
| `--seeds <N>` | number | Seeds to run each generator with. Default `200`. |
| `--known-types <VALUE> (repeatable)` | string | Type ids that exist outside the pack. |
| `--with-db` | boolean | Also accept every type in the collection. |

Output: { ok, files: [{ file, ok, items, generated, types, errors, warnings }] }

```sh
etude pack check course.pack.json
etude pack check *.pack.json --seeds 1000
```

### etude pack new

<a id="pack-new"></a>

Write a starter pack with one valid item of each built-in type, to edit.

```
etude pack new [file] [flags]
```

*writes · no database*

| Argument | Description |
| --- | --- |
| `file` (optional) | Output file (default: stdout). |

| Flag | Type | Description |
| --- | --- | --- |
| `--name <VALUE>` | string | Pack name. Default `"My pack"`. |
| `--deck <VALUE>` | string | Top deck. Default `"My pack"`. |
| `--prefix <VALUE>` | string | Item id and tag prefix. Default `"mypack"`. |
| `--force` | boolean | Overwrite the file. |

```sh
etude pack new physics.pack.json --deck "Physics" --prefix phys
```

## anki

Anki: bring an .apkg or .colpkg collection in (types, decks, items, cards, media, history).

### etude anki import

<a id="anki-import"></a>

Import an Anki package: card types, presets, decks, items, cards, media and review history.

Item ids come from the note guid, so importing the same package again updates its items instead of duplicating them: progress made in Etude is kept and reviews aren't imported twice. Each notetype becomes a card type (`anki-<name>`), each deck config a preset, and `::` in deck and tag names keeps its hierarchy. Imported cards keep Anki's due dates and FSRS memory state. With --dry-run the report says what would change and nothing is written. Filtered decks are skipped and their cards land in their home deck.

```
etude anki import <file> [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `file` | An .apkg or .colpkg exported by Anki (legacy or current format). |

| Flag | Type | Description |
| --- | --- | --- |
| `--no-scheduling` | boolean | Content only: every card starts new, with no review history or due dates. |
| `--deck-prefix <DECK>` | string | Nest every imported deck under this one. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { format, dryRun, scheduling, types: { created, updated, unchanged }, presets: { created, updated, unchanged }, decks, items: { created, updated, unchanged }, cards, reviews, read: { notes, cards, reviews }, media: { files, bytes }, skipped: [{ what, name, reason }] }

```sh
etude anki import spanish.apkg --dry-run
etude anki import spanish.apkg
etude anki import backlog.colpkg --deck-prefix "Anki"
```

## media

Media copied into the collection's own folder.

### etude media path

<a id="media-path"></a>

Show the collection's media folder.

```
etude media path
```

*read-only*

Output: { path }

```sh
etude media path
```

### etude media add

<a id="media-add"></a>

Copy an image, audio or video file into the collection's media folder.

The original stays intact. Identical files share a copy. Files may be up to 100 MiB. Insert the returned URL into a card field; the card then works even if the original is moved or deleted.

```
etude media add <file> [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `file` | Local path or file:// URL. |

| Flag | Type | Description |
| --- | --- | --- |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { name, file, path, url, mime, kind, bytes, created, dryRun }

```sh
etude media add ~/Pictures/diagram.png
etude media add ./pronunciation.mp3 --dry-run
```

## market

Market: browse, install and publish shared themes, decks and card types.

### etude market list

<a id="market-list"></a>

Entries in the market, newest first, with whether each is installed here.

```
etude market list [flags]
```

*read-only*

| Flag | Type | Description |
| --- | --- | --- |
| `--kind <theme\|deck\|type>` | string | theme, deck or type. |
| `--query <WORDS>` | string | Only entries whose name, description, author or tags contain these words. Also `--q`. |
| `--refresh` | boolean | Skip the one-minute cache of the index. |
| `--url <URL>` | string | Read the market from this URL or folder instead of the configured one (`settings set market.url=…`). |

Output: array of { id, kind, name, description, author, tags, version, updated, bytes, installed: installed|update|null }

```sh
etude market list
etude market list --kind theme
etude market list -q "japanese"
```

### etude market show

<a id="market-show"></a>

One entry: its details from the index and what it contains.

```
etude market show <id> [flags]
```

*read-only*

| Argument | Description |
| --- | --- |
| `id` | Entry id. |

| Flag | Type | Description |
| --- | --- | --- |
| `--kind <theme\|deck\|type>` | string | theme, deck or type. |
| `--url <URL>` | string | Read the market from this URL or folder instead of the configured one (`settings set market.url=…`). |
| `--content` | boolean | Download the entry and print the whole file. |

Output: { id, kind, name, …, summary, installed } or the entry file with --content

```sh
etude market show dusk-rose
etude market show morse-code --content
```

### etude market install

<a id="market-install"></a>

Add an entry to your collection. Installing again updates it; decks keep your scheduling.

A theme becomes a custom theme (it gets a new id if yours already uses the published one). A deck or card type is imported as a pack: items match by id, so reinstalling updates content and keeps review history. With --file, installs a local entry file instead of one from the market.

```
etude market install [id] [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `id` (optional) | Entry id (omit with --file). |

| Flag | Type | Description |
| --- | --- | --- |
| `--kind <theme\|deck\|type>` | string | theme, deck or type. |
| `--url <URL>` | string | Read the market from this URL or folder instead of the configured one (`settings set market.url=…`). |
| `--file <FILE>` | string | Install this entry file (`-` for stdin). |
| `--use` | boolean | Themes: also select it. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { entry, result: created|updated|unchanged, ids, dryRun, report }

```sh
etude market install dusk-rose --use
etude market install morse-code --dry-run
etude market install --file my-deck.json
```

### etude market installed

<a id="market-installed"></a>

What you installed from the market, with what each put in your collection.

```
etude market installed
```

*read-only*

Output: array of { id, kind, name, version, updated, at, ids }

### etude market forget

<a id="market-forget"></a>

Stop tracking an installed entry. What it added stays in your collection; delete that with `theme delete`, `deck delete` or `type delete`.

```
etude market forget <id>
```

*writes*

| Argument | Description |
| --- | --- |
| `id` | Entry id. |

Output: { forgot: id }

### etude market publish

<a id="market-publish"></a>

Share a theme, deck or card type: opens a pull request on the market repository with your GitHub account.

Needs the GitHub CLI signed in (`gh auth login`). Etude forks the market repository if you can't push to it, adds the entry file on a new branch and opens a pull request; it shows up for everyone once it's merged. Decks are shared without your review history. With -o the entry file is written and nothing is sent. --dry-run builds and checks the file and prints where it would go.

```
etude market publish <ref> [flags]
```

*writes · `--dry-run`*

| Argument | Description |
| --- | --- |
| `ref` | Theme id, deck name, or type id in your collection. |

| Flag | Type | Description |
| --- | --- | --- |
| `--kind <theme\|deck\|type>` | string | theme, deck or type. |
| `--id <SLUG>` | string | Entry id in the market (default: from the name). |
| `--name <TEXT>` | string | Name shown in the market (default: the theme's, deck's or type's). |
| `--description <TEXT>` | string | A few lines on what it is and who it's for. |
| `--author <NAME>` | string | How you want to be credited. Default: your GitHub login. |
| `--tag <TAG> (repeatable)` | string | A tag (repeatable). |
| `--version <TEXT>` | string | Version label; bump it when you publish an update. |
| `--examples <N>` | number | Card types: how many of your items of the type go along as examples. Default `3`. |
| `-o, --out <FILE>` | string | Write the entry file here instead of publishing. |
| `--force` | boolean | Overwrite an existing --out file. |
| `--dry-run` | boolean | Show what would change without writing anything. |

Output: { url, number, branch, repo, fork, path, updated } or { written } with --out, or { dryRun, path, bytes, entry, manualUrl }

```sh
etude market publish my-theme --kind theme --tag dark
etude market publish "Japanese::Kana" --kind deck --description "All 92 kana, both ways"
etude market publish morse --kind type -o morse.json
```

### etude market check

<a id="market-check"></a>

Validate market entry files without a database. Exits 4 on problems.

```
etude market check <files...>
```

*read-only · no database*

| Argument | Description |
| --- | --- |
| `files...` | Entry files. |

Output: { ok, files: [{ file, ok, errors }] }

```sh
etude market check entries/themes/*.json
```

### etude market index

<a id="market-index"></a>

For the market repository: check every file under entries/ (each deck and type is dry-run imported) and write index.json.

```
etude market index <dir> [flags]
```

*writes · no database*

| Argument | Description |
| --- | --- |
| `dir` | The market repository checkout. |

| Flag | Type | Description |
| --- | --- | --- |
| `--repo <OWNER/NAME>` | string | owner/name recorded in the index. |
| `--check` | boolean | Only check; don't write index.json. |

Output: { ok, entries, problems: [{ path, errors }], written? }

```sh
etude market index .
etude market index . --check
```

## db

The database file: path, backups, integrity, schema version.

### etude db path

<a id="db-path"></a>

Which database and media directory the CLI uses, and how it was chosen.

```
etude db path
```

*read-only · no database*

Output: { db, exists, bytes, mediaDir, source: flag|ETUDE_DB|ETUDE_HOME|default, home }

### etude db backup

<a id="db-backup"></a>

Copy the database consistently (SQLite online backup; safe while the server runs).

Default destination: <db dir>/backups/etude-<timestamp>.db. Files under media/ are not copied; back up the media folder too to keep pasted media, imports and drawings.

```
etude db backup [dest] [flags]
```

*writes*

| Argument | Description |
| --- | --- |
| `dest` (optional) | Destination file or directory. |

| Flag | Type | Description |
| --- | --- | --- |
| `--force` | boolean | Overwrite an existing file. |

Output: { backup, bytes, pages }

```sh
etude db backup
etude db backup ~/backups/etude-before-cleanup.db
```

### etude db check

<a id="db-check"></a>

Run SQLite's integrity and foreign-key checks. Exits 4 when something is wrong.

```
etude db check
```

*read-only*

Output: { ok, integrity: [...], foreignKeys: [...], counts }

### etude db info

<a id="db-info"></a>

Schema version, SQLite version, journal mode, sizes and row counts.

```
etude db info
```

*read-only*

Output: { path, schemaVersion, sqlite, journalMode, bytes, counts }

### etude db restore

<a id="db-restore"></a>

Replace the database with a backup. The current file is backed up first. Stop the server before restoring.

```
etude db restore <backup> [flags]
```

*writes · needs `--yes` · no database*

| Argument | Description |
| --- | --- |
| `backup` | Backup file. |

| Flag | Type | Description |
| --- | --- | --- |
| `-y, --yes` | boolean | Confirm a destructive operation. |

Output: { restored, previous }

```sh
etude db restore ~/.etude/backups/etude-20261020-190000.db --yes
```

## Top-level commands

### etude serve

<a id="serve"></a>

Run the web app and HTTP API.

The CLI doesn't need the server: every command opens the database directly, and SQLite's WAL mode lets both run at once.

```
etude serve [flags]
```

*read-only*

| Flag | Type | Description |
| --- | --- | --- |
| `--port <N>` | number | Port. Default $ETUDE_PORT or 4610. |
| `--host <VALUE>` | string | Interface. Default $ETUDE_HOST or 127.0.0.1. Anything beyond localhost needs --token. |
| `--token <VALUE>` | string | Require this bearer token on the API. Default $ETUDE_TOKEN. |
| `--web <DIR>` | string | Serve another web build directory. |
| `--dev` | boolean | API only (Vite serves the web app). |

```sh
etude serve
etude serve --host 0.0.0.0 --token $(openssl rand -hex 16)
```

### etude update

<a id="update"></a>

Update this copy of Etude from its GitHub repo: fetch, fast-forward, install dependencies, rebuild the web app.

Only works in a git checkout with no local changes. A running server keeps the old code until it restarts; the Update button in the app restarts it for you. Package installs (npm, the Mac app) get the latest release's version and a link instead.

```
etude update [flags]
```

*writes · no database*

| Flag | Type | Description |
| --- | --- | --- |
| `--check` | boolean | Only check for new commits; change nothing. |

Output: --check: { kind: git|package, version, commit, behind, incoming: [{ sha, date, subject }], blocked? } · otherwise { result: updated|current, from, to, commits, steps }

```sh
etude update --check
etude update
```

### etude search

<a id="search"></a>

Find cards with the search language (one row per card). Same as `etude card list`.

```
etude search [query...] [flags]
```

*read-only*

| Argument | Description |
| --- | --- |
| `query...` (optional) | Search; words are joined. |

| Flag | Type | Description |
| --- | --- | --- |
| `--order <added\|due\|deck\|lapses\|difficulty\|updated>` | string | Sort order. Default `"added"`. |
| `--limit <N>` | number | Maximum rows to return. Default `50`. |
| `--offset <N>` | number | Rows to skip (for paging). Default `0`. |

Output: { total, rows: [...] }

```sh
etude search deck:"Networks" is:due
etude search "tag:delay prop:lapses>=2" --order lapses
```

### etude commands

<a id="commands"></a>

The catalog of every command: args, flags with types and defaults, examples, whether it writes. JSON for agents.

```
etude commands [filter] [flags]
```

*read-only · no database*

| Argument | Description |
| --- | --- |
| `filter` (optional) | Only commands whose name starts with this (e.g. `card`). |

| Flag | Type | Description |
| --- | --- | --- |
| `--names` | boolean | Only the command names, one per line. |

Output: { etude: "cli/1", version, usage, globalFlags, exitCodes, groups, commands: [{ name, summary, args, flags, examples, writes, dryRun, confirm }] }

```sh
etude commands
etude commands study
etude commands --names
```

### etude version

<a id="version"></a>

Print the Etude version.

```
etude version
```

*read-only · no database*

## Other spellings

Kept so older scripts keep working. Each takes the same arguments and flags as its target.

| Command | Same as |
| --- | --- |
| `etude item search` | [`etude item list`](#item-list) |
| `etude show` | [`etude item show`](#item-show) |
| `etude reschedule` | [`etude card reschedule`](#card-reschedule) |
| `etude type create` | [`etude type import`](#type-import) |
| `etude type update` | [`etude type import`](#type-import) |
| `etude types` | [`etude type list`](#type-list) |
| `etude type-export` | [`etude type export`](#type-export) |
| `etude type-import` | [`etude type import`](#type-import) |
| `etude next` | [`etude study next`](#study-next) |
| `etude stats show` | [`etude stats overview`](#stats-overview) |
| `etude import` | [`etude pack import`](#pack-import) |
| `etude export` | [`etude pack export`](#pack-export) |
| `etude decks` | [`etude deck list`](#deck-list) |
