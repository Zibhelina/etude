# Packs

A pack is one JSON file that carries decks, presets, card types and items. It is how decks are shared, how agents author content, and how a deck is backed up. Importing is idempotent: items are matched by `id`, so re-importing an edited pack updates content in place and keeps every review and scheduling state.

```json
{
  "etude": "pack/1",
  "name": "Networks Midterm",
  "description": "Optional markdown.",
  "presets": [{ "id": "exam", "name": "Exam cram", "config": { "desiredRetention": 0.92, "deadline": "2026-10-23T16:30:00-07:00" } }],
  "decks": [{ "name": "Networks", "preset": "exam", "description": "", "instructions": "Grading notes the AI grader reads for every item in this deck." }],
  "types": [],
  "items": []
}
```

Every key except `etude` is optional. Decks named by items but not listed are created with defaults.

## Items

```json
{
  "id": "net.w1.dtrans-1",
  "type": "numeric",
  "deck": "Networks::1 Introduction",
  "tags": ["net::delay", "exam::core"],
  "fields": { "prompt": "...", "answer": 0.1, "unit": "ms" },
  "source": "Intro slides p. 27",
  "notes": ""
}
```

- `id`: required, stable, unique across all packs. Use lowercase dotted slugs (`course.unit.topic-n`). Never reuse an id for different content.
- `type`: a built-in type id (below) or a type defined in the pack's `types`.
- `deck`: full deck path; `::` separates levels.
- `tags`: hierarchical with `::`. Searching `tag:net` matches every tag below it.
- `fields`: the type's fields. Markdown fields support GitHub markdown, fenced code (highlighted for any language named after the fence), tables, images and KaTeX math (`$inline$`, `$$display$$`).
- `source`: where the content comes from (shown after answering).

### Example answers

`fields.demo` (an answer in the card's own format) and `fields.demoGrade` (a recorded grade) are optional. Watch-mode decks show them; studying ignores them and they never reach the card. See [Example answers](types.md#example-answers-watch-mode).

### Generated items

Any item may carry `fields.generator`: the body of a JavaScript function that receives `rng` and returns an object of field overrides. Each review runs it with a fresh seed, so one item produces endless variants of the same exercise. The seed is stored with the review, so a variant can always be reproduced.

```json
"generator": "const L = rng.pick([1000, 1500, 2000]); const R = rng.pick([10, 100]); const ms = L * 8 / (R * 1e6) * 1e3; return { prompt: `A ${L}-byte packet on a ${R} Mbps link. Transmission delay in ms?`, answer: ms, explanation: `$d_{trans} = L/R = ${L*8}\\text{ bits} / ${R}\\times10^6\\text{ bits/s} = ${ms}\\text{ ms}$` };"
```

`rng` provides `rng.int(min, max)` (inclusive), `rng.float(min, max, decimals)`, `rng.pick(array)`, `rng.shuffle(array)` (returns a copy), `rng.bool(p)` and `rng.next()` (uniform in [0,1)). Generators run in a sandbox with no I/O, no network and a time limit. Keep the static `fields` filled with one valid example too, so previews and search show something sensible.

## Built-in types

Fields marked *(private)* never reach the card before an answer is submitted.

### `basic`: front and back, self-rated

| field | | |
|---|---|---|
| `front` | md | question side |
| `back` | md *(private)* | answer side |
| `extra` | md *(private)*, optional | shown under the answer |

The learner reveals the back and rates recall (Again, Hard, Good, Easy). Good for definitions and quick recall.

### `typed`: type an exact answer, checked by script

| field | | |
|---|---|---|
| `prompt` | md | |
| `answers` | string[] *(private)* | any one is accepted |
| `match` | `"loose"` (default) \| `"exact"` \| `"regex"` | loose: case-insensitive, trims, collapses whitespace, ignores trailing punctuation |
| `placeholder` | string, optional | input hint |
| `explanation` | md *(private)*, optional | shown after answering |

### `numeric`: numbers with tolerance, one or several parts

| field | | |
|---|---|---|
| `prompt` | md | |
| `answer` | number *(private)* | single-part form |
| `unit` | string, optional | shown beside the input |
| `tolerance` | number, optional | relative, default `0.01` (1%) |
| `parts` | array, optional | multi-part form: `[{ "label": "md", "answer": 1.2, "unit": "ms", "tolerance": 0.01 }]`; replaces `answer`/`unit` |
| `explanation` | md *(private)*, optional | worked solution |

Inputs accept `1.5`, `1,5`, `3e-3`, `1/8` and simple arithmetic. Score is the fraction of parts within tolerance.

### `mcq`: multiple choice

| field | | |
|---|---|---|
| `prompt` | md | |
| `options` | `[{ "text": "md", "correct": true, "why": "md" }]` *(correctness private)* | |
| `multiple` | bool, optional | select-all-that-apply; defaults to true when more than one option is correct |
| `shuffle` | bool, default `true` | |
| `explanation` | md *(private)*, optional | |

### `order`: put blocks in the right order

| field | | |
|---|---|---|
| `prompt` | md | |
| `steps` | md[] *(private order)* | listed in the correct order; shown shuffled |
| `explanation` | md *(private)*, optional | |

Partial credit is the longest correctly ordered subsequence over the number of steps; only the exact order counts as correct.

### `match`: connect each left item to its right item

| field | | |
|---|---|---|
| `prompt` | md | |
| `pairs` | `[["left md", "right md"]]` *(private pairing)* | right side is shown shuffled |
| `explanation` | md *(private)*, optional | |

### `cloze`: fill the blanks

| field | | |
|---|---|---|
| `text` | md with blanks | `{{answer}}`, alternatives `{{80|eighty}}`, hint `{{answer::hint}}` |
| `explanation` | md *(private)*, optional | |

Each blank is checked loosely; score is the fraction filled correctly.

### `free`: open answer graded by AI

| field | | |
|---|---|---|
| `prompt` | md | |
| `reference` | md *(private)* | a model answer |
| `rubric` | md *(private)*, optional | what a correct answer must contain, what is acceptable, common mistakes |
| `input` | `"long"` (default) \| `"text"` \| `"code"` \| `"plain"` | `long` is a markdown editor with live preview: math, code and formatting render as you type, so derivations and proofs can be written the way they are on paper. `text` is one line, `code` a code editor, `plain` a bare textarea |
| `language` | text, optional | for `input: "code"`: the language to highlight |
| `explanation` | md *(private)*, optional | |

A decision model returns the verdict (incorrect, partially correct, correct) and a language model writes feedback. The grader reads, from most to least specific: the item's `rubric`, instructions of the item's tags, the deck's `instructions` (and its parents'), and the type's own instructions.

### `math`: a mathematical answer, checked for equivalence

| field | | |
|---|---|---|
| `prompt` | md | |
| `answers` | list *(private)* | accepted answers in LaTeX or plain notation (`\frac{\sqrt3}{2}`, `sqrt(3)/2`); any one is enough |
| `form` | `"any"` (default) \| `"exact"` \| `"same"` | `exact`: a decimal of the right value gets half credit; `same`: the answer must also have the same form, up to the order and sign of factors (for "factor this" or "simplify") |
| `ordered` | boolean, default `false` | compare lists in order instead of as sets |
| `placeholder` | text, optional | |
| `explanation` | md *(private)*, optional | |

The learner types LaTeX or plain math and sees it typeset live; what renders is what gets graded. Grading is by equivalence, not by string: both sides are evaluated at many random points, so `x(x+1)`, `x^2+x` and `x + x^2` all match `x^{2} + x`, and `\sin^2 x + \cos^2 x` matches `1`. Equations match when one is a multiple of the other (`y = 3x - 1` and `6x - 2y = 2`), `x = 3` matches `3`, and lists like `\{2, -1\}` compare as sets with partial credit. A decimal rounded to the digits given (`-0.87` for $-\frac{\sqrt3}{2}$) gets half credit. Supported: arithmetic, powers and roots, `\frac`, `\sqrt[n]{}`, trig and inverse trig, `\ln`, `\log_b`, `e^x`, `|x|`, `n!`, Greek letters, subscripted variables, equations, lists and tuples.

### `code`: write code in a real editor

| field | | |
|---|---|---|
| `prompt` | md | |
| `language` | text, default `"python"` | any language name or extension: `python`, `js`, `c++`, `rust`, `sql`, `haskell`, ... (about 140) |
| `starter` | code, optional | what the editor starts with |
| `reference` | code *(private)* | a correct solution, shown highlighted after answering |
| `tests` | json *(private)*, optional | JavaScript only: `[["expression", expected], ...]` |
| `rubric` | md *(private)*, optional | for the AI grader |
| `explanation` | md *(private)*, optional | |

The editor has syntax highlighting, line numbers, bracket matching and Tab to indent. JavaScript answers with `tests` run in the sandbox: each expression is evaluated with the answer's code in scope and compared (as JSON) with the expected value; the score is the fraction that pass and the result lists every test. Any other answer goes to the AI grader with the reference and rubric. `etude pack check` runs the reference solution against its own tests.

### `draw`: draw the answer, graded by a vision model or self-rated

| field | | |
|---|---|---|
| `prompt` | md | |
| `reference` | md *(private)* | what a correct drawing shows (may include an image) |
| `rubric` | md *(private)*, optional | |
| `background` | `"blank"` \| `"grid"` (default) \| `"lines"` | |

## Custom types

A pack may define its own types. A type is fields, a template (HTML, CSS and JavaScript that runs in a sandboxed frame), an optional `prepare` script that turns fields into what the card shows, and a grader. See [types.md](types.md).

A type can carry asset files (`"assets": { "name": "base64" }`, see [Assets](types.md#assets)), shipped once with the type and shared by every item. `etude pack export` includes the assets of the custom types it exports. Importing reports them next to the types:

```json
"types": { "created": 0, "updated": 0, "unchanged": 1 },
"assets": { "files": 2, "bytes": 6291456, "created": 0, "updated": 0, "unchanged": 2, "removed": 0 }
```

`files` and `bytes` describe the assets the pack's types carry; the other counts say what the import did with them. Re-importing identical assets reports them `unchanged`, and a dry run writes nothing.
