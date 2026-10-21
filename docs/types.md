# Card types

A card type decides what a card looks like, what the learner does on it and how the answer is scored. The built-in types (`types/*/`) are written in exactly the format described here, so any of them can be copied, edited or reset from the Card types page, or with `etude type-export` / `etude type-import`.

A type has five parts:

- **fields**: the schema of the content an item stores.
- **template**: HTML, CSS and JavaScript that run in the card's sandboxed frame.
- **prepare** (optional): a server-side script that turns fields into what the card shows (`view`) and what grading needs (`key`).
- **grader**: `self`, `script`, `ai` or `hybrid`.
- **instructions** (optional): default guidance for the AI grader.

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
  "prepare": "return { view: {...}, key: {...} };",
  "template": { "html": "...", "css": "...", "js": "..." },
  "grader": { "kind": "script", "code": "return { score: 1 };" },
  "instructions": "Optional AI grading guidance."
}
```

- `id`: lowercase slug, `^[a-z0-9][a-z0-9-]{0,63}$`. Items refer to the type by id, so it doesn't change once items use it.
- `name` is required. `description` is shown in the type list and when adding a card.
- `faces`: optional list of simple names (`[\w-]+`). Each face becomes its own scheduled card from the same item (for example `forward` and `reverse`). Without `faces`, every item makes one card called `main`. Adding a face to a type that already has items creates the missing cards on save.
- `fields[]`:
  - `name` is an identifier (`^[A-Za-z_]\w*$`) and must be unique.
  - `kind` is one of `markdown | text | number | boolean | list | json | code`.
  - `label` and `description` only matter to editors.
  - `required` fields must be non-empty when an item is saved.
  - A `private` field is hidden until the answer is graded.
  - `default` is merged in when an item leaves the field empty.
  - `editor` asks for a structured form: `choices` (`[{ text, correct, why }]`), `pairs` (`[[left, right]]`) or `parts` (`[{ label, answer, unit, tolerance }]`).
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

Files win over the same keys inside `type.json`. The built-in types in `types/` use this form.

### Built-in, edited and custom

Built-in types are loaded from `types/` at startup and kept up to date with the shipped files. Saving a built-in makes it the user's own version: the stored row is marked `builtin = 0`, later Etude updates leave it alone, and `GET /api/types` reports it with `edited: true`. `POST /api/types/:id/reset` (Reset to shipped version) restores the shipped files. Custom types can be deleted when no items use them; built-ins can't be deleted.

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
| `etude.md(s)`, `etude.mdInline(s)` | render markdown and math to HTML |
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
- Escape goes to the app, and so does Ctrl/Cmd+Z in result mode (undo).
- In answer mode, Space and Enter go to the app only when the card's own handler didn't call `preventDefault()` and focus isn't in an input. In result mode, 1–4, Space, Enter and `u` are forwarded the same way, for rating.
- On mount, the first `[autofocus]` element (or input or textarea) gets focus.
- The frame resizes to the card's height automatically. Don't use fixed heights or internal scrolling for the whole card.

### Theme and ready-made styles

The app posts its theme into the frame. Use the CSS variables `--background`, `--foreground`, `--card`, `--muted`, `--muted-foreground`, `--border`, `--input`, `--primary`, `--primary-foreground`, `--accent`, `--ring`, `--success`, `--warning`, `--danger`, `--highlight`, `--radius`, `--font-sans` and `--font-mono`.

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

## Prepare

`prepare` is the body of `function (fields, face, rng)` and returns `{ view, key }`. It runs on the server, in the sandbox, before every showing.

- `fields`: the item's fields with defaults merged in and the generator already applied.
- `face`: the name of the face being shown.
- `rng`: seeded from the review seed, the item and the face, so a variant can be replayed exactly.

Only `view` reaches the card before grading. `key` goes to the grader, to `onResult` and to result templates. Without a prepare script, private fields go to `key` and every other field goes to `view`.

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

### What the AI grader reads

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

When a script takes `rng`, it provides:

- `rng.int(min, max)` (inclusive) and `rng.float(min, max, decimals = 2)`
- `rng.pick(array)` and `rng.shuffle(array)` (returns a copy)
- `rng.bool(p = 0.5)` and `rng.next()` (uniform in [0, 1))
- `rng.seed`

### Private fields

When a type has no prepare script, private fields go into `key` and are not sent to the card until the answer is graded. With a prepare script, you decide what goes in `view`; the `private` flag then only labels the field for editors and the AI grader. Everything in `view` should be treated as visible to the learner.

## Item generators

Any item can set `fields.generator`, the body of `function (rng)` that returns an object of field overrides. It runs before prepare with the review's seed, so each review shows a new variant, and the stored seed replays it. Keep valid static fields next to it so lists and previews have something to show. See [packs.md](packs.md#generated-items).

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

This is the `vocab` type from `examples/sampler.pack.json`. It was duplicated as `vocabulary-portuguese` and saved through the Card types page. Each item makes two cards, and `prepare` builds a different view and key for each face:

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
