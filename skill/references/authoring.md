# Authoring content

## One item at a time

```sh
etude type show numeric --fields-only        # field names, kinds, which are private/required
etude item add --type numeric --deck "Physics::Kinematics" --id phys.kin.v-1 \
  --prompt "A car goes 100 m in 5 s. Speed in m/s?" --answer 20 --unit m/s --tolerance 0.02 \
  --explanation 'v = d/t = 100/5 = 20 m/s' -t phys::kinematics --source "Ch. 2"
etude item preview phys.kin.v-1 --with-key
```

- Every field of the type is a flag. `--<field>-file path` reads a file, and `--<field> -` reads stdin.
- `--set field=value` parses the value according to the field's kind (lists and JSON from JSON text). `--fields '{...}'` or `--fields-file` give everything at once.
- With `--id`, running `item add` again returns `"result": "unchanged"`. If the content differs, it refuses unless you pass `--upsert`. Use `item edit` for targeted changes.
- Without `--id`, an id is generated. Choose ids yourself when you'll refer to items later.

## Packs (preferred for more than a few items)

```sh
etude pack new course.pack.json --deck "Course" --prefix course   # starter with every built-in type
etude pack check course.pack.json          # validates fields and ids, runs generators over many seeds
etude pack import course.pack.json --dry-run
etude db backup                            # when the pack touches existing items
etude pack import course.pack.json
```

The format is in `docs/packs.md`. In short:

```json
{
  "etude": "pack/1",
  "name": "Course",
  "presets": [{ "id": "exam", "name": "Exam", "config": { "deadline": "2026-12-10T09:00:00-08:00" } }],
  "decks": [{ "name": "Course", "preset": "exam", "instructions": "Grading notes for every item in the deck." }],
  "types": [],
  "items": [{ "id": "course.u1.q1", "type": "basic", "deck": "Course::Unit 1", "tags": ["course::u1"], "fields": { "front": "...", "back": "..." }, "source": "Lecture 1, slide 4" }]
}
```

- Ids are permanent. Re-importing updates content and keeps scheduling and history. Renaming an id creates a new unstudied card and leaves the old one behind.
- One idea per item. Put the answer and explanation in private fields, never in the prompt.
- Record `source` (slide, page, URL) so the learner can check it after answering.
- To change what's already in the collection, round-trip it: `etude pack export --deck X -o x.json`, edit, then check and import.

## Built-in types: key fields

| type | grader | fields (private in *italics*) |
| --- | --- | --- |
| `basic` | self | front, *back*, *extra* |
| `typed` | script | prompt, *answers* (list, any one accepted), match (loose\|exact\|regex), placeholder, *explanation* |
| `numeric` | script | prompt, *answer*, unit, tolerance (relative, 0.01 = 1%), parts (`[{label, answer, unit, tolerance}]` for several answers), *explanation* |
| `mcq` | script | prompt, *options* (`[{text, correct?, why?}]`), multiple, shuffle, *explanation* |
| `order` | script | prompt, *steps* (in correct order; shown shuffled), *explanation* |
| `match` | script | prompt, *pairs* (`[[left, right]]`), *explanation* |
| `cloze` | script | text with `{{answer}}`, `{{a\|alt}}` (alternatives), `{{answer::hint}}`, *explanation* |
| `free` | ai | prompt, *reference*, *rubric*, input (text\|long\|code), *explanation* |
| `draw` | ai (vision) | prompt, *reference*, *rubric*, background (blank\|grid\|lines) |

Fields support markdown and `$...$` / `$$...$$` math. Always confirm field names with `etude type show <id> --fields-only`, because edited or custom types can differ.

## Generated items

Add a `generator` field: the body of a JS function that gets a seeded `rng` and returns field overrides.

```js
const L = rng.pick([500, 1000, 1500]); const R = rng.pick([1, 10, 100]);
const ms = Number((L * 8 / (R * 1e6) * 1e3).toPrecision(6));
return { prompt: `A ${L}-byte packet on a ${R} Mbps link. Transmission delay in ms?`, answer: ms };
```

- `rng.int(a, b)` (inclusive), `rng.float(a, b, decimals)`, `rng.pick(arr)`, `rng.shuffle(arr)`, `rng.bool(p)`, `rng.next()`.
- Round results (`toPrecision`, `std.round`) so keys don't show float noise.
- Keep the static fields as one valid example.
- Verify with `etude item variants <id> -n 20`: read the keys and do a few by hand. `distinct` counts the variants that differ.

## Building a deck from notes

1. Read the source. List the ideas worth remembering, and skip trivia.
2. Choose a deck path and an id prefix (`course.unit.`). Use tags for topics (`course::topic`), decks for structure.
3. Choose types to fit the knowledge: definitions → `basic`/`typed`, calculations → `numeric` with a generator, discrimination → `mcq`, sequences → `order`, explanations → `free` with a rubric.
4. Write a pack, then run `pack check` and `pack import --dry-run`, show the user a sample (`item preview --with-key`), and import.
5. Report what was created (counts and ids from the import output).
