# Etude — Architecture

Agent-first systematic practice engine. This document is the **build contract**: every module implements exactly what is specified here. Deviations require updating this file in the same commit.

## 1. What etude is

A practice system flexible enough to be a superset of a traditional flashcard app, designed to be operated **through a chat agent** rather than through its own GUI. The user talks to their agent ("let's practice for my CMPT-310 exam"); the agent manipulates etude through a clean CLI/HTTP API; the dashboard and in-chat applets are inspection/interaction surfaces. Distribution model (future): the user installs the program + adds an agent skill; the skill teaches the agent how to drive the API.

Three practice interaction formats, all supported by one schema:

1. **Agent-assisted, chat-native** — agent presents the prompt, user answers in chat (text/code/file path/attachment), agent grades against the atom's agent instructions, gives feedback + rating. (The CMPT-295 workflow.)
2. **Deterministic, applet-native** — flashcard-style. Agent serves an applet (Anki/RemNote-like drill UI); the user's attempts are checked deterministically against `expected` and POSTed by the applet **directly to the program**, no agent in the loop per attempt. Feedback is right/wrong.
3. **Agent-assisted, applet-mediated** — an interactive applet (matching pairs, puzzle) collects a structured attempt and hands it **to the agent** (via the inbox), which grades non-deterministically and writes feedback.

## 2. Repository layout

```
etude/
├── README.md
├── PLAN.md                    # build plan + lane table (during construction)
├── docs/
│   ├── architecture.md        # this file
│   ├── api.md                 # generated-from-spec API reference (written by CORE lane)
│   └── research/
│       └── applet-signal.md   # research: applet→chat/agent signal mechanics
├── src/etude/                 # Python package (stdlib only)
│   ├── __init__.py
│   ├── store.py               # load/save/locate DB; unknown-key preservation
│   ├── schema.py              # constants, validation
│   ├── scheduler.py           # rating→state transitions, presets, due computation
│   ├── algorithms.py          # queue-algorithm evaluation (builtins + declarative)
│   ├── cascade.py             # agent-instruction cascade resolution
│   ├── cli.py                 # `etude` CLI (argparse), JSON output
│   ├── server.py              # HTTP API + SSE + static file serving (stdlib http.server)
│   └── migrate_v2.py          # one-shot: prototype schema-v2 db.json → v3
├── dashboard/                 # static frontend served by server.py at /
│   ├── index.html
│   ├── app.js
│   └── style.css
├── applets/
│   ├── templates/             # reusable applet templates (self-contained HTML)
│   │   ├── flashcard-drill.html
│   │   ├── matching-pairs.html
│   │   └── progress.html
│   └── themes/
│       ├── default.css        # dark, refined (dashboard palette)
│       └── everforest.css
├── tests/                     # pytest, stdlib-runnable via python -m pytest
└── scripts/
    └── validate.py            # thin wrapper over schema.validate for CI/manual use
```

**Data lives outside the repo.** Default data dir: `~/.etude/` (`db.json`, `config.json`, `inbox.json`, `applets/` user-space overrides). Resolution order for the DB path: `--db` flag > `ETUDE_DB` env > `config.json` `db_path` > `~/.etude/db.json`. Users who keep notes in a synced vault can point `db_path` at a file inside it so their existing sync covers the data.

## 3. Schema v3

Breaking renames from v2 (migration in `migrate_v2.py`): `type` dropped; `prompt` → `user_prompt`; `answer` → `agent_prompt`. New: `agent_assisted`, `expected`, `via` on attempts, `agent_instructions` on queues, `tag_instructions` in meta.

### 3.1 meta

```json
{
  "app": "etude",
  "schema_version": 3,
  "rating_scale": {"0": "fail", "1": "hard", "2": "good", "3": "easy"},
  "scheduler": {
    "presets": {"standard": {...}, "exam-horizon": {...}},
    "selection": "queue deadline <7d => exam-horizon, capped at deadline; else standard"
  },
  "queue_algorithms": { ... registry, unchanged from v2 ... },
  "tag_instructions": {"cmpt-310": "Grade in exam register. ...", "german-vocab": "..."},
  "default_theme": "default",
  "provenance": {...}
}
```

### 3.2 atoms.<ID>

IDs: `PREFIX-NN`, human-stable, never reused.

```json
"GER-01": {
  "user_prompt": "**der Hund** — English?",        // REQUIRED. Markdown shown to the user (text, code, ![img](...), links).
  "agent_prompt": "Accept 'dog'. If asked, note gender article usage.",
                                                   // Markdown FOR THE AGENT: canonical answer, grading rubric,
                                                   // applet build spec, or interface guidance. Required when the
                                                   // atom is agent-assisted; optional (but recommended) otherwise.
  "expected": ["dog"],                             // Deterministic accepted answers (string or list).
                                                   // REQUIRED when agent_assisted resolves to false.
  "agent_assisted": false,                         // true | false | null (null = inherit queue, else default true)
  "tags": ["german", "vocab-week3"],               // optional — orphans legal
  "topic": "Hund",                                 // optional short label
  "applet_data": {"pairs": [["der Hund", "dog"]]}, // optional structured object exposed to applet templates
  "source": "", "created": "YYYY-MM-DD",
  "archived": false,
  "state": "new", "streak": 0, "lapses": 0,
  "last_rating": null, "last_seen": null, "due": null,
  "notes": "",
  "attempts": [{
    "ts": "ISO-8601+offset", "rating": 0,
    "mode": "spaced-repetition|random|agent-choice|applet (free-form label; these are conventions)",
    "variant": "GER-01v1 | null", "variant_prompt": "…",
    "answer": "learner's answer VERBATIM (or structured applet payload as JSON string)",
    "feedback": "correction/confirmation ('' for deterministic)",
    "via": "chat | applet"
  }]
}
```

`applet_data` is optional template-facing data. It must be an object and is included with the atom in rendered drill payloads; keep grading rubrics and hidden answers in `agent_prompt`, never in `applet_data`. The matching-pairs template reads `applet_data.pairs` as `[left, right]` tuples.

`agent_assisted` resolution: atom explicit bool > queue `agent_assisted` > `true`.
Deterministic rating mapping: wrong → 0, right → 3. Matching of `expected` is case-insensitive, whitespace-trimmed, any-of-list.

### 3.3 queues.<id>

```json
"german-week3": {
  "label": "GERM 100 · Woche 3 Vokabeln",
  "algorithm": "fsrs",                     // key into meta.queue_algorithms
  "members": ["GER-01", "GER-02"],         // explicit materialized membership
  "order": [],                             // only for algorithm=manual
  "status": "active",                      // active | archived
  "agent_assisted": false,                 // queue-level default for members (null/absent = no opinion)
  "agent_instructions": "Drill DE→EN only this week.",   // queue-level cascade layer
  "created": "YYYY-MM-DD", "deadline": null, "notes": ""
}
```

### 3.4 Agent-instruction cascade

Three layers, resolved per atom **in the context of a session/queue**:

1. **card-level** — `atom.agent_prompt` (highest priority)
2. **tag-level** — `meta.tag_instructions[tag]` for each of the atom's tags (mid). Multiple matching tags: all apply; conflicts among tags resolved by tag order on the atom.
3. **queue-level** — `queue.agent_instructions` of the active queue (lowest)

Semantics mirror CSS: **all non-conflicting instructions apply together**; on conflict the inner layer wins. `cascade.resolve(atom_id, queue_id) -> {"card": str|None, "tags": [(tag, str)...], "queue": str|None}` returns the ordered stack; the *agent* composes/interprets it (the program does not attempt semantic conflict detection). The CLI exposes it: `etude context <atom-id> --queue <q>`.

## 4. Program interfaces

### 4.1 CLI (`etude`) — the agent's primary interface

Design goals: one short command per operation, compact JSON to stdout, no server required (CLI hits the store directly). Exit 0 on success; errors as `{"error": "..."}` + nonzero exit. `--db` global flag.

```
etude status                                  # counts, active queues, due-now summary
etude next --queue Q [-n 5] [--full]          # next N atoms per the queue's algorithm (default: ids+user_prompt; --full = whole atoms)
etude show ID                                 # full atom
etude context ID [--queue Q]                  # resolved agent-instruction cascade
etude attempt ID --rating N --answer-file F [--feedback-file F] [--variant VID --variant-prompt-file F] [--mode M] [--via chat|applet]
                                              # records attempt + scheduler update in one call.
                                              # For deterministic atoms: omit --rating, pass --answer "..." — program checks `expected`, returns computed rating.
etude add --id ID --user-prompt-file F [--agent-prompt-file F] [--expected ...] [--tags a,b] [--agent-assisted true|false] [...]
etude edit ID [--set field=value ...] [--archive|--unarchive]
etude queue list | show Q | create Q --label L --algorithm A [--members ...] | edit Q [...] | archive Q
etude queue add-members Q ID... | remove-members Q ID...
etude algorithms list | add NAME --spec-file F
etude stats [--queue Q] [--tags ...] [--days N]   # coverage, mastery, rating dist, per-day activity
etude inbox list | clear [--id N]             # applet→agent handoff (see 4.3)
etude serve [--port 2600]                     # dashboard + HTTP API
etude validate                                # integrity check
etude migrate-v2 --from PATH                  # one-shot v2→v3
```

Answers/feedback go through `--*-file` (or `-` for stdin) to keep verbatim content safe from shell quoting.

### 4.2 HTTP API (server.py, default port 2600)

Serves `dashboard/` at `/`, applet templates at `/applets/…` (with theme CSS injection, see 4.4), and:

```
GET  /api/db                       # full DB
GET  /api/atoms?queue=&tags=&state=&archived=&q=
GET  /api/atoms/{id}
POST /api/atoms                    # create   (JSON body mirrors CLI add)
PATCH /api/atoms/{id}
GET  /api/queues                   # + computed per-queue stats
POST /api/queues
PATCH /api/queues/{id}
GET  /api/queues/{id}/next?n=
POST /api/attempts                 # {atom_id, answer, via, rating?, feedback?, mode?, variant?, variant_prompt?, ts?}
                                   # deterministic atom + no rating => server checks expected, computes rating, returns it
GET  /api/stats?queue=&days=
GET  /api/inbox                    # pending applet→agent submissions
POST /api/inbox                    # {atom_id, payload, ts} — applet hands an attempt to the agent
DELETE /api/inbox/{index}
GET  /api/events                   # SSE: db.json/inbox.json mtime change → "reload"
```

Writes rebuild scheduler state exactly like the CLI (single shared code path in store/scheduler — **the server and CLI must not duplicate logic**).

### 4.3 The attempt signal paths (who records what)

| format | attempt flows | rating source | recorded by |
|---|---|---|---|
| chat, agent-assisted | user → chat → agent | agent grades per cascade | agent via `etude attempt` |
| applet, deterministic | user → applet → `POST /api/attempts` | program checks `expected` | server directly |
| applet, agent-assisted | user → applet → `POST /api/inbox` → agent reads `etude inbox` | agent grades payload | agent via `etude attempt --via applet` |

The inbox is the v1 mechanism for "applet sends the attempt to the agent's session": chat surfaces cannot generally be injected into mid-session, so the applet parks the structured payload in the program and the agent picks it up on its next turn (the user says "done" / "fiz"; or the agent polls after presenting the applet). `docs/research/applet-signal.md` documents surface-specific upgrades (Obsidian Agents, Hermes desktop) where direct chat injection is possible.

### 4.4 Applets and themes

- **Templates** (`applets/templates/`): self-contained HTML files with two injection points: `/*__THEME__*/` (CSS variables block) and `/*__DATA__*/` (JSON payload: atoms to drill, API base URL, queue id). Drill atoms include `id`, `user_prompt`, `topic`, and `tags`, plus `applet_data` when the atom defines it; deterministic payloads also include `expected`, while agent-assisted payloads never expose it. The matching-pairs template reads `atom.applet_data.pairs`; the flashcard template uses the `true-false` tag to render direct binary controls instead of a free-text field. The server renders `GET /applets/{template}?queue=Q&theme=T` by injecting both and a shared `ResizeObserver` bridge. The bridge posts `{lotus: 1, type: "resize", height}` to a supporting parent whenever the document height changes; other surfaces ignore it. Templates whose height should shrink as their state becomes shorter opt in with `data-fit-content` on `<body>`; the bridge then measures the body children instead of the viewport floor. This keeps every Etude applet free of nested scrollbars in Lotus without duplicating sizing code across templates. Templates never hardcode colors — only `var(--…)` from the theme contract.
- **Theme contract** (every theme defines exactly these variables): `--bg, --panel, --panel2, --border, --text, --dim, --faint, --accent, --green, --yellow, --red, --purple, --mono, --sans`.
- `meta.default_theme` names the active default; a request may override with `?theme=`. `default` is the refined dark theme; `notion` is the light option. Agent soft-commands (defined in the skill, not in code): `#theme:everforest` (one-off), `#set-default-theme:everforest` (persists via `etude edit-meta default_theme=…`).
- Agents may add new templates/themes over time; user-space additions go in `~/.etude/applets/` which the server overlays over the repo's `applets/` (user-space wins on name collision).

### 4.5 Dashboard

The prototype dashboard, ported: stats cards, GitHub-style activity heatmap, queues sidebar (click = table scoped in that queue's algorithm order with position column), recent activity, tag/state/archived/orphan filters, sortable table, atom detail panel (user_prompt, agent_prompt behind reveal, cascade view, tags, queue membership, scheduler state, full verbatim attempt timeline), SSE live reload, deep links `/#ATOM-ID`. Now split into `index.html` + `app.js` + `style.css` and reading the REST API. Mastery = mean of `min(streak,3)/3`, unseen = 0, tooltip states the formula.

## 5. Scheduler (unchanged mechanics from v2)

Presets `standard` (fail→+1d, then +2d/+5d/+12d, cap +30d; rating 1 half speed; rating 3 skips a step) and `exam-horizon` (fail→~90min, ~2h/6-10h/20-24h, capped at deadline). Queue deadline <7d selects exam-horizon. Rating 0 ⇒ streak=0, lapses+=1, state=learning. Rating ≥1 ⇒ streak+=1; new→learning; learning+streak≥2→review. Scheduler state is per-atom and global across queues. Deterministic atoms use the same ladder (0 or 3 only).

## 6. Hard rules (all writers)

- Unknown keys preserved everywhere; load→modify→dump (`ensure_ascii=False, indent=1`); never regenerate the DB.
- Atomic writes: write temp file + `os.replace`.
- Timestamps ISO-8601 with offset, from the clock, never invented.
- Archive over delete: atoms `archived: true`, queues `status: "archived"`. The program never deletes user data.
- stdlib only. No pip dependencies in `src/`. Tests may use pytest.

## 7. Decisions log

- **JSON file over SQLite**: human-diffable, vault-syncable, small data (<10MB realistic). Revisit only on measured pain.
- **CLI-first agent interface**: cheaper than HTTP for the agent (no server dependency), single code path shared with the server.
- **Materialized queue membership** (not live tag queries): stable, auditable; refresh deliberately.
- **Inbox for applet→agent handoff**: works on every chat surface today; direct injection is a per-surface upgrade documented in research.
- **`user_prompt`/`agent_prompt` naming**: symmetric, self-explanatory; replaces v2 `prompt`/`answer` and the question/task type split.
- **Name "etude"**: provisional; "praxis" rejected (malware name collision with a blocked tool).
