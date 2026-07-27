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

### Answer canvases (`#etude/drawing-canvas`, `#etude/markdown-canvas`, `#etude/coding-canvas`)

Three surfaces for items where the user must **produce** an answer rather than recall one. All are agent-graded: `user_prompt` states the task, `agent_prompt` holds the answer plus the rubric and never reaches the sandbox.

| canvas | for | submits |
|---|---|---|
| `drawing-canvas` | handwriting, characters, sketches, diagrams | PNG saved to `<db-dir>/drawings/`; inbox gets the path |
| `markdown-canvas` | essays, explanations, derivations | markdown text; live preview with LaTeX (`$inline$`, `$$block$$`), headings, lists, tables, task lists, code fences |
| `coding-canvas` | code answers | source text plus its language; editor has line numbers, syntax highlighting, bracket/quote linting, and an optional vim mode |

1. Serve `/widgets/<canvas>?atom=ID`. Optional `widget_data`: drawing takes `{"guides": true, "aspect": 1}`; coding takes `{"language": "python", "starter": "def solve():\n    "}` (or `&language=` on the URL).
2. On submit the widget files an inbox entry and, in Lotus, injects a message into the same chat session.
3. Read the entry with `etude inbox list`. For a drawing, **open the PNG with your image tool and actually look at it** — the path is the point. For markdown or code, the answer text is in the payload.
4. Grade against `agent_prompt` + cascade, then record and clear:

```sh
etude attempt ID --rating N --feedback-file - --answer-file - --via widget --mode widget
etude inbox clear --id <index>
```

For drawings keep the file path in `--answer` so the history stays linked to the image; for markdown and code pass the submitted text verbatim. Images are never inlined as base64 into the database: files stay readable and `db.json` stays small.

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
- **Chess practice (`chess-board`)**: `/widgets/chess-board?atom=ID&queue=chess` renders one position from `widget_data.fen` and takes a single move by click, drag, or keyboard. It is **deterministic**: the widget serializes the move as lowercase UCI (`e2e4`, `e7e8q`) and POSTs it to `/api/attempts` with the queue, so the program grades it and you are not in the per-attempt loop. After the attempt is recorded the widget reveals whether the move matched and replays the reference move on the board. Serve items in queue order (`etude next --queue chess -n 1`), one link per item; never paste the answer into chat, and never grade a chess move yourself. Reference moves come from local Stockfish analysis recorded in each atom's `notes`/`agent_prompt`.
- **MIDI keyboard practice (`midi-rhythm`)**: `/widgets/midi-rhythm?atom=ID&queue=Q` shows falling notes over a piano keyboard and takes the learner's playing from a real MIDI controller. It is **deterministic**: a clean pass POSTs `pass` to `/api/attempts`, so the program grades it and you are not in the per-attempt loop. One atom is one song or one snippet of a song. Author it with `widget_data.notes` = `[{"pitch": "C4", "time": 0, "duration": 0.5}, …]` — `pitch` takes a MIDI number or a scientific name (`C4`, `F#3`, `Bb5`), and `time`/`duration` are in **beats** unless you set `"unit": "seconds"`. `widget_data.accompaniment` accepts the same shape for the automatic, ungraded hand: it sounds in full, while only accompaniment pitches inside the learner's keyboard range appear on the roll. Tune difficulty with `tempo` (BPM, default 90) and `tolerance_ms` (hit window, default 150 — widen it for a beginner, tighten it to drill precision); set `expected` to `pass`. Notes sharing a `time` become one chord that must be struck together, and any wrong note, mistimed note, or missed note restarts the current section. Give every piece longer than about 30 seconds `widget_data.sections` checkpoints; split it into snippet atoms only when section restarts still leave an unplayably large drill. Web MIDI needs a host that frames the widget with `allow="midi"`; if the keyboard cannot be reached the widget shows a URL to open the drill directly in a browser.
- **Free MIDI creation (`catalog`)**: `/widgets/catalog?queue=catalog` opens a full instrument for playing and inventing, **not** a drill. It is the only widget that opens with no atom, and **nothing in the `catalog` queue is ever graded** — never rate an item there, never treat one as practice, and never post an attempt for it. The instrument gives the user a keyboard, the MPK mini's 8 pads (notes 36–43, synthesised percussion), 8 mappable knobs (any CC learns onto any continuous parameter), pitch bend, reverb and room size, a tone filter, transpose/detune, ADSR, a metronome, an arpeggiator, and a loop. It saves two kinds of material to the **inbox** (`payload.template: "catalog"`): `kind: "preset"` (the whole control state, with CC bindings and pad assignments) and `kind: "recording"` (timestamped note/pad events plus the preset they were played through). Because the inbox needs an atom that already exists, saves arrive under the queue's **anchor** atom (`CAT-00`) — that is a mailbox, not an item to serve. When you see one, create a new `CAT-NN` atom whose `user_prompt`/`topic` is `payload.name` and whose `widget_data` is the payload verbatim, add it to the `catalog` queue, then clear the inbox entry. Reopen saved material with `/widgets/catalog?atom=CAT-NN&queue=catalog`; the widget restores the sound and, for a recording, plays it back. Web MIDI needs a host that frames the widget with `allow="midi"`, and the widget shows a top-level URL when the panel blocks it.
- **Two keyboards, two queues.** When the learner has both a 25-key controller (C3–C5) and an 88-key piano, the instrument decides the queue:
  - **`midi`** — everything that fits inside **C3–C5**. Condensed one-part arrangements and any single hand that happens to fit. A piece may only join this queue if its graded notes span C3–C5; otherwise it belongs to `piano`.
  - **`piano`** — the complete pieces, on 88 keys. **One atom per song**: `widget_data.hands` = `{right, left}` holds both parts, and the widget's own toggle picks which hand is graded (the other plays automatically). Serve the song's single card and let the learner choose the hand; do not split a song into separate atoms.
  Name atoms so the arrangement is visible in `topic` (e.g. "Sweden · right hand"). The older `keyboard*` queues are archived; `midi` and `piano` supersede them.
- **Piece data must be quantized, one voice per graded hand.** Note data lifted straight from a performance MIDI capture carries three defects that all sound like "the piece is wrong" without being wrong about the pitches, and all three were found in the live deck: onsets a few milliseconds off the beat (`1.495` instead of `1.5`) read as drag and phantom gaps; a note still sounding when the next begins is a *second voice merged into a single-hand part* and reads as mud; and a note ending exactly where the same pitch begins again gets its repeat swallowed. Before writing `widget_data`, snap onsets and durations to a musical grid (1/4 beat is usually right), clip any note that runs past the next onset in a graded single-hand part, and leave a small gap (~0.06 beat) before a repeat of the same pitch. A left hand of genuine block chords legitimately keeps its polyphony — a graded *melody* almost never should. Check the result: zero off-grid onsets, zero zero-gap repeats, and polyphony matching what one hand actually plays.
- **Sections (checkpoints)**: `widget_data.sections` = `[{"label": "Chorus", "time": 32}, …]` (same unit as note times) makes a miss rewind to the start of that section instead of the top of the piece. Mandatory for anything longer than ~30 s: restart-from-zero on a three-minute song trains frustration, not music.
- **Ranked-tag queues**: a declarative algorithm may carry `tag_rank: ["opening","middlegame","endgame"]` and sort on `{"key":"ready","dir":"desc"}` then `{"key":"tag_rank","dir":"asc"}`. `ready` is 1 for new or due atoms, so the preferred tag leads while it has work and the later tags are never starved. The live `chess` queue uses `chess-phase-priority` this way.
- **Multiple choice**: `/widgets/multiple-choice?atom=ID[&queue=Q]`. Options live in `widget_data.choices` as bare strings (`["O(1)", "O(log n)"]`) or objects (`{"id": "b", "label": "O(log n)", "description": "halves each step"}`); add `"multiple": true` for select-all-that-apply and `"shuffle": true` to randomize presentation. The submitted answer always uses the configured order, so `expected` stays stable: set it to the option id, or to comma-joined ids for a multi-answer item (`"a, b"`). A deterministic atom (`agent_assisted` false) is graded by the program and the widget marks correct / your pick / missed in place; an agent-assisted atom files the selection in the inbox for you to grade. Keep distractor rationales in `agent_prompt`, never in `widget_data`.
- **Structured answer widgets**: `hotspot-select`, `sequence-board`, `state-tracer`, `tree-explorer`, and `coordinate-plane` all use `/widgets/<name>?atom=ID`. Their public task configuration lives in `atom.widget_data`; canonical future states, correct orders, target coordinates, and grading rubrics stay in `agent_prompt`. Each submits stable IDs plus readable labels/values to the inbox for agent grading.
- **Queues**: `etude queue create Q --label L --algorithm A [--members ...] [--deadline ISO]`; `add-members` / `remove-members` / `edit` / `archive`.
- **Custom algorithms**: `etude algorithms add NAME --spec-file F` (declarative `{order: [{key, dir}...], filter: {...}}`). Procedural policies: mark `agent_only: true` with the procedure in the description; the agent executes them.
- **Archive, never delete**: `etude edit ID --archive`; queues via `status`. The program never destroys data.
- **Tag instructions**: `etude edit-meta` for `tag_instructions` when a rubric should apply to every atom carrying a tag.

## Progress reporting

When the user asks how they're doing:

- Numeric: `etude stats [--queue Q] [--tags T] [--days N]` → coverage, mastery (mean of min(streak,3)/3, unseen = 0 — coverage-weighted preparedness, not literal competence; say so when forecasting), rating distribution, per-day activity. Render as a compact table or inline progress bar.
- Visual: read-only widget templates, ideal for chat surfaces that render iframes/widgets. See the nudge table under **Widget nudges** for the full set and what each answers — `queue-progress`, `queue-overview`, `queue-items`, `item-carousel`, `item-inspector`, `tag-breakdown`, `due-forecast`, `session-summary`, `recent-items`, `streaks`, `atom-card`, plus legacy `progress`. Or the dashboard (deep link `/#ATOM-ID`). All accept `&theme=X` (`default` dark, `notion` minimalist light, `everforest`).
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
| `#etude/drawing-canvas` | `/widgets/drawing-canvas?atom=ID` | Let me handwrite/sketch the answer; the agent reads the image (aliases: `#etude/canvas`, `#etude/draw`) |
| `#etude/markdown-canvas` | `/widgets/markdown-canvas?atom=ID` | Let me write a long-form answer in markdown with live preview and LaTeX |
| `#etude/coding-canvas` | `/widgets/coding-canvas?atom=ID` | Let me write code with line numbers, syntax highlighting, linting, and optional vim mode |
| `#etude/map` | `/widgets/map-select?atom=ID` | Let me pick countries or regions on a clickable world map (add `&region=Europe` to narrow it) |
| `#etude/hotspot` | `/widgets/hotspot-select?atom=ID` | Let me identify regions on any supplied image or SVG diagram |
| `#etude/sequence` | `/widgets/sequence-board?atom=ID` | Let me arrange steps or events in order |
| `#etude/choice` | `/widgets/multiple-choice?atom=ID` | Give me the options and let me pick the answer |
| `#etude/state` | `/widgets/state-tracer?atom=ID` | Let me predict state changes one operation at a time |
| `#etude/tree` | `/widgets/tree-explorer?atom=ID` | Let me choose a graph or search-tree expansion order |
| `#etude/coordinates` | `/widgets/coordinate-plane?atom=ID` | Let me place and move points, vectors, polylines, or regions |
| `#etude/midi` | `/widgets/midi-rhythm?atom=ID&queue=Q` | Let me play a song or snippet on my MIDI keyboard in time with falling notes |
| `#etude/catalog` | `/widgets/catalog?queue=catalog` | Let me play and invent freely on my MIDI — pads, knobs, reverb, pitch (never graded) |
| `#etude/streak` | `/widgets/streaks?days=35` | Am I keeping the habit? |
| `#etude/recent` | `/widgets/recent-items?limit=10` | What did I touch most recently? |
| `#etude/items` | `/widgets/queue-items?queue=Q` | The full ordered work list as a table |

Resolution rules:

- `queue=` is **required** for `#etude/progress` and `#etude/items`; **optional** for `#etude/carousel` and `#etude/due` (omit to span the whole DB). If a queue is needed and the user has exactly one active queue, use it silently; if several, ask which — that is a genuine fork, not a guess.
- `#etude/item` needs an atom ID. If the user names an item instead ("the UTF-8 one"), resolve it from the read-only `/api/db` payload (there is no `etude list` command), then serve the widget for the matching ID.
- **The three answer canvases** (`#etude/drawing-canvas`, `#etude/markdown-canvas`, `#etude/coding-canvas`) all take an atom ID, and a bare invocation means "give me something to answer" — don't stop to ask. Pick the next due item that suits the surface (`etude next`, or search tags: `handwriting`/`kanji` for drawing, `explain`/`essay` for markdown, `write-assembly`/`code` for coding) and serve it. If the user names a target with no atom yet ("kanji de água"), create the atom first — `user_prompt` = the task, `agent_prompt` = the answer plus the rubric — then serve the canvas. `#etude/canvas` and `#etude/draw` remain aliases for the drawing canvas. After they submit, read the inbox entry (open the PNG for drawings) and grade it; see the answer-canvas workflow above.
- **Structured answer widgets** (`#etude/hotspot`, `#etude/sequence`, `#etude/state`, `#etude/tree`, `#etude/coordinates`, `#etude/choice`) also take an atom ID. A bare invocation means “give me a suitable item”: pick the next due atom whose `widget_data` matches the surface. If the user names a task with no atom, create one with public interaction data in `widget_data` and the hidden canonical answer/rubric in `agent_prompt`. After submission, read the structured inbox payload, grade it, record the attempt verbatim as JSON, and clear that inbox item.
- **`#etude/midi`** takes an atom ID and a queue. A bare invocation means "give me something to play": pick the next due atom carrying `widget_data.notes`. If the user names a song with no atom yet, create one — `user_prompt` = what to play, `widget_data.notes` = the snippet, `expected` = `pass`, `agent_assisted` = false — then serve it. Grading is the program's job; never rate the playing yourself.
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
- Templates in `widgets/templates/` include interactive flashcard-drill, matching-pairs, drawing-canvas, markdown-canvas, coding-canvas, map-select, hotspot-select, sequence-board, state-tracer, tree-explorer, coordinate-plane, and multiple-choice plus read-only queue-progress, queue-items, queue-overview, item-carousel, item-inspector, tag-breakdown, due-forecast, session-summary, recent-items, streaks, atom-card, and progress. Matching-pairs reads `atom.widget_data.pairs`.
- **Every template body is transparent and theme-driven.** Widgets inherit the host surface (the Lotus chat canvas) rather than painting their own; all color comes from semantic tokens, so a theme switch restyles the whole widget. Never hardcode a hex/rgb color or set an opaque `background` on `body`. Progress fills band low→mid→high→full through `--status-critical/severe/warning/good`, which keeps them legible on every theme's track. Themes live in `widgets/themes/`; `default` is the canonical shadcn-style dark theme. The server injects the theme, `widgets/shadcn.css`, the `ETUDE` payload, and the ResizeObserver bridge. New templates remain self-contained and use the two injection markers.
- **Interactive template hierarchy:** keep the task label, title, and rendered Markdown prompt directly on the transparent host canvas; card only the learner's answer surface; keep toolbars, mode selectors, reset controls, diagnostics, and submission actions outside the card. In `coding-canvas`, only the editor is carded. Deterministic choice controls count as the answer surface. Use the shared safe prompt renderer rather than template-specific Markdown regexes, and make prompt code blocks wrap instead of creating nested horizontal scrollbars.
- **Vendored libraries** live in `widgets/vendor/` (KaTeX for math, CodeMirror 6 with vim for code) because sandboxes have no network. They are opt-in per template via the `/*__KATEX__*/` and `/*__CODEMIRROR__*/` markers — never inject both, they are over a megabyte together.
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
