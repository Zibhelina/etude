# etude

**Agent-first systematic practice.** A practice engine flexible enough to be a superset of a traditional flashcard app, designed to be operated through a chat agent rather than through its own GUI. You talk to your agent ("let's practice for my exam next week"); the agent drives etude through a clean CLI and HTTP API; a dashboard and themable in-chat widgets are the inspection and interaction surfaces.

*(The name is provisional.)*

## The idea

Flashcard apps hardcode one interaction: card → recall → grade yourself. Real practice is wider than that. Sometimes you want exactly Anki (20 German words, right/wrong, no ceremony). Sometimes you want an essay prompt graded against a rubric with real feedback. Sometimes you want to write assembly in chat and have it reviewed line by line. Etude's bet is that **the agent is the interface** — so the engine only needs to store practice state well and expose it cleanly, and the agent composes whatever interaction each item deserves.

Three interaction formats, one schema:

| format | flow | rating |
|---|---|---|
| chat, agent-assisted | agent asks → you answer in chat (text, code, file path) → agent grades per instructions | 0–3, agent judgment |
| widget, deterministic | agent serves a drill widget → your attempts POST straight to the program | right/wrong (0 or 3), computed |
| widget, agent-mediated | interactive widget (matching, puzzle) → structured attempt lands in an inbox → agent grades it | 0–3, agent judgment |

## Core concepts

- **Practice atom** — the unit. Born free: only `user_prompt` (what you see) and `agent_prompt` (instructions for the agent: canonical answer, grading rubric, widget spec) are required. Tags, queues, and history accrue over time; orphans are legal. Prompts are markdown — text, code, images, links.
- **`agent_assisted`** — per atom or per queue. `false` = deterministic flashcard mode: the atom carries `expected` (accepted answers), the program checks them, no LLM in the loop per attempt. `true` (default) = the agent grades.
- **Queue** — a first-class ordered work list. An atom can be in many queues; each queue runs one **queue-algorithm** (FSRS-like scheduling, oldest/newest-first, weakest-first, least-practiced, manual order, random — or your own declarative sort). Scheduler state is per-atom and global; the queue picks the order, the scheduler decides when an atom comes back.
- **Agent-instruction cascade** — CSS-style layering: card-level `agent_prompt` > tag-level `meta.tag_instructions` > queue-level `agent_instructions`. Non-conflicting instructions all apply; inner layers win conflicts.
- **Attempts** — every attempt is stored verbatim (your exact answer, the feedback, rating, timestamp, `via` chat/widget). The atom is its own history.
- **Archive over delete** — atoms (`archived: true`) and queues (`status: archived`) are hidden, never destroyed.

## Install & run

Requires Python 3.11+. Stdlib only — no dependencies.

### Option A — let your agent install it (recommended)

Etude is agent-first, so the natural installer is your agent. Copy the skill file at [`skill/SKILL.md`](skill/SKILL.md) (raw link works too) and paste it to your agent — or just tell it:

> Install the etude skill from https://github.com/Zibhelina/etude — download `skill/SKILL.md`, add it to your skills, clone the repo, and verify `etude status` runs.

The skill teaches the agent everything: how to clone the repo, drive the CLI/API, run practice sessions, serve widgets, and even modify the codebase on request (`#etude/dev`).

### Option B — manual

```sh
git clone https://github.com/Zibhelina/etude.git && cd etude
PYTHONPATH=src python3 -m etude status            # CLI
PYTHONPATH=src python3 -m etude serve             # dashboard + API on :2600
```

Then add [`skill/SKILL.md`](skill/SKILL.md) to your agent's skill library so it knows how to operate the program.

Data lives in `~/.etude/db.json` by default. Override with `--db`, `ETUDE_DB`, or `db_path` in `~/.etude/config.json`.

Migrating from the schema-v2 prototype: `python3 -m etude migrate-v2 --from path/to/v2/db.json`.

## For agents (the actual interface)

Your agent gets a skill that teaches it this. Everything is one short command with compact JSON out:

```sh
etude status                             # where things stand
etude next --queue german-w3 -n 5        # next atoms, in the queue's algorithm order
etude context GER-01 --queue german-w3   # resolved instruction cascade
etude attempt GER-01 --answer "dog"      # deterministic: rating computed
etude attempt ASM-08 --rating 2 --answer-file - --feedback-file fb.md
etude add --id GER-21 --user-prompt "..." --expected dog --agent-assisted false --tags german
etude queue create exam --label "Final" --algorithm fsrs --members A-01,A-02 --deadline 2026-08-14T15:00
etude stats --queue exam --days 7
etude inbox list                         # widget attempts waiting for grading
```

Full reference: [`docs/api.md`](docs/api.md). Same operations over HTTP (`/api/…`) when the server is running.

### Widgets and themes

`GET /widgets/flashcard-drill?queue=german-w3&theme=everforest` returns a self-contained HTML drill: the server injects the selected theme, the shared open-code shadcn component layer, and the queue's atoms into the template. Deterministic drills POST attempts straight to `/api/attempts`; interactive templates (matching-pairs) POST structured payloads to `/api/inbox` for the agent to grade. Read-only templates cover queue progress, queue items, streaks, atom inspection, and overview stats.

**shadcn/ui is the default for every new widget unless the user asks for another visual system.** Templates compose the shared primitives in `widgets/shadcn.css` and semantic theme tokens defined in `widgets/themes/`; the full visual and accessibility contract lives in [`docs/widget-design.md`](docs/widget-design.md). User-space additions in `~/.etude/widgets/` override shipped files. Old `/applets/*`, `~/.etude/applets/`, and `applet_data` inputs remain compatible, but new work uses widget terminology.

## Architecture

```
src/etude/            # stdlib-only Python package
  store.py            #   DB location, atomic load/save, unknown-key preservation
  schema.py           #   validation
  scheduler.py        #   rating→state transitions, presets, deterministic checking
  algorithms.py       #   queue-algorithm evaluation
  cascade.py          #   instruction cascade resolution
  cli.py              #   the `etude` CLI (JSON out)
  server.py           #   HTTP API + SSE + dashboard + widget rendering
  migrate_v2.py       #   one-shot v2→v3 migration
dashboard/            # static frontend (vanilla JS) on the REST API
widgets/              # templates + themes
docs/architecture.md  # the full contract: schema, API, decisions
docs/api.md           # CLI + HTTP reference
docs/research/        # widget→agent signal mechanics per chat surface
tests/                # pytest (61 passing tests)
```

Key decisions (rationale in `docs/architecture.md` §7): single JSON file over SQLite (human-diffable, vault-syncable); CLI-first agent interface sharing one code path with the server; materialized queue membership over live tag queries; an inbox for widget→agent handoff (works on every chat surface; direct chat injection is a per-surface upgrade, researched in `docs/research/widget-signal.md`); the program never deletes user data.

## Status

Working v1: core engine, CLI, HTTP API, dashboard, seven widget templates, three themes, migration from the v2 prototype, and a distributable operator skill. Real use (one user, daily university practice) is the current test bed.
