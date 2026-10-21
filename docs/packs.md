# Packs

A pack is one JSON file that carries decks, presets, card types and items. It is how decks are shared, how agents author content, and how a deck is backed up. Importing is idempotent: items are matched by `id`, so re-importing an edited pack updates content in place and keeps every review and scheduling state.

```json
{
  "etude": "pack/1",
  "name": "CMPT 371 Midterm",
  "description": "Optional markdown.",
  "presets": [{ "id": "exam", "name": "Exam cram", "config": { "desiredRetention": 0.92, "deadline": "2026-10-23T16:30:00-07:00" } }],
  "decks": [{ "name": "CMPT 371", "preset": "exam", "description": "", "instructions": "Grading notes the AI grader reads for every item in this deck." }],
  "types": [],
  "items": []
}
```

Every key except `etude` is optional. Decks named by items but not listed are created with defaults.

## Items

```json
{
  "id": "cmpt371.w1.dtrans-1",
  "type": "numeric",
  "deck": "CMPT 371::1 Introduction",
  "tags": ["cmpt371::delay", "exam::core"],
  "fields": { "prompt": "...", "answer": 0.1, "unit": "ms" },
  "source": "Intro slides p. 27",
  "notes": ""
}
```

- `id`: required, stable, unique across all packs. Use lowercase dotted slugs (`course.unit.topic-n`). Never reuse an id for different content.
- `type`: a built-in type id (below) or a type defined in the pack's `types`.
- `deck`: full deck path; `::` separates levels.
- `tags`: hierarchical with `::`. Searching `tag:cmpt371` matches every tag below it.
- `fields`: the type's fields. Markdown fields support GitHub markdown, fenced code, tables, images and KaTeX math (`$inline$`, `$$display$$`).
- `source`: where the content comes from (shown after answering).

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
| `input` | `"text"` \| `"long"` (default) \| `"code"` | `code` is a monospace multiline box (transcripts, code) |
| `explanation` | md *(private)*, optional | |

A decision model returns the verdict (incorrect, partially correct, correct) and a language model writes feedback. The grader reads, from most to least specific: the item's `rubric`, instructions of the item's tags, the deck's `instructions` (and its parents'), and the type's own instructions.

### `draw`: draw the answer, graded by a vision model or self-rated

| field | | |
|---|---|---|
| `prompt` | md | |
| `reference` | md *(private)* | what a correct drawing shows (may include an image) |
| `rubric` | md *(private)*, optional | |
| `background` | `"blank"` \| `"grid"` (default) \| `"lines"` | |

## Custom types

A pack may define its own types. A type is fields, a template (HTML, CSS and JavaScript that runs in a sandboxed frame), an optional `prepare` script that turns fields into what the card shows, and a grader. See [types.md](types.md).
