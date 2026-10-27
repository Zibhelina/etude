# Card types

A card type decides what a card looks like, what the learner does on it and how the answer is scored. The built-in types (`types/*/`) are written in exactly the format described here, so any of them can be copied, edited or reset from the Card types page, or with `etude type-export` / `etude type-import`.

A type has five parts, plus optional asset files:

- **fields**: the schema of the content an item stores.
- **template**: HTML, CSS and JavaScript that run in the card's sandboxed frame.
- **prepare** (optional): a server-side script that turns fields into what the card shows (`view`) and what grading needs (`key`).
- **grader**: `self`, `script`, `ai` or `hybrid`.
- **instructions** (optional): default guidance for the AI grader.
- **assets** (optional): files shipped once with the type (meshes, data, images) that its cards load at runtime. See [Assets](#assets).

## Shape

This is the JSON that `PUT /api/types/:id` accepts and the editor exports:

```json
{
  "id": "true-or-false",
  "name": "True or false",
  "description": "Judge a claim true or false.",
  "faces": ["main"],
  "fields": [
    { "name": "claim", "kind": "markdown", "required": true },
    { "name": "answer", "kind": "boolean", "required": true, "private": true }
  ],
  "titleField": "claim",
  "prepare": "return { view: {...}, key: {...} };",
  "template": { "html": "...", "css": "...", "js": "..." },
  "grader": { "kind": "script", "code": "return { score: 1 };" },
  "instructions": "Optional AI grading guidance.",
  "assets": { "hello.json": "eyJoZWxsbyI6IndvcmxkIn0=" }
}
```

- `id`: lowercase slug, `^[a-z0-9][a-z0-9-]{0,63}$`. Items refer to the type by id, so it doesn't change once items use it.
- `name` is required. `description` is shown in the type list and when adding a card.
- `faces`: optional list of simple names (`[\w-]+`). Each face becomes its own scheduled card from the same item (for example `forward` and `reverse`). Without `faces`, every item makes one card called `main`. Adding a face to a type that already has items creates the missing cards on save. Removing one leaves the existing cards: see leftover cards under `facesWhen`.
- `facesWhen` (optional): the body of `function (fields)` returning the faces this item has. It decides which cards an item gets, so a cloze import can leave out `c3` for a note with two clozes, and an optional reverse can leave out its second template when the field that drives it is empty. The script is authoritative for the item, so it can also name a face that isn't in `faces` yet. Saving a type only ever adds cards: a card that already exists is kept even if the item stops qualifying, so history isn't lost by accident. Such leftover cards still come up in study unless suspended. A save that leaves new ones makes the type editor ask whether to delete them, and Settings → Clean up or `etude card prune --type <id>` deletes them later. To look at them first, search Browse (or `etude card list`) for `is:leftover`, narrowed with `type:` and `face:`. An item keeps every card when its `facesWhen` fails or would leave it without one, and archived items are left alone.
- `fields[]`:
  - `name` is an identifier (`^[A-Za-z_]\w*$`) and must be unique.
  - `kind` is one of `markdown | text | number | boolean | list | json | code | html`. `html` holds raw HTML (Anki imports use it) and is edited as plain source.
  - `label` and `description` only matter to editors.
  - `required` fields must be non-empty when an item is saved.
  - A `private` field is hidden until the answer is graded.
  - `default` is merged in when an item leaves the field empty.
  - `editor` asks for a structured form: `choices` (`[{ text, correct, why }]`), `pairs` (`[[left, right]]`), `parts` (`[{ label, answer, unit, tolerance }]`) or `occlusion` (`[{ id, x, y, w, h, label, group }]`, drawn on the image in the sibling `image` field; see [Image occlusion](#image-occlusion)).
  - `language` (for `code` fields) is the language the editor highlights: a name (`"python"`) or `"field:<name>"` to follow another field, like the `code` type's `language`.
  - In the item editor, `markdown` fields are live markdown editors and `code` fields are code editors.
- `skills` and `variants` (optional): see [Adaptive decks](#adaptive-decks).
- `titleField` (optional) names the `markdown`, `text`, `html` or `code` field that labels an item in Browse, search results and Stats, and what search ranks first. Without it, the label is the first non-private markdown field, then the first other non-private text field, in the order the type lists them. Fields with a `default` are settings (a mode, a language) and are never picked automatically. A private title field is used in those lists only: anything sent with a card being studied falls back to the automatic label. In the type editor it's **List title** on the Info tab.
- `template.html` is required; `css` and `js` may be empty.

Saving validates all of this. Script bodies (`prepare`, `grader.code`) are compiled in the sandbox and `template.js` is compiled as a function, so syntax errors come back from the save as messages like `true-or-false/grade: SyntaxError: ...`.

### Directory form

`etude type-export <id> -o dir` writes, and `etude type-import <dir|type.json>` reads, a directory:

| file | holds |
|---|---|
| `type.json` | everything except the code below (`grader` keeps its `kind`, `vision`, `instructions`) |
| `template.html` | `template.html` |
| `style.css` | `template.css` |
| `card.js` | `template.js` |
| `prepare.js` | `prepare` |
| `grade.js` | `grader.code` (only read for `script` and `hybrid` graders) |
| `demo.js` | `demo` (an example answer for watch mode, optional) |
| `assets/<name>` | one entry of `assets` per file (the raw bytes, optional) |

Files win over the same keys inside `type.json`. The built-in types in `types/` use this form.

### Built-in, edited and custom

Built-in types are loaded from `types/` at startup and kept up to date with the shipped files. Saving a built-in makes it the user's own version: the stored row is marked `builtin = 0`, later Etude updates leave it alone, and `GET /api/types` reports it with `edited: true`. `POST /api/types/:id/reset` (Reset to shipped version) restores the shipped files. Custom types can be deleted; built-ins can't. When items use the type (archived ones count), deleting it deletes them too, with their cards and review history, after a confirmation that offers to view them first (`etude type delete <id> --items` in the CLI).

## Template syntax

The HTML is expanded with the card's `view` (see Prepare) before the card script runs. Dotted paths work (`{{part.label}}`).

| syntax | result |
|---|---|
| `{{field}}` | the value, HTML-escaped |
| `{{md:field}}` | markdown (GitHub flavour) with KaTeX math (`$inline$`, `$$display$$`, `\(...\)`, `\[...\]`), as blocks |
| `{{mdi:field}}` | the same, inline (no surrounding `<p>`) |
| `{{#field}}...{{/field}}` | kept only when the field is set: not null, `""`, `false` or an empty list |
| `<template data-on="result">...</template>` | left out until the answer is graded, then expanded with the view, the `key` merged over it, and `grade` |

The body gets `data-mode="answer"` or `data-mode="result"`, so `.only-answer` and `.only-result` hide content in the other mode. When the app shows the key without grading (Show answer in Browse and the type editor), the body also gets `data-preview="1"`, and `.is-wrong` marks are neutralised.

## The card script

`template.js` is the body of an `async function (etude)` that runs inside the frame after the HTML is in place. If it throws, the error is printed in the card and reported to the app.

| member | |
|---|---|
| `etude.view` | what prepare put in `view` (or every non-private field) |
| `etude.mode` | `"answer"`, `"result"` or `"preview"` |
| `etude.answer` | a previous answer when the card is re-shown, else `null` |
| `etude.result` | `{ grade, key, answer }` once graded, else `null` |
| `etude.root` | the `#card` element |
| `etude.asset(name)` | absolute URL of one of the type's [assets](#assets), for `fetch()`, `<img src>` and the like; throws for an unknown name |
| `etude.assets` | the names of the type's assets |
| `etude.md(s)`, `etude.mdInline(s)` | render markdown and math to HTML (fenced code blocks are highlighted automatically) |
| `etude.tex(src, display?)` | render LaTeX to HTML |
| `etude.math` | math answers: `parse`, `toLatex`, `evaluate`, `equivalent`, `check` (the same module as `std.math`, so a live preview and the grader agree) |
| `await etude.highlight(code, language)` | syntax-highlighted HTML for any language CodeMirror knows (about 140; `python`, `js`, `c++`, `rust`, `sql`, ...) |
| `await etude.languageName(id)` | display name of a language id (`"py"` → `"Python"`) |
| `await etude.codeEditor(el, opts)` | a code editor in `el`; `opts`: `value`, `language`, `placeholder`, `readOnly`, `minLines`, `wrap`, `autofocus`, `onChange(v)`. Returns `{ value(), set(v), focus(), setReadOnly(b), destroy() }` |
| `await etude.markdownEditor(el, opts)` | a markdown editor with live preview, like Obsidian: formatting, `$math$`, `$$display$$` and code render in place and the markup comes back where the cursor is. Same options and handle as `codeEditor` |
| `etude.escape(s)` | HTML-escape text |
| `etude.html\`...\`` | tagged template that escapes interpolated values |
| `etude.$(sel)`, `etude.$$(sel)` | `querySelector` / `querySelectorAll` (as an array) inside the card |
| `etude.getAnswer(fn)` | how to read the answer when the app's Submit is pressed; `fn()` returns any JSON value |
| `etude.submit(value?)` | submit now, with `value` or `getAnswer()`'s result; ignored outside answer mode or after the first submit |
| `etude.setReady(bool)` | enable or disable the app's Submit button (enabled by default) |
| `etude.onResult(fn)` | called with `{ grade, key, answer }` after grading; called at once if the card is already graded |

`grade.details` is whatever the grade script returned as `details`. Use it to mark parts, options or blanks.

A small `std.normalize(s)` is also in scope in card scripts. The full `std` (below) is only available to server scripts.

### Keyboard and sizing

- Ctrl/Cmd+Enter always goes to the app (submit or reveal).
- Escape goes to the app. Ctrl/Cmd+Z undoes the last rating in result mode or when focus is outside an answer field; inside an answer field it keeps its normal text-undo behavior. Undo also works after advancing to the next card. In answer mode a card can keep Ctrl/Cmd+Z for its own undo handler with `preventDefault()`.
- In answer mode, Space, Enter, `u`, `=`, `-`, `!` and `@` go to the app only when the card's own handler didn't call `preventDefault()` and focus isn't in an input. In result mode, 1–4 and the same keys are forwarded the same way, for rating, undo, burying (`=` the note, `-` the card) and suspending (`!` the note, `@` the card), as in Anki.
- On mount, focus goes to the first usable `[autofocus]` target, otherwise the first visible, enabled typing field (input, textarea or contenteditable editor). Buttons are a fallback for cards without a typing field.
- The frame resizes to the card's height automatically. Don't use fixed heights or internal scrolling for the whole card.

### Editors and code

The editor kit loads the first time a card asks for it, and each language loads only when it's needed. `runtime/code.css` colors highlighted code from the theme (`--code-keyword`, `--code-string`, `--code-number`, `--code-function`, `--code-type`, `--code-comment`, `--code-punct`, all derived from the theme's colors), and `.e-editor` gives an editor the same box as `.e-input` (`.is-readonly` after grading). The built-in `code`, `math` and `free` types are short examples of all three.

### Theme and ready-made styles

The app posts its theme into the frame, and posts it again when the user switches themes. Use the CSS variables `--background`, `--foreground`, `--card`, `--card-foreground`, `--popover`, `--popover-foreground`, `--muted`, `--muted-foreground`, `--secondary`, `--secondary-foreground`, `--border`, `--input`, `--primary`, `--primary-foreground`, `--accent`, `--accent-foreground`, `--ring`, `--destructive`, `--success`, `--warning`, `--danger`, `--highlight`, the rating colors `--again`, `--hard`, `--good`, `--easy`, the state colors `--new`, `--learn`, `--review`, `--radius`, `--font-sans` and `--font-mono`. Themes can be light or dark (the frame's `color-scheme` follows), so derive tints from these variables (`color-mix(in oklab, var(--foreground) 8%, transparent)`) instead of hard-coding white or black.

`runtime/card.css` provides:

- **Layout:** `#card` is a column with a 1.25rem gap.
- **Text:**
  - `.prose` for rendered markdown, including code, tables and KaTeX.
  - `.e-muted`, `.e-label`, `.e-section-title`.
- **Layout helpers:** `.e-row`, `.e-stack`.
- **Inputs:**
  - `.e-input` and `.e-textarea`, with `.mono` for monospace.
  - `.e-unit` for a unit shown beside an input.
- **Controls:**
  - `.e-option`, a choice button. `aria-pressed="true"` or `.is-selected` marks it chosen, and `.e-key` is its key badge.
  - `.e-btn` and `.e-btn.primary`.
- **Grading marks:** `.is-correct`, `.is-wrong`, `.is-missed`, and `.e-why` for explanations.
- **Revealed material:** `.e-reveal` for the block shown after answering, `.e-answer` for an answer box, and `kbd`.

## Assets

A type can ship files its cards need, like a 3D mesh, a lookup table or a set of images, once, instead of copying them into every item. In JSON (`PUT /api/types/:id`, packs, market entries, `etude type export --json`) they are an object of name to base64 of the file's bytes:

```json
"assets": { "skull.bin": "AAECAwQF…", "labels.json": "eyJmcm9udGFs…" }
```

In the directory form they are the files in `assets/`. Names match `^[\w.-]{1,80}$`. One asset can be up to 20 MiB and a type's assets up to 40 MiB together.

A card loads them by name:

```js
const mesh = await (await fetch(etude.asset("skull.bin"))).arrayBuffer();
const labels = await (await fetch(etude.asset("labels.json"))).json();
```

`etude.asset(name)` returns `<server>/type-assets/<type>/<name>?h=<sha256>`. The route answers with CORS for the card's opaque origin, a content type from the extension (`.json`, `.bin` as `application/octet-stream`, images, fonts, `.glb`…), `nosniff` and a sandbox CSP. When `h` matches the stored file it may be cached for a year, so a changed asset gets a new URL and the browser fetches it again.

Assets are stored apart from the definition:

- Saving a type with `assets` replaces its set: names left out are removed, `{}` removes them all.
- Saving without `assets` keeps the stored files. The type editor saves this way, and shows the files read-only under **Info → Assets**.
- `GET /api/types` and `GET /api/types/:id` list `assetFiles` (name, size and, for one type, hash), never the bytes. So does `etude type show`.
- Deleting a type deletes its assets. Built-in types can have them too (`types/<id>/assets/`), and **Reset to shipped version** restores them.

## Prepare

`prepare` is the body of `function (fields, face, rng, learner)` and returns `{ view, key }`. It runs on the server, in the sandbox, before every showing. It may also return `grader: "self"`: that one card is then revealed and rated by the learner even though the type has a script grader (the image occlusion type does this for a box with no label).

- `fields`: the item's fields with defaults merged in and the generator already applied.
- `face`: the name of the face being shown.
- `rng`: seeded from the review seed, the item and the face, so a variant can be replayed exactly.
- `learner`: the learner's estimates on an [adaptive deck](#adaptive-decks), or `null`. It is `null` whenever the deck's Adaptive challenge is off, so every type must work without it.

Only `view` reaches the card before grading. `key` goes to the grader, to `onResult` and to result templates. Without a prepare script, private fields go to `key` and every other field goes to `view`.

## Example answers (watch mode)

A deck in watch mode (`mode: "watch"` in its preset or deck options) is a tour: the app shows its cards one by one, each with a **Show an answer** button that fills in an example answer and grades it like a real one, and nothing is scheduled. The example comes from:

1. the item's own `fields.demo`, when it has one (a drawing's strokes, a proof written a particular way), or
2. the type's `demo` script: the body of `function (view, key, fields, rng)` returning an answer in the shape `getAnswer` produces. It runs in the sandbox like `prepare`, after it, so it sees this variant's key.

A script-graded example is graded on the spot. AI-graded items can ship a recorded grade in `fields.demoGrade` (`{ score, verdict, feedback, grader: { model } }`), so the tour shows a real grade without calling a model; without one, the app says AI would grade it. `demo` and `demoGrade` never reach the card's view. Every built-in and showcase type has a `demo.js`; `etude study watch` prints the same thing for agents.

## Grading

`grader.kind`:

- `self`: no automatic grade. The learner reveals the result and rates their recall.
- `script`: `grader.code` is the body of `function (answer, view, key, fields)` and returns `{ score, details?, feedback? }`.
  - `score` is clamped to 0..1: 1 is correct, 0 is incorrect, anything between is partial.
  - The deck preset's `autoRate` thresholds turn the score into a suggested rating.
  - `score: null` means ungraded.
- `ai`: a decision model returns the verdict, and a language model writes feedback. `vision: true` routes the answer to a vision model; drawings (`{ image: "data:image/png;base64,..." }`) always go there.
- `hybrid`: the script runs first. If it returns `defer: true` or `score: null`, the answer goes to the AI grader. Otherwise the script's score stands.

If a script or AI grader fails, the attempt is kept as ungraded and the learner rates it themselves.

`showVerdict: false` hides "Correct / Not quite" and the grader's feedback after an answer (and skips automatic AI feedback). Use it when the card's own result screen is the answer, like a typing test. The score and details are still recorded. In the type editor it's the **Show the verdict and feedback** switch on the Grader tab.

### What the AI grader reads

- **The prepared view**: what the student was shown, including the variant prepare picked.
- **The card's fields**, each labelled with its `label` or name. Private fields are marked "hidden from the student". Empty fields and `generator` are left out.
- **The answer:** a string as-is, an object with `image` as a picture, anything else as JSON.
- **Instructions, most specific first** (earlier ones win on conflict):
  1. The item's own fields, such as a `rubric` (these arrive as fields).
  2. Instructions on the item's tags, most specific level first (`a::b::c`, then `a::b`, then `a`).
  3. The deck's `instructions`, then its parents'.
  4. The type's `instructions`.

### Sandbox and `std`

Prepare, grade and generator scripts run in QuickJS:

- no network, files, timers or host objects; only JSON goes in and comes out
- 64 MB of memory and a 1 MB stack
- a time limit of 500 ms for prepare and generators, and 1 s for grading
- a runaway script is stopped with "timed out"

Every script gets `std`:

- `std.normalize(s)`: NFKC, lowercase, collapsed whitespace, trailing `.!?;:,` dropped.
- `std.looseEqual(a, b)`: compares the normalized forms.
- `std.parseNumber(s)`: parses `"1.5"`, `"1,5"`, `"3e-3"`, `"1/8"`, `"2*10^3"`, `"(1+2)/4"`; returns `NaN` when it can't.
- `std.within(value, target, tolerance = 0.01)`: relative tolerance, with a 1e-12 floor near zero.
- `std.lis(seq)`: longest increasing subsequence length, used for order partial credit.
- `std.round(x, digits = 3)`: rounds to significant digits.
- `std.math`: math answers in LaTeX or plain notation. `std.math.check(answer, accepted, { form, ordered, tolerance })` returns `{ score, feedback, latex }` (see the `math` type in [packs.md](packs.md)); also `parse`, `evaluate(tree, vars)`, `toLatex`, `equivalent(a, b)`. It is only loaded into scripts that mention `std.math`.

When a script takes `rng`, it provides:

- `rng.int(min, max)` (inclusive) and `rng.float(min, max, decimals = 2)`
- `rng.pick(array)` and `rng.shuffle(array)` (returns a copy)
- `rng.bool(p = 0.5)` and `rng.next()` (uniform in [0, 1))
- `rng.seed`

### Private fields

When a type has no prepare script, private fields go into `key` and are not sent to the card until the answer is graded. With a prepare script, you decide what goes in `view`; the `private` flag then only labels the field for editors and the AI grader. Everything in `view` should be treated as visible to the learner.

## Adaptive decks

A deck with **Adaptive challenge** on (`adaptiveChallenge: true`) hands card types a `learner` argument, so a type can choose which variant of an exercise to show. It's optional twice over: decks have it off by default, and types that ignore `learner` behave exactly as before. With it off, `learner` is `null`, and `etude pack check` runs every type's prepare both ways (and with each goal below), so a type that only works with a learner can't be imported.

Estimates are computed from the rated answers of the highest deck at or above the card's deck with an adaptive setting on, as of the moment the card was shown. Nothing new is stored, so devices that sync the same history agree, and turning adaptation on later uses the history you already have.

```js
{
  asOf: "2026-10-27T16:40:00.000Z",
  goal: "measure",                    // what this answer is for: "teach", "measure" or "practice"
  target: 0.9,                        // for practice: targetSuccess, else the deck's desired retention
  skill: "reading",                   // this face's skill (the type's `skills`, else "general")
  ability: { reading: 0.62, listening: -0.3 },  // logit scale: 0 is an even chance on a middling card
  success: { reading: 0.88 },         // share of the last 50 rated answers that were right
  answers: { reading: 140 },
  level: { reading: { index: 1, tag: "level::2", progress: 0.43, checkPassed: false, done: false, nextOpen: false } } | null,
  card: { state: "review", reps: 6, lapses: 1, stability: 18.2, retrievability: 0.91, scores: [1, 0.5, 1] },
  placement: false,                   // a placement probe
  quickCheck: false,                  // a quick check after a placement
}
```

### Goals: what the answer will be used for

FSRS already sets how hard a review is, through timing: it brings a card back when recall has fallen to the desired retention. A second controller that also moved difficulty at review time (an easier sentence when the learner struggles, a harder one when they don't) would change the question while FSRS reads the outcome as memory, inflating or deflating stability. So the variant should depend on what the answer is for, given in `learner.goal`:

| goal | when | pick |
|---|---|---|
| `teach` | a new card's first showing in normal study | the clearest version: the most `_known`, then the lowest `_difficulty`. A first showing is encoding, not recall, and its answer doesn't feed the skill estimates. |
| `measure` | learning steps, reviews and relapses on a scheduler with a memory model; placement probes; quick checks | a version of the item's usual difficulty, whatever the learner's state: the most `_known`, then the smallest `_offset`, rotating through unseen ones (`_seen`). Vary the context, not the difficulty, so FSRS sees comparable evidence. |
| `practice` | decks whose scheduler has no memory model (drill) | the version closest to `learner.target` (`_p`): adapt the challenge freely, nothing is being measured |

Grade what the card schedules. If a card is about one word, score that word (in its sentence), not every other word around it, or the rating ends up measuring something FSRS doesn't schedule.

### Skills and variants

Two optional parts of the type definition feed `learner`:

- `skills` maps faces to skills: `{ "read": "reading", "listen": "listening", "produce": "writing" }`. Items can add skills with `skill::` tags (`skill::grammar::dative`). Every rated answer moves the learner's ability on its skills and the difficulty of what was shown, Elo-style.
- `variants: { "field": "sentences" }` names a json or list field whose entries are interchangeable versions of the exercise. Each entry may have an `id` (stable, to track its difficulty), `requires` (item ids it relies on, such as the other words in a sentence) and a prior `difficulty` from 0 (easy) to 1 (hard); `variants.id`, `variants.requires` and `variants.difficulty` rename those keys. On an adaptive deck, before prepare runs, each entry gets `_known` (share of its `requires` items the learner knows: one of their cards has graduated to review), `_seen` (times this card showed it), `_difficulty` (its current estimate, 0 to 1, calibrated from answers), `_offset` (`_difficulty` minus the median of the item's variants) and `_p` (predicted success for this learner).

A prepare that picks a variant returns its id as `variant` and may say why in `reason` (a few words, "a sentence you haven't seen"). Both are recorded in the attempt's grade as `adaptive`, with the goal, and the app shows the reason after answering.

```js
const list = fields.sentences;
if (!learner) return show(rng.pick(list));
const best = Math.max(...list.map((s) => s._known));
const pool = list.filter((s) => s._known >= best);
const cost = {
  teach: (s) => s._difficulty,
  measure: (s) => Math.abs(s._offset) + 0.05 * s._seen,
  practice: (s) => Math.abs(s._p - learner.target) + 0.05 * s._seen,
}[learner.goal];
const pick = pool.sort((a, b) => cost(a) - cost(b))[0];
return { ...show(pick), variant: pick.id, reason: learner.goal === "teach" ? "a clear sentence with words you know" : undefined };
```

The app passes the card's `asOf` back when it submits, so grading sees the same estimates and the same variant. Agents using the CLI pass it as `study submit --as-of`. Generators get the same `learner` as their second argument.

### Around it

The deck settings (see the scheduling reference) add three things that only decide which new cards come in, so they don't touch FSRS's evidence. **Adaptive pace** sets each day's new-card limit from how well the last week's young cards held (reviews of cards under 21 days' stability not rated Again, against the desired retention) and the study time. **Levels** (`levels: [{ tag, check? }]`) bring new cards from the learner's level and open the next one gradually. **Placement** (`study next --placement <session>`) finds the learner's level with real reviews, after which earlier cards come up as quick checks. Each session is named; a new name starts a fresh placement, and the latest one is the one that counts. `etude stats skills <deck>` reports all of it.

The two signals keep separate jobs: your **rating** is the memory signal (FSRS, and the pace's young-card retention); the graded **score** is the skill signal (the estimates, placement and variant difficulty).

## Item generators

Any item can set `fields.generator`, the body of `function (rng, learner)` that returns an object of field overrides. It runs before prepare with the review's seed, so each review shows a new variant, and the stored seed replays it. Keep valid static fields next to it so lists and previews have something to show. See [packs.md](packs.md#generated-items).

## Image occlusion

The built-in `occlusion` type covers parts of an image: a diagram, a slide, an atlas page. Each box, or each group of boxes, is its own card. On the card the asked box is pink with a "?", the learner types its name under the image (Enter checks), and after grading the box opens with its name next to it, outlined green or red. Big images zoom with Ctrl + scroll, a pinch or a double-click, and pan by dragging.

| field | kind | |
|---|---|---|
| `image` | text | the image's media URL (`/media/files/…`) |
| `boxes` | json | `[{ "id": "b1", "x": 0.12, "y": 0.3, "w": 0.1, "h": 0.05, "label": "Aorta\|aortic arch", "group": "atria" }]`, coordinates as fractions of the image from 0 to 1 |
| `mode` | text | `hide-all` (default): every box is covered and one is asked. `hide-one`: only the asked box is covered |
| `header` | markdown | shown above the image |
| `extra` | markdown, private | shown after answering |

- **Cards.** `facesWhen` returns one face per box id, or per `group` when boxes share one (asked together, one answer). Adding a box later adds a card; the existing cards keep their history. Removing a box keeps its card, as cards are never deleted: it says the box was removed, so suspend or delete it by hand.
- **Grading.** Case, accents and punctuation don't matter, `|` separates accepted names, and small typos pass: none up to 4 letters, one for 5 to 8, two beyond (Damerau-Levenshtein, so a swapped pair counts once). A name that belongs to another box is never accepted, even when it's within the typo allowance, and the feedback says which part it names. An empty answer means "show me": score 0 and the reveal. In a group, any one of its names is right.
- **Boxes without a label** (an Anki import, or a box you haven't named yet) are revealed and self-graded like a basic card: the card asks you to name the part to yourself, **Show answer** opens it, and you rate yourself. The editor shows how many cards are like this; it doesn't refuse to save.
- **Editor.** The item editor shows the image with the boxes on it. Drop, paste (Ctrl+V a screenshot) or choose an image; drag to draw a box; drag a box to move it and its handles to resize it; Del deletes, Ctrl+D duplicates, arrows nudge (Shift for 10 px), Ctrl+Z / Ctrl+Shift+Z undo and redo, Ctrl+G groups and Ctrl+Shift+G ungroups. Shift-click (or tap the numbers in the list on a phone) selects several. Each box has a label input in the list beside the image (below it on phones); clicking a row selects its box. Zoom with the buttons, Ctrl + scroll or a pinch, and pan with the hand tool, Space-drag or two fingers. The toolbar shows how many cards the item makes.
- **CLI.** `etude occlusion add <image> --deck D --box "x,y,w,h=Label" [--box "x,y,w,h@group=Label"] [--px] [--boxes file.json] [--mode hide-one]` copies the image into media and creates the item; `--px` takes pixel coordinates and converts them with the image's size. `item add --type occlusion --fields …` and `item edit <id> --set boxes='[…]'` work too. API: `POST /api/occlusion` with the same fields.

## Example 1: true or false

A small type with a script grader. It was created and saved through the Card types page and studied once.

```json
{
  "id": "true-or-false",
  "name": "True or false",
  "description": "Judge a claim true or false. Press T or F; checked by script.",
  "fields": [
    { "name": "claim", "kind": "markdown", "required": true },
    { "name": "answer", "kind": "boolean", "required": true, "private": true },
    { "name": "explanation", "kind": "markdown", "private": true }
  ],
  "template": {
    "html": "<div class=\"e-label\">True or false?</div>\n<div class=\"prose claim\">{{md:claim}}</div>\n<div class=\"e-row choices\">\n  <button type=\"button\" class=\"e-option tf\" data-v=\"true\"><span class=\"e-key\">T</span>True</button>\n  <button type=\"button\" class=\"e-option tf\" data-v=\"false\"><span class=\"e-key\">F</span>False</button>\n</div>\n<template data-on=\"result\">\n  <div class=\"e-reveal\">\n    {{#explanation}}<div class=\"prose e-muted\">{{md:explanation}}</div>{{/explanation}}\n  </div>\n</template>\n",
    "css": ".choices { gap: 0.6rem; }\n.tf { width: auto; flex: 1; min-width: 8rem; justify-content: center; align-items: center; }\n.claim { font-size: 1.15rem; }\n",
    "js": "let picked = null;\nconst buttons = etude.$$(\".tf\");\nconst choose = (v) => {\n  picked = v;\n  buttons.forEach((b) => b.setAttribute(\"aria-pressed\", String(b.dataset.v === String(v))));\n  etude.setReady(true);\n};\nbuttons.forEach((b) => b.addEventListener(\"click\", () => choose(b.dataset.v === \"true\")));\nwindow.addEventListener(\"keydown\", (e) => {\n  if (etude.mode !== \"answer\") return;\n  if (e.key === \"t\") choose(true);\n  if (e.key === \"f\") choose(false);\n});\netude.setReady(false);\nif (typeof etude.answer === \"boolean\") choose(etude.answer);\netude.getAnswer(() => picked);\netude.onResult(({ key }) => {\n  buttons.forEach((b) => {\n    b.disabled = true;\n    const v = b.dataset.v === \"true\";\n    if (v === key.answer) b.classList.add(\"is-correct\");\n    else if (v === picked) b.classList.add(\"is-wrong\");\n  });\n});\n"
  },
  "grader": { "kind": "script", "code": "return { score: answer === key.answer ? 1 : 0, feedback: answer === null ? \"No choice made.\" : undefined };\n" }
}
```

There is no prepare script, so `answer` and `explanation`, both private, go to `key`, and the explanation shows up in the result block. Submit stays disabled until a choice is made.

## Example 2: two-way vocabulary (prepare and faces)

This is a vocabulary type (in the format of the types in `examples/showcase/types/`). It was duplicated as `vocabulary-portuguese` and saved through the Card types page. Each item makes two cards, and `prepare` builds a different view and key for each face:

```json
{
  "id": "vocab",
  "name": "Vocabulary (two-way)",
  "faces": ["forward", "reverse"],
  "fields": [
    { "name": "term", "kind": "text", "required": true },
    { "name": "meaning", "kind": "text", "required": true },
    { "name": "alternatives", "kind": "list", "private": true, "description": "Other accepted meanings." },
    { "name": "example", "kind": "markdown", "private": true }
  ],
  "prepare": "const fwd = face === \"forward\";\nreturn {\n  view: { cue: fwd ? fields.term : fields.meaning, direction: fwd ? \"What does it mean?\" : \"What's the word?\" },\n  key: { answers: fwd ? [fields.meaning, ...(fields.alternatives ?? [])] : [fields.term], shown: fwd ? fields.meaning : fields.term, example: fields.example ?? \"\" },\n};",
  "template": {
    "html": "<div class=\"e-label\">{{direction}}</div>\n<div class=\"cue\">{{cue}}</div>\n<input class=\"e-input\" id=\"a\" autocomplete=\"off\" spellcheck=\"false\" placeholder=\"Type it\" autofocus>\n<template data-on=\"result\">\n  <div class=\"e-reveal\">\n    <div class=\"e-answer big\">{{shown}}</div>\n    {{#example}}<div class=\"prose e-muted\">{{md:example}}</div>{{/example}}\n  </div>\n</template>",
    "css": ".cue { font-size: 2rem; font-weight: 600; letter-spacing: -0.01em; margin: -0.5rem 0 0.25rem; }\n.big { font-size: 1.25rem; }",
    "js": "const input = etude.$(\"#a\");\netude.getAnswer(() => input.value);\ninput.addEventListener(\"input\", () => etude.setReady(input.value.trim().length > 0));\netude.setReady(false);\ninput.addEventListener(\"keydown\", (e) => { if (e.key === \"Enter\") { e.preventDefault(); etude.submit(); } });\netude.onResult(({ grade }) => { input.disabled = true; input.classList.add(grade.score >= 1 ? \"is-correct\" : \"is-wrong\"); });"
  },
  "grader": { "kind": "script", "code": "return { score: key.answers.some((a) => std.looseEqual(answer, a)) ? 1 : 0 };" }
}
```

The answer never reaches the card. `prepare` puts it in `key`, and `{{shown}}` appears only in the result block.

## Security

Cards run in an iframe with `sandbox="allow-scripts"` and no same-origin access, so a card's code can't read the app, its storage or the API. The only channel is `postMessage` with the app, which accepts a fixed set of messages (submit, ready state, size, keys, errors). Server-side scripts run in QuickJS with no I/O and with memory and time caps.
