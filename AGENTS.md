# AGENTS.md

Notes for coding agents. Two different jobs:

- **Using Etude** (making cards, quizzing someone, changing schedules): read [`skill/SKILL.md`](skill/SKILL.md) and use the `etude` CLI. Don't open the SQLite file yourself. The full reference is [`docs/cli.md`](docs/cli.md).
- **Working on Etude** (changing its code): the rest of this file.

## Layout

```
src/core/      engine.ts (every operation), model.ts, scheduler.ts (FSRS-6, deadlines), schedulers.ts (script schedulers; built-ins in schedulers/), optimize.ts (FSRS weights
               from review history), query.ts (search language), sandbox.ts (QuickJS), ai.ts (grading providers),
               types.ts (type loading/validation), adaptive.ts (adaptive decks: estimates, pace, levels, placement;
               the math in learner.ts), util.ts (small shared helpers)
src/server/    app.ts: the HTTP API the web app uses. Each route maps to an engine call.
src/cli/       main.ts → run.ts (parsing, errors, dry run); registry.ts (command table);
               commands/<group>.ts (one file per noun); help.ts; pack-check.ts
web/           React + Tailwind + shadcn/ui (Vite). Pages in web/src/pages, API client in web/src/lib/api.ts
runtime/       runtime.js and card.css, loaded inside every card frame
types/         built-in card types, one directory each (same format as `etude type export`)
docs/          packs.md, types.md, cli.md (the command reference is generated; see below)
skill/         the portable agent skill for using Etude
scripts/       check-pack.ts, gen-cli-docs.ts
test/          node:test suites
```

## Commands

```sh
npm test                                  # node --test "test/**/*.test.ts"
npm run typecheck                         # tsc for the server/CLI and for web/
node src/cli/main.ts <group> <verb> ...   # the CLI from source (Node runs .ts directly)
node scripts/gen-cli-docs.ts              # regenerate docs/cli.md after changing any command
ETUDE_HOME=$(mktemp -d) node src/cli/main.ts ...   # scratch collection
```

## Conventions

- **New operations go in the engine** (`src/core/engine.ts`) and are exposed by the server and the CLI. Anything the UI can do needs a CLI command. Add it to `src/cli/commands/<group>.ts` with a summary, args, flags, examples, `writes`/`dryRun`/`confirm` and an `output` shape, then regenerate `docs/cli.md`. `test/cli-docs.test.ts` fails when the docs are stale.
- CLI output is JSON with stable keys. Errors are `CliError` with a code (`usage`, `not_found`, `validation`, `conflict`, `external`). Don't print anything else on stdout.
- Keep dependencies light: use the Node stdlib (`node:sqlite`, `util.parseArgs`, `node:test`) before adding a package.
- Card templates run in sandboxed iframes (`allow-scripts`, opaque origin) and user scripts run in QuickJS. Don't give either more access. Private fields stay on the server until an answer is submitted.
- Test against temp databases, never a real collection.
- No AI or tool attribution in commits, code comments or docs. Keep comments brief and only where they add something.
- Markdown paragraphs are one line each (no hard wrapping).
