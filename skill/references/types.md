# Custom card types

The full specification is `docs/types.md` in the repo: fields, the template and card script API, `prepare`, graders, the sandbox and `std`, and two worked examples. Read it before writing a type. This page is the workflow.

## Workflow

```sh
etude type list                          # what exists (builtin, edited, custom; item counts)
etude type new <id> -o dir               # minimal working type: prompt, private answer, script grader
# or start from a built-in:
etude type export numeric -o dir         # then change "id" in dir/type.json
etude type validate dir                  # compiles everything; no save
etude type preview --from dir --fields '{"prompt":"...","answer":"..."}' [--seed 3]
etude type test-grade --from dir --fields '{...}' --answer "..."     # runs the grader, saves nothing
etude type import dir --dry-run
etude type import dir                    # create or update (idempotent)
etude type frame <id> -o card.html       # the card's HTML document, for a browser check
```

The directory form: `type.json` (id, name, description, faces, fields, grader kind, instructions), `template.html`, `style.css`, `card.js` (in-frame script), `prepare.js`, `grade.js`. Files win over the same keys in `type.json`.

## Rules of thumb

- Ids are lowercase slugs and can't change once items use them. To fork a built-in, use `etude type copy numeric numeric-units`.
- Answers go in `private` fields. Without a `prepare` script, private fields stay out of `view` until grading. With one, *you* decide what goes in `view`, and everything in it is visible to the learner.
- The grader body is `function (answer, view, key, fields)` returning `{ score: 0..1, details?, feedback? }`. Return `score: null` (or `defer: true` with a `hybrid` grader) to hand the answer to the AI.
- Use `std.looseEqual`, `std.parseNumber` and `std.within` instead of writing your own normalization.
- Scripts run in QuickJS with no I/O and time limits (500 ms prepare and generators, 1 s grading).
- Card frames are sandboxed iframes. The card script talks to the app through the runtime API described in `docs/types.md`, not through network calls.
- Editing a built-in makes it the user's own version (`edited: true`). `etude type reset <id> --yes` restores the shipped one. Custom types can be deleted only when no items use them.
- Test with real items too: `etude type preview <id> --item <item-id>` and `etude type test-grade <id> --item <item-id> --answer ...`.
