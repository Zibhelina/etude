---
name: etude
description: "Operate etude, an agent-first practice engine — practice atoms with user_prompt/agent_prompt, agent-assisted or deterministic grading, queues with pluggable scheduling algorithms, CSS-like instruction cascade, themable applets, and an inbox for applet attempts. Load for practice sessions, atom/queue management, progress reporting, or applet serving."
version: 1.1.0
license: MIT
metadata:
  category: education
  tags: [etude, practice-engine, spaced-repetition, agent-first, applets]
---

# Etude — agent-first practice engine

Etude is a program; the agent operates it through its CLI/HTTP API — never by hand-editing the database. The user practices through chat; applets and the dashboard are surfaces.

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

- **Atom** = `user_prompt` (markdown shown to the user) + `agent_prompt` (instructions to the AGENT: canonical answer, grading rubric, applet spec) + optional `expected` (deterministic accepted answers) + optional `applet_data` (structured object exposed to applet templates) + `agent_assisted` (atom > queue > default true) + tags + scheduler state + verbatim `attempts[]`. Atoms may be orphans (no tags, no queue).
- **Queue** = ordered work list with one algorithm (fsrs, oldest-first, newest-first, weakest-first, least-practiced, manual, random, or custom declarative). Explicit `members` list. Optional `deadline` (<7 days away ⇒ compressed exam-horizon scheduling, due dates capped) and `agent_instructions`.
- **Cascade** = card `agent_prompt` > tag `meta.tag_instructions` > queue `agent_instructions`. All non-conflicting layers apply together; inner layers win conflicts. `etude context ID --queue Q` returns the stack — READ IT before grading.
- **Deterministic atoms** = flashcard mode: the program checks `expected`, rating is 0 or 3, no agent feedback. The agent's job is only to serve the applet.

## Session workflows

### Agent-assisted practice (chat-graded)

1. `etude next --queue Q -n 5` for the upcoming atoms; `etude context` for the grading instructions.
2. Present ONE question (`user_prompt`) — never reveal the answer before the user attempts. Grade the attempt against `agent_prompt` + cascade; give compact feedback (what's right, what's wrong, the precise fix) and a rating 0–3 (0 fail · 1 hard · 2 good · 3 easy).
3. Persist each round when the user advances: `etude attempt ID --rating N --answer-file - --feedback-file - --queue Q` (stdin for verbatim content — the user's exact answer text, typos included; never paraphrase).
4. On rating 0, drill an immediate same-skill variant: `--variant IDv1 --variant-prompt-file -`.
5. Everything lands in the atom's `attempts[]`; the dashboard updates live. There is no separate log file.

### Deterministic drill (flashcard-style)

1. Confirm/create the queue with `agent_assisted` false (queue level or per atom). Deterministic atoms need `expected`.
2. Ensure the server is running, then hand the user the link: `http://127.0.0.1:2600/applets/flashcard-drill?queue=Q` (append `&theme=X` on request). Attempts POST straight to the program — the agent is NOT in the per-attempt loop. Tag binary items `true-false`; the applet then renders direct two-choice controls instead of a free-text field.
3. Report afterwards from `etude stats --queue Q`.

### Applet-mediated, agent-graded

1. Serve an interactive template (e.g. `matching-pairs`). Its submit POSTs to `/api/inbox`.
2. When the user says they're done (or after polling `etude inbox list`), grade each payload per the cascade, record with `etude attempt ID --rating N --answer-file - --feedback-file - --via applet`, then `etude inbox clear --id N`.

## Applet→session signal: per-platform protocol

Some chat surfaces let an applet inject the user's attempt directly back into the SAME agent session; most do not. Before applet-mediated practice, resolve which case applies:

**Platforms with native applet→session signal support:**

| platform | mechanism | notes |
|---|---|---|
| *(none verified yet)* | | |

*(Update this table when a surface gains support. Verify the mechanism live before listing it.)*

**Everywhere else — the fallback protocol (always works):**

1. State the plan up front, briefly: "I'll give you a link; practice there, then tell me when you're done."
2. Serve the applet link (outside the chat if the surface can't embed it).
3. Interactive agent-graded attempts park in the etude inbox; deterministic attempts don't need the agent at all.
4. When the user signals completion, read `etude inbox list` and grade. If the surface can't reach localhost links at all (remote/mobile), degrade further: the user sends a screenshot or types answers into chat, and the agent records them via `etude attempt`.
5. If it's unclear whether the current surface supports embedding or direct signaling, INVESTIGATE first (this table, the surface's docs, `docs/research/applet-signal.md` in the repo), then offer the best available plan — never assume a bridge exists.

## Managing content

- **Add atoms**: `etude add --id PREFIX-NN --user-prompt "..." [--agent-prompt-file -] [--expected X --expected Y] [--agent-assisted false] [--tags a,b] [--topic T]`. IDs are stable and never reused; a new domain gets a new prefix + domain tag. Ask the user (or infer clearly) whether new atoms join an existing queue — membership is materialized; tags do NOT auto-enroll.
- **Applet data**: set structured template input with `etude edit ID --set 'applet_data={...}'`. Matching pairs require `applet_data.pairs` as `[left, right]` tuples, for example `--set 'applet_data={"pairs":[["200","OK"],["404","Not Found"]]}'`. Keep hidden answers and grading rubrics in `agent_prompt`, never in `applet_data`.
- **Queues**: `etude queue create Q --label L --algorithm A [--members ...] [--deadline ISO]`; `add-members` / `remove-members` / `edit` / `archive`.
- **Custom algorithms**: `etude algorithms add NAME --spec-file F` (declarative `{order: [{key, dir}...], filter: {...}}`). Procedural policies: mark `agent_only: true` with the procedure in the description; the agent executes them.
- **Archive, never delete**: `etude edit ID --archive`; queues via `status`. The program never destroys data.
- **Tag instructions**: `etude edit-meta` for `tag_instructions` when a rubric should apply to every atom carrying a tag.

## Progress reporting

When the user asks how they're doing:

- Numeric: `etude stats [--queue Q] [--tags T] [--days N]` → coverage, mastery (mean of min(streak,3)/3, unseen = 0 — coverage-weighted preparedness, not literal competence; say so when forecasting), rating distribution, per-day activity. Render as a compact table or inline progress bar.
- Visual: read-only widget templates, ideal for embedding in chat surfaces that render iframes/applets — `http://127.0.0.1:2600/applets/queue-progress?queue=Q` (progress bar: done/remaining/total, mastery, rating chips), `/applets/queue-items?queue=Q` (algorithm-ordered practice-item table), `/applets/recent-items?limit=10` (latest practiced unique items across the DB), `/applets/streaks?days=35` (per-day activity squares + current/best streak), `/applets/atom-card?atom=ID` (full atom inspection: prompt, state, attempt history with feedback). Legacy overview: `/applets/progress?queue=Q`. Or the dashboard (deep link `/#ATOM-ID`). All accept `&theme=X` (`default` dark, `notion` minimalist light, `everforest`).
- Reusable visualizations belong in `applets/templates/` — save good one-offs as templates instead of regenerating them.

Keep the user in the loop on placement decisions — ask when it's genuinely their call ("new queue for this, or add to X?"), decide silently when context makes it obvious. Say where things landed either way.

## Applets & themes

- **Visual quality gate:** before creating or changing an applet, read `docs/applet-design.md`. Choose the display from the data shape first; use the shared light/dark tokens and fixed palette order; keep sentence case and weights 400/500; use 0.5px borders; omit gradients, decorative shadows, blur, glow, and arbitrary color cycling; round displayed values; pair status color with an icon and label; and give every visualization a text equivalent. Add or update visual-contract tests and inspect desktop and narrow widths.
- Templates in `applets/templates/` — interactive: flashcard-drill, matching-pairs; read-only widgets: queue-progress, queue-items, recent-items, streaks, atom-card, progress. Matching-pairs reads `atom.applet_data.pairs`. Themes in `applets/themes/`: default (refined dark), notion (minimalist light), everforest. The server injects `/*__THEME__*/` (theme CSS variables), `const ETUDE = /*__DATA__*/null;` (payload), and a shared ResizeObserver bridge. In Lotus, the bridge resizes the iframe to the applet's current content height, including shrinking shorter states when the template opts in with `data-fit-content`, so the fence height is only an initial fallback and nested scrollbars should not appear. New templates MUST use exactly the two file markers, the shared design tokens for every color, `<meta name="color-scheme" content="dark light">`, self-contained HTML, and no external resources.
- The current theme contract is documented in `docs/applet-design.md`: surfaces, text tiers, borders, radii, fixed categorical colors, status colors, and mono/sans stacks. Old short variable names remain compatibility aliases only; new templates use `--surface-*`, `--text-*`, and named palette tokens.
- User-space overrides in `~/.etude/applets/` win over repo files.
- Soft-commands (natural-language, user-reconfigurable): `#theme:NAME` = one-off theme for the next applet link; `#set-default-theme:NAME` = `etude edit-meta default_theme=NAME`. When creating a new theme, honor the variable contract and confirm rendering in a browser before delivering.

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
