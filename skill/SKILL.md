---
name: etude
description: "Use etude for practice sessions and reusable widgets."
version: 1.2.0
license: MIT
metadata:
  category: education
  tags: [etude, practice-engine, spaced-repetition, agent-first, widgets]
---

# Etude — agent-first practice engine

Etude is a program; the agent operates it through its CLI/HTTP API — never by hand-editing the database. The user practices through chat; widgets and the dashboard are surfaces.

**Setup (first use):** if etude is not installed yet, clone the repository and verify it runs:

```sh
git clone https://github.com/Zibhelina/etude.git ~/dev/etude
cd ~/dev/etude && PYTHONPATH=src python3 -m etude status
```

Requires Python 3.11+ (stdlib only, no pip dependencies). If `python3` is older, find or install a 3.11+ interpreter and use it explicitly. Data lives in `~/.etude/db.json` by default; override via `--db`, `ETUDE_DB`, or `db_path` in `~/.etude/config.json`. Full docs: `docs/architecture.md` and `docs/api.md` in the repo.

## Invocation

```sh
cd ~/dev/etude && PYTHONPATH=src python3 -m etude <cmd>
```

All output is compact JSON. Server: `etude serve --port 2600` (dashboard at http://127.0.0.1:2600; run it in the background and verify with `curl -s http://127.0.0.1:2600/api/db` before telling the user it's up).

## Concepts (30-second model)

- **Atom** = `user_prompt` (markdown shown to the user) + `agent_prompt` (instructions to the AGENT: canonical answer, grading rubric, widget spec) + optional `expected` (deterministic accepted answers) + optional `widget_data` (structured object exposed to widget templates) + `agent_assisted` (atom > queue > default true) + tags + scheduler state + verbatim `attempts[]`. Atoms may be orphans (no tags, no queue).
- **Queue** = ordered work list with one algorithm (fsrs, oldest-first, newest-first, weakest-first, least-practiced, manual, random, or custom declarative). Explicit `members` list. Optional `deadline` (<7 days away ⇒ compressed exam-horizon scheduling, due dates capped) and `agent_instructions`.
- **Cascade** = card `agent_prompt` > tag `meta.tag_instructions` > queue `agent_instructions`. All non-conflicting layers apply together; inner layers win conflicts. `etude context ID --queue Q` returns the stack — READ IT before grading.
- **Deterministic atoms** = flashcard mode: the program checks `expected`, rating is 0 or 3, no agent feedback. The agent's job is only to serve the widget.

## Session workflows

### Agent-assisted practice (chat-graded)

1. `etude next --queue Q -n 5` for the upcoming atoms; `etude context` for the grading instructions.
2. Present ONE question (`user_prompt`) — never reveal the answer before the user attempts. Grade the attempt against `agent_prompt` + cascade; give compact feedback (what's right, what's wrong, the precise fix) and a rating 0–3 (0 fail · 1 hard · 2 good · 3 easy).
3. Persist each round when the user advances: `etude attempt ID --rating N --answer-file - --feedback-file - --queue Q` (stdin for verbatim content — the user's exact answer text, typos included; never paraphrase).
4. On rating 0, drill an immediate same-skill variant: `--variant IDv1 --variant-prompt-file -`.
5. Everything lands in the atom's `attempts[]`; the dashboard updates live. There is no separate log file.

### Deterministic drill (flashcard-style)

1. Confirm/create the queue with `agent_assisted` false (queue level or per atom). Deterministic atoms need `expected`.
2. Ensure the server is running, then hand the user the link: `http://127.0.0.1:2600/widgets/flashcard-drill?queue=Q` (append `&theme=X` on request). Attempts POST straight to the program — the agent is NOT in the per-attempt loop. Tag binary items `true-false`; the widget then renders direct two-choice controls instead of a free-text field.
3. Report afterwards from `etude stats --queue Q`.

### Widget-mediated, agent-graded

1. Serve an interactive template (e.g. `matching-pairs`). Its submit POSTs to `/api/inbox`.
2. When the user says they're done (or after polling `etude inbox list`), grade each payload per the cascade, record with `etude attempt ID --rating N --answer-file - --feedback-file - --via widget`, then `etude inbox clear --id N`.

### Handwriting and sketch practice (`draw-canvas`)

For characters, formulas, diagrams, or anything the user must produce **by hand**: the widget gives them a canvas, saves the drawing as a PNG, and hands the agent a file path to look at.

1. The atom is agent-assisted; `user_prompt` states what to draw ("write the kanji for *house*"), `agent_prompt` holds the answer plus the grading rubric (stroke order, proportion, radicals). Optional `widget_data`: `{"guides": true}` draws centering guides, `{"aspect": 1}` sets the canvas ratio.
2. Serve `/widgets/draw-canvas?atom=ID`.
3. On submit the widget `POST`s the PNG to `/api/drawings`, which saves it to `<db-dir>/drawings/ID-<timestamp>.png` and returns the path, then files an inbox entry `{kind: "drawing", path, strokes, bytes}`. In Lotus it also injects a submit message naming the path, so the request lands in the chat automatically.
4. **Open the PNG with your image-reading tool and actually look at it** before grading — the path is the point of this flow. Judge against `agent_prompt` + cascade, give specific feedback (which stroke, which proportion), then record it:

```sh
etude attempt ID --rating N --feedback-file - --answer 'Handwritten drawing: <path>' --via widget --mode widget
etude inbox clear --id <index>
```

Keep the path in `--answer` so the attempt history stays linked to the image. Drawings are never inlined as base64 into the database: files stay readable and `db.json` stays small.

## Widget→session signal: per-platform protocol

Some chat surfaces let a widget inject the user's attempt directly back into the SAME agent session; most do not. Before widget-mediated practice, resolve which case applies:

**Platforms with native widget→session signal support:**

| platform | mechanism | notes |
|---|---|---|
| Lotus (Hermes Desktop fork) | ```widget``` fenced block; the sandbox posts `{lotus: 1, type: "submit", text}` to `window.parent` | Verified live. Host validates the envelope, ignores the first 500 ms, debounces to one submit per 2 s, and routes the text through the composer's own submit path. `type: "resize"` reports content height. |

*(Update this table when a surface gains support. Verify the mechanism live before listing it.)*

**Everywhere else — the fallback protocol (always works):**

1. State the plan up front, briefly: "I'll give you a link; practice there, then tell me when you're done."
2. Serve the widget link (outside the chat if the surface can't embed it).
3. Interactive agent-graded attempts park in the etude inbox; deterministic attempts don't need the agent at all.
4. When the user signals completion, read `etude inbox list` and grade. If the surface can't reach localhost links at all (remote/mobile), degrade further: the user sends a screenshot or types answers into chat, and the agent records them via `etude attempt`.
5. If it's unclear whether the current surface supports embedding or direct signaling, INVESTIGATE first (this table, the surface's docs, `docs/research/widget-signal.md` in the repo), then offer the best available plan — never assume a bridge exists.

## Managing content

- **Add atoms**: `etude add --id PREFIX-NN --user-prompt "..." [--agent-prompt-file -] [--expected X --expected Y] [--agent-assisted false] [--tags a,b] [--topic T]`. IDs are stable and never reused; a new domain gets a new prefix + domain tag. Ask the user (or infer clearly) whether new atoms join an existing queue — membership is materialized; tags do NOT auto-enroll.
- **Widget data**: set structured template input with `etude edit ID --set 'widget_data={...}'`. Matching pairs require `widget_data.pairs` as `[left, right]` tuples, for example `--set 'widget_data={"pairs":[["200","OK"],["404","Not Found"]]}'`. Keep hidden answers and grading rubrics in `agent_prompt`, never in `widget_data`.
- **Queues**: `etude queue create Q --label L --algorithm A [--members ...] [--deadline ISO]`; `add-members` / `remove-members` / `edit` / `archive`.
- **Custom algorithms**: `etude algorithms add NAME --spec-file F` (declarative `{order: [{key, dir}...], filter: {...}}`). Procedural policies: mark `agent_only: true` with the procedure in the description; the agent executes them.
- **Archive, never delete**: `etude edit ID --archive`; queues via `status`. The program never destroys data.
- **Tag instructions**: `etude edit-meta` for `tag_instructions` when a rubric should apply to every atom carrying a tag.

## Progress reporting

When the user asks how they're doing:

- Numeric: `etude stats [--queue Q] [--tags T] [--days N]` → coverage, mastery (mean of min(streak,3)/3, unseen = 0 — coverage-weighted preparedness, not literal competence; say so when forecasting), rating distribution, per-day activity. Render as a compact table or inline progress bar.
- Visual: read-only widget templates, ideal for embedding in chat surfaces that render iframes/widgets — `http://127.0.0.1:2600/widgets/queue-progress?queue=Q` (progress bar: done/remaining/total, mastery, rating chips), `/widgets/queue-items?queue=Q` (algorithm-ordered practice-item table), `/widgets/recent-items?limit=10` (latest practiced unique items across the DB), `/widgets/streaks?days=35` (per-day activity squares + current/best streak), `/widgets/atom-card?atom=ID` (full atom inspection: prompt, state, attempt history with feedback). Legacy overview: `/widgets/progress?queue=Q`. Or the dashboard (deep link `/#ATOM-ID`). All accept `&theme=X` (`default` dark, `notion` minimalist light, `everforest`).
- Reusable visualizations belong in `widgets/templates/` — save good one-offs as templates instead of regenerating them.

### Widget nudges — `#etude/<widget>`

Widgets are slices of the app surfaced on demand: instead of one central dashboard, the agent renders the slice that answers the question being asked. When the user types a nudge, serve that widget immediately — no clarifying questions, no numeric summary first. Ensure the server is up, then emit the fenced block.

| nudge | route | answers |
|---|---|---|
| `#etude/progress` | `/widgets/queue-progress?queue=Q` | How far through this queue am I? |
| `#etude/queues` | `/widgets/queue-overview` | What queues exist and what's due in each? |
| `#etude/carousel` | `/widgets/item-carousel?queue=Q&limit=12` | Show me the upcoming items as cards |
| `#etude/item` | `/widgets/item-inspector?atom=ID` | Everything about ONE item: tags, state, score, dates, full answer + feedback history |
| `#etude/tags` | `/widgets/tag-breakdown?limit=12` | Which topics am I weakest in? |
| `#etude/due` | `/widgets/due-forecast?days=7` | What's overdue and what lands this week? |
| `#etude/session` | `/widgets/session-summary?hours=24` | What did I just practice, and how did it go? |
| `#etude/draw` | `/widgets/draw-canvas?atom=ID` | Let me handwrite/sketch the answer and grade the image |
| `#etude/streak` | `/widgets/streaks?days=35` | Am I keeping the habit? |
| `#etude/recent` | `/widgets/recent-items?limit=10` | What did I touch most recently? |
| `#etude/items` | `/widgets/queue-items?queue=Q` | The full ordered work list as a table |

Resolution rules:

- `queue=` is **required** for `#etude/progress` and `#etude/items`; **optional** for `#etude/carousel` and `#etude/due` (omit to span the whole DB). If a queue is needed and the user has exactly one active queue, use it silently; if several, ask which — that is a genuine fork, not a guess.
- `#etude/item` needs an atom ID. If the user names an item instead ("the UTF-8 one"), resolve it via `etude list --tags`/search, then serve the widget for the matching ID.
- Every route takes `&theme=X`. Bare `#etude/<name>` with no known match: list the table above rather than inventing a route.
- Nudges are shorthand for the user, not a restriction on the agent — serve the same widgets unprompted whenever they answer the question better than prose.

In Lotus, emit the widget as a fenced `widget` block so it renders inline in the chat:

~~~
```widget
{"url": "http://127.0.0.1:2600/widgets/tag-breakdown?limit=12", "height": 420}
```
~~~

`height` is only the initial fallback — every template reports its true content height through the resize bridge, so the frame settles to the content. Widget bodies are transparent by design: they inherit the host's chat background instead of painting a visible block. Do not add an opaque `background` to a template `body`.

Keep the user in the loop on placement decisions — ask when it's genuinely their call ("new queue for this, or add to X?"), decide silently when context makes it obvious. Say where things landed either way.

## Widgets & themes

- **Default UI system:** every new Etude widget uses shadcn/ui unless the user explicitly asks for another visual language. Read `docs/widget-design.md`; compose the shared open-code component classes in `widgets/shadcn.css` (`ui-card`, `ui-button`, `ui-input`, `ui-badge`, `ui-progress`, and related variants) and the shadcn semantic tokens (`--background`, `--foreground`, `--card`, `--primary`, `--secondary`, `--muted`, `--accent`, `--border`, `--input`, `--ring`, `--radius`, `--chart-*`). Do not imitate shadcn loosely with one-off CSS when a shared component already exists.
- Templates in `widgets/templates/` include interactive flashcard-drill, matching-pairs, and draw-canvas plus read-only queue-progress, queue-items, queue-overview, item-carousel, item-inspector, tag-breakdown, due-forecast, session-summary, recent-items, streaks, atom-card, and progress. Matching-pairs reads `atom.widget_data.pairs`.
- **Every template body is transparent and theme-driven.** Widgets inherit the host surface (the Lotus chat canvas) rather than painting their own; all color comes from semantic tokens, so a theme switch restyles the whole widget. Never hardcode a hex/rgb color or set an opaque `background` on `body`. Progress fills band low→mid→high→full through `--status-critical/severe/warning/good`, which keeps them legible on every theme's track. Themes live in `widgets/themes/`; `default` is the canonical shadcn-style dark theme. The server injects the theme, `widgets/shadcn.css`, the `ETUDE` payload, and the ResizeObserver bridge. New templates remain self-contained and use the two injection markers.
- User-space overrides in `~/.etude/widgets/` win. Legacy `/applets/*`, `~/.etude/applets/`, and `applet_data` remain compatibility inputs only; never generate them for new work.
- Soft-commands: `#theme:NAME` applies a one-off theme; `#set-default-theme:NAME` updates `meta.default_theme`. Verify new themes in a browser before delivery.

## Developer mode — `#etude/dev`

When the user invokes `#etude/dev` (or clearly asks for a change to etude's own behavior), the agent switches from *operator* to *developer*: it modifies the etude codebase to meet the user's need.

1. **Locate the repo** (the directory this skill points at; confirm with `git -C ~/dev/etude status`).
2. **Understand before changing**: read `docs/architecture.md` (the contract) and the relevant module. Small surface, real cause — no hacks.
3. **Change discipline**: keep the architecture contract in sync (update `docs/architecture.md` in the same change when behavior/schema/API shifts); preserve unknown-key handling and the no-delete rule; stdlib only in `src/`.
4. **Verify**: run the test suite (`python3 -m pytest tests/ -q`) and exercise the changed path for real (CLI call, curl, or browser). A schema change additionally requires `etude validate` against the user's live DB.
5. **Commit** with a clear message. If the change alters agent-facing behavior, update this skill in the same session.
6. Destructive or migration-heavy changes (schema rewrites, file moves): back up the DB first and tell the user what will change before doing it.

## Pitfalls

- NEVER write the DB by hand-editing JSON when a CLI verb exists — direct edits bypass validation and scheduler logic. (Exception: schema surgery in dev mode, followed by `etude validate`.)
- Deterministic attempts need no `--rating` (the program computes it); agent-assisted attempts REQUIRE it — the CLI errors otherwise.
- `etude serve` holds the port; check for an existing server before starting another.
- Verbatim means verbatim: `--answer-file -` with the user's exact text, not a paraphrase.
- Inbox indices shift after `clear` — re-list before clearing multiple.
- Timestamps come from the program; never invent them.
