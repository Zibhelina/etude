# Etude API Reference

## CLI

`etude` is an alias for `python3.11 -m etude`. Examples below use the module form so they also work from a source checkout (`PYTHONPATH=src`). Every invocation writes exactly one compact JSON object to stdout. Failures write `{"error":"…"}` and exit 1.

The global `--db PATH` flag may precede any command. Database resolution is `--db` → `ETUDE_DB` → `~/.etude/config.json`'s `db_path` → `~/.etude/db.json`. File flags accept UTF-8 files; `-` means stdin. Dates and timestamps in the outputs below came from real CLI runs on 2026-07-23; paths have been shortened to `/tmp/etude-doc/…`.

### `status`

**Synopsis:** `etude [--db PATH] status`

No command-specific flags. Reports atom counts, active queue count, and non-archived atoms due now.

```console
$ etude --db /tmp/etude-doc/db.json status
{"atoms":{"total":2,"active":2,"archived":0},"active_queues":1,"due_now":0}
```

### `next`

**Synopsis:** `etude [--db PATH] next --queue Q [-n N] [--full]`

- `--queue Q` (required): queue whose algorithm determines order.
- `-n N`: positive result limit; default 1.
- `--full`: return complete atoms with an added `id`; otherwise return only `id` and `user_prompt`.

```console
$ etude --db /tmp/etude-doc/db.json next --queue review -n 1
{"queue":"review","atoms":[{"id":"GEO-1","user_prompt":"Capital of France?"}]}
```

With `--full` the real output for the same atom was:

```json
{"queue":"review","atoms":[{"user_prompt":"Capital of France?","agent_prompt":null,"expected":["Paris"],"agent_assisted":false,"tags":["geography"],"topic":"","source":"","created":"2026-07-23","archived":false,"state":"learning","streak":1,"lapses":0,"last_rating":3,"last_seen":"2026-07-23T21:19:54-07:00","due":"2026-07-28T21:19:54-07:00","notes":"","attempts":[{"ts":"2026-07-23T21:19:54-07:00","rating":3,"mode":"spaced-repetition","variant":null,"variant_prompt":null,"answer":"Paris","feedback":"","via":"chat"}],"id":"GEO-1"}]}
```

### `show`

**Synopsis:** `etude [--db PATH] show ID`

Returns the complete atom without modifying it.

```console
$ etude --db /tmp/etude-doc/db.json show MATH-1
{"id":"MATH-1","atom":{"user_prompt":"Explain why 2 + 2 = 4.","agent_prompt":"Accept any concise arithmetic explanation.","expected":[],"agent_assisted":null,"tags":["math","arithmetic"],"topic":"Addition","source":"","created":"2026-07-23","archived":false,"state":"new","streak":0,"lapses":0,"last_rating":null,"last_seen":null,"due":null,"notes":"","attempts":[]}}
```

### `context`

**Synopsis:** `etude [--db PATH] context ID [--queue Q]`

`--queue Q` supplies the queue layer. The result preserves card → tag → queue cascade layers; tag pairs become JSON arrays.

```console
$ etude --db /tmp/etude-doc/db.json context MATH-1 --queue review
{"id":"MATH-1","queue":"review","context":{"card":"Accept any concise arithmetic explanation.","tags":[["math","Show reasoning."]],"queue":"Be concise."}}
```

### `attempt`

**Synopsis:** `etude [--db PATH] attempt ID [--queue Q] [--rating 0..3] (--answer TEXT | --answer-file FILE) [--feedback-file FILE] [--variant VID] [--variant-prompt-file FILE] [--mode MODE] [--via chat|widget]`

- `--queue Q`: controls inherited `agent_assisted` and deadline scheduler preset selection.
- `--rating`: required for agent-assisted atoms. Omit it for deterministic atoms; etude checks `expected` and computes 3 (right) or 0 (wrong).
- `--answer TEXT`: short inline answer. `--answer-file FILE` preserves verbatim file/stdin content.
- `--feedback-file FILE`: verbatim feedback; default `""`.
- `--variant VID`, `--variant-prompt-file FILE`: optional variant metadata.
- `--mode MODE`: default `spaced-repetition`.
- `--via chat|widget`: default `chat`.

```console
$ etude --db /tmp/etude-doc/db.json attempt GEO-1 --queue review --answer Paris
{"id":"GEO-1","computed":true,"attempt":{"ts":"2026-07-23T21:19:54-07:00","rating":3,"mode":"spaced-repetition","variant":null,"variant_prompt":null,"answer":"Paris","feedback":"","via":"chat"},"atom":{"user_prompt":"Capital of France?","agent_prompt":null,"expected":["Paris"],"agent_assisted":false,"tags":["geography"],"topic":"","source":"","created":"2026-07-23","archived":false,"state":"learning","streak":1,"lapses":0,"last_rating":3,"last_seen":"2026-07-23T21:19:54-07:00","due":"2026-07-28T21:19:54-07:00","notes":"","attempts":[{"ts":"2026-07-23T21:19:54-07:00","rating":3,"mode":"spaced-repetition","variant":null,"variant_prompt":null,"answer":"Paris","feedback":"","via":"chat"}]}}
```

A rated, agent-assisted invocation used `--rating 2 --answer 'Because addition combines two pairs.' --feedback-file -` and returned `"computed":false` with the supplied rating and feedback.

### `add`

**Synopsis:** `etude [--db PATH] add --id ID (--user-prompt TEXT | --user-prompt-file FILE) [--agent-prompt-file FILE] [--expected VALUE ...] [--tags a,b] [--agent-assisted true|false] [--topic TEXT] [--source TEXT] [--notes TEXT]`

- IDs must match `PREFIX-NN` and must not already exist.
- Agent-assisted atoms require `--agent-prompt-file`.
- Deterministic atoms require `--agent-assisted false` and at least one repeatable `--expected`.
- `--tags` is a comma-separated list. Other omitted text fields default to empty strings.

```console
$ etude --db /tmp/etude-doc/db.json add --id GEO-1 --user-prompt 'Capital of France?' --expected Paris --agent-assisted false --tags geography
{"id":"GEO-1","atom":{"user_prompt":"Capital of France?","agent_prompt":null,"expected":["Paris"],"agent_assisted":false,"tags":["geography"],"topic":"","source":"","created":"2026-07-23","archived":false,"state":"new","streak":0,"lapses":0,"last_rating":null,"last_seen":null,"due":null,"notes":"","attempts":[]}}
```

### `edit`

**Synopsis:** `etude [--db PATH] edit ID [--set field=value ...] [--archive | --unarchive]`

`--set` is repeatable. Values that parse as JSON become the corresponding bool, null, number, list, or object; other values remain strings. Dot-separated fields update nested objects. `widget_data` is the optional structured object exposed to widget templates; for matching pairs, set `widget_data.pairs` to `[left, right]` tuples. Archiving never deletes the atom.

```console
$ etude --db /tmp/etude-doc/db.json edit MATH-1 --set notes=reviewed --archive
{"id":"MATH-1","atom":{"user_prompt":"Explain why 2 + 2 = 4.","agent_prompt":"Accept any concise arithmetic explanation.","expected":[],"agent_assisted":null,"tags":["math","arithmetic"],"topic":"Addition","source":"","created":"2026-07-23","archived":true,"state":"learning","streak":1,"lapses":0,"last_rating":2,"last_seen":"2026-07-23T21:20:13-07:00","due":"2026-07-25T21:20:13-07:00","notes":"reviewed","attempts":[{"ts":"2026-07-23T21:20:13-07:00","rating":2,"mode":"spaced-repetition","variant":null,"variant_prompt":null,"answer":"Because addition combines two pairs.","feedback":"Correct.\n","via":"chat"}]}}
```

### `queue list`

**Synopsis:** `etude [--db PATH] queue list`

```console
$ etude --db /tmp/etude-doc/db.json queue list
{"queues":[{"label":"Review","algorithm":"manual","members":["MATH-1","GEO-1"],"order":["GEO-1","MATH-1"],"status":"active","agent_assisted":null,"agent_instructions":"Be concise.","created":"2026-07-23","deadline":null,"notes":"","id":"review"}]}
```

### `queue show`

**Synopsis:** `etude [--db PATH] queue show Q`

```console
$ etude --db /tmp/etude-doc/db.json queue show review
{"id":"review","queue":{"label":"Review","algorithm":"manual","members":["MATH-1","GEO-1"],"order":["GEO-1","MATH-1"],"status":"active","agent_assisted":null,"agent_instructions":"Be concise.","created":"2026-07-23","deadline":null,"notes":""}}
```

### `queue create`

**Synopsis:** `etude [--db PATH] queue create Q --label LABEL --algorithm NAME [--members ID ...] [--agent-assisted true|false] [--agent-instructions TEXT] [--deadline ISO] [--notes TEXT]`

The algorithm and every initial member must already exist.

```console
$ etude --db /tmp/etude-doc/db.json queue create review --label Review --algorithm manual --members MATH-1 GEO-1 --agent-instructions 'Be concise.'
{"id":"review","queue":{"label":"Review","algorithm":"manual","members":["MATH-1","GEO-1"],"order":[],"status":"active","agent_assisted":null,"agent_instructions":"Be concise.","created":"2026-07-23","deadline":null,"notes":""}}
```

### `queue edit`

**Synopsis:** `etude [--db PATH] queue edit Q [--set field=value ...] [--archive | --unarchive]`

Coercion and dotted fields follow `edit`. Use JSON for arrays such as manual order.

```console
$ etude --db /tmp/etude-doc/db.json queue edit review --set 'order=["GEO-1","MATH-1"]'
{"id":"review","queue":{"label":"Review","algorithm":"manual","members":["MATH-1","GEO-1"],"order":["GEO-1","MATH-1"],"status":"active","agent_assisted":null,"agent_instructions":"Be concise.","created":"2026-07-23","deadline":null,"notes":""}}
```

### `queue archive`

**Synopsis:** `etude [--db PATH] queue archive Q`

Sets `status` to `archived`; it does not delete the queue or members.

```console
$ etude --db /tmp/etude-doc/db.json queue archive review
{"id":"review","queue":{"label":"Review","algorithm":"manual","members":["GEO-1","MATH-1"],"order":["GEO-1"],"status":"archived","agent_assisted":null,"agent_instructions":"Be concise.","created":"2026-07-23","deadline":null,"notes":""}}
```

### `queue add-members`

**Synopsis:** `etude [--db PATH] queue add-members Q ID [ID ...]`

Adds existing atoms once, preserving current member order.

```console
$ etude --db /tmp/etude-doc/db.json queue add-members review MATH-1
{"id":"review","queue":{"label":"Review","algorithm":"manual","members":["GEO-1","MATH-1"],"order":["GEO-1"],"status":"active","agent_assisted":null,"agent_instructions":"Be concise.","created":"2026-07-23","deadline":null,"notes":""}}
```

### `queue remove-members`

**Synopsis:** `etude [--db PATH] queue remove-members Q ID [ID ...]`

Removes IDs from both `members` and manual `order`; atoms themselves remain untouched.

```console
$ etude --db /tmp/etude-doc/db.json queue remove-members review MATH-1
{"id":"review","queue":{"label":"Review","algorithm":"manual","members":["GEO-1"],"order":["GEO-1"],"status":"active","agent_assisted":null,"agent_instructions":"Be concise.","created":"2026-07-23","deadline":null,"notes":""}}
```

### `algorithms list`

**Synopsis:** `etude [--db PATH] algorithms list`

Returns built-in and declarative registry entries under `algorithms`; each has its registry `name` injected.

```console
$ etude --db /tmp/etude-doc/db.json algorithms list
{"algorithms":[{"label":"Spaced repetition","description":"Due, then new, then wrap-around.","builtin":true,"name":"fsrs"},{"label":"Oldest first","description":"Oldest-created members first.","builtin":true,"name":"oldest-first"},{"label":"Newest first","description":"Newest-created members first.","builtin":true,"name":"newest-first"},{"label":"Weakest first","description":"Lowest mastery first.","builtin":true,"name":"weakest-first"},{"label":"Least practiced","description":"Fewest attempts first.","builtin":true,"name":"least-practiced"},{"label":"Manual","description":"Explicit queue order, then remaining members.","builtin":true,"name":"manual"},{"label":"Random","description":"Deterministic seeded shuffle when a seed is supplied.","builtin":true,"name":"random"},{"label":"By ID","order":[{"key":"id","dir":"asc"}],"name":"by-id"}]}
```

### `algorithms add`

**Synopsis:** `etude [--db PATH] algorithms add NAME --spec-file FILE`

The UTF-8 file must contain a valid declarative algorithm JSON object. `-` reads stdin. Existing names are not overwritten.

```console
$ etude --db /tmp/etude-doc/db.json algorithms add by-id --spec-file algorithm.json
{"name":"by-id","algorithm":{"label":"By ID","order":[{"key":"id","dir":"asc"}]}}
```

### `stats`

**Synopsis:** `etude [--db PATH] stats [--queue Q] [--tags a,b] [--days N]`

- `--queue Q`: restrict to materialized queue membership.
- `--tags a,b`: restrict to atoms matching any listed tag.
- `--days N`: positive lookback for rating distribution and per-day attempts.

Coverage is `seen / total`. Mastery is the mean of `min(streak, 3) / 3`; unseen atoms contribute zero. Archived atoms are excluded.

```console
$ etude --db /tmp/etude-doc/db.json stats --queue review --days 30
{"stats":{"total":2,"seen":2,"coverage":1.0,"mastery":0.3333333333333333,"rating_distribution":{"0":0,"1":0,"2":1,"3":1},"attempts_per_day":{"2026-07-23":2}}}
```

### `inbox list`

**Synopsis:** `etude [--db PATH] inbox list`

```console
$ etude --db /tmp/etude-doc/db.json inbox list
{"inbox":[]}
```

### `inbox clear`

**Synopsis:** `etude [--db PATH] inbox clear [--id N]`

Without `--id`, clears every inbox entry. `--id N` removes the zero-based entry index only.

```console
$ etude --db /tmp/etude-doc/db.json inbox clear
{"cleared":0,"inbox":[]}
```

### `serve`

**Synopsis:** `etude [--db PATH] serve [--port PORT]`

`--port` defaults to 2600. The command lazily imports `etude.server`, emits one startup JSON object, and delegates to the blocking server main loop. If the module is unavailable, it emits a JSON error instead. Stop with Ctrl-C.

```console
$ etude --db /tmp/etude-doc/db.json serve --port 27654
{"status":"starting","handler":"etude.server","port":27654}
```

That real example was health-checked at `/api/db` and then stopped; no server was left running.

### `validate`

**Synopsis:** `etude [--db PATH] validate`

Returns exhaustive schema errors and warnings. Validation errors produce exit 1; warnings alone do not.

```console
$ etude --db /tmp/etude-doc/db.json validate
{"errors":[],"warnings":[]}
```

For CI/manual use, `python3.11 scripts/validate.py [--db PATH]` is a thin wrapper with the same output and exit-code behavior.

### `migrate-v2`

**Synopsis:** `etude [--db PATH] migrate-v2 --from PATH`

Lazily imports `etude.migrate_v2`. `--from` is the source v2 DB and the globally resolved DB is the output. The migration implementation handles validation, atomic save, and backup behavior. A missing migration module produces a JSON error.

```console
$ etude --db /tmp/etude-doc/migrated.json migrate-v2 --from /tmp/etude-doc/v2.json
{"counts":{"atoms":0,"attempts":0,"queues":0,"algorithms":0},"fields_renamed":{"prompt_to_user_prompt":0,"answer_to_agent_prompt":0,"type_dropped":0,"attempt_via_added":0},"validation":{"errors":[],"warnings":[]},"dry_run":false}
```

### `edit-meta`

**Synopsis:** `etude [--db PATH] edit-meta key=value [key=value ...]`

Assignments use the same JSON coercion and dotted-path rules as `edit`. This supports fields such as `default_theme` and `tag_instructions` while preserving unknown metadata.

```console
$ etude --db /tmp/etude-doc/db.json edit-meta 'tag_instructions={"math":"Show reasoning."}' default_theme=everforest
{"meta":{"app":"etude","schema_version":3,"rating_scale":{"0":"fail","1":"hard","2":"good","3":"easy"},"scheduler":{"presets":{"standard":{"fail_minutes":1440,"interval_minutes":[2880,7200,17280,43200],"cap_minutes":43200},"exam-horizon":{"fail_minutes":90,"interval_minutes":[120,480,1320]}},"selection":"queue deadline <7d => exam-horizon, capped at deadline; else standard"},"queue_algorithms":{"fsrs":{"label":"Spaced repetition","description":"Due, then new, then wrap-around.","builtin":true},"oldest-first":{"label":"Oldest first","description":"Oldest-created members first.","builtin":true},"newest-first":{"label":"Newest first","description":"Newest-created members first.","builtin":true},"weakest-first":{"label":"Weakest first","description":"Lowest mastery first.","builtin":true},"least-practiced":{"label":"Least practiced","description":"Fewest attempts first.","builtin":true},"manual":{"label":"Manual","description":"Explicit queue order, then remaining members.","builtin":true},"random":{"label":"Random","description":"Deterministic seeded shuffle when a seed is supplied.","builtin":true}},"tag_instructions":{"math":"Show reasoning."},"default_theme":"everforest"}}
```

## HTTP API

Start the stdlib server with `etude --db /path/to/db.json serve --port 2600` or `python -m etude.server --db /path/to/db.json --port 2600`, then set `BASE=http://127.0.0.1:2600`. It reloads the DB on every request and writes atomically, allowing CLI/server coexistence. JSON errors are `{"error":"…"}`. Every `/api/*` response has `Access-Control-Allow-Origin: *`.

Samples below are real responses observed from the test fixture on 2026-07-23. Long objects show only explicitly noted fields; no values are invented.

### Dashboard and widgets

#### `GET /`, `GET /app.js`, `GET /style.css`

```sh
curl -i "$BASE/"
```

Serves `dashboard/index.html` as `text/html`; JavaScript is `text/javascript` and CSS is `text/css`. The observed body begins `<!DOCTYPE html><html lang="en">`.

#### `GET /widgets/{template}?queue=Q&theme=T&n=N`

`queue` is required for queue-scoped and drill templates; `theme` defaults to `meta.default_theme`; `n` defaults to 20. Queue-free widgets use their own selectors: `recent-items?limit=N`, `streaks?days=N`, and `atom-card?atom=ID`. `recent-items` returns unique practiced atoms ordered by their latest attempt, newest first, and defaults to 10 rows. Template/theme names may omit `.html`/`.css` but must match directory entries (no traversal). `~/.etude/widgets/` files override repository files; the old `~/.etude/applets/` path is a lower-priority compatibility source. Atoms follow `etude.algorithms.order`. The server injects the selected theme, `widgets/shadcn.css`, the payload, and the resize bridge. Every drill atom includes `id`, `user_prompt`, `topic`, and `tags`, plus canonical `widget_data` when present. Deterministic queue payloads also include `expected`; agent payloads never do. The matching-pairs template consumes `atom.widget_data.pairs`; the flashcard template uses the `true-false` tag to render direct binary controls. `/applets/{template}` remains an alias for old links; new integrations use `/widgets/{template}`.

```sh
curl "$BASE/widgets/flashcard-drill?queue=agent&theme=everforest&n=1"
```

Observed injected data (the ephemeral test port varies):

```json
{"api":"http://127.0.0.1:43817","queue":"agent","queue_label":"Agent queue","mode":"agent","atoms":[{"id":"AG-2","user_prompt":"Explain TCP","topic":"Topic","tags":["network"]}],"stats":{"total":1,"seen":0,"mastery":0.0,"per_queue":[{"id":"det","label":"Deterministic queue","total":1,"seen":0,"mastery":0.0},{"id":"agent","label":"Agent queue","total":1,"seen":0,"mastery":0.0}],"per_day":[{"date":"2026-06-24","count":0}],"days":30,"rating_dist":{"0":0,"1":0,"2":0,"3":0}}}
```

The actual `per_day` array contains all 30 consecutive dates; one observed entry is shown.

### Database and atoms

#### `GET /api/db`

```sh
curl "$BASE/api/db"
```

Returns the complete DB unchanged, including unknown keys. Observed extension data: `{"future_extension":{"preserved":true}}` alongside full `meta`, `atoms`, and `queues`.

#### `GET /api/atoms?queue=&tags=&tags_all=&state=&archived=&q=`

Returns an array with `id` added. `tags=a,b` is OR; `tags_all=a,b` is AND; `archived` accepts true/false. Free text is case-insensitive over ID, prompt, topic, and tags, with all words required.

```sh
curl "$BASE/api/atoms?tags_all=geo,exam&archived=false&q=france"
```

```json
[{"id":"DET-1","user_prompt":"Capital of France?","agent_prompt":"Reference answer.","agent_assisted":false,"expected":["Paris"],"tags":["geo","exam"],"topic":"Topic","archived":false,"state":"new","streak":0,"lapses":0,"last_rating":null,"last_seen":null,"due":null,"attempts":[]}]
```

#### `GET /api/atoms/{id}`

```sh
curl "$BASE/api/atoms/DET-1"
```

```json
{"id":"DET-1","user_prompt":"Capital of France?","agent_prompt":"Reference answer.","agent_assisted":false,"expected":["Paris"],"tags":["geo","exam"],"topic":"Topic","archived":false,"state":"new","streak":0,"lapses":0,"last_rating":null,"last_seen":null,"due":null,"attempts":[]}
```

#### `POST /api/atoms`

`id` and `user_prompt` are required. Schema rules require `agent_prompt` for agent-assisted atoms and `expected` for deterministic atoms. Optional `widget_data` must be an object. The old input name `applet_data` is accepted and normalized to `widget_data`; sending both is rejected. Scheduler fields receive new-atom defaults; unknown input fields are rejected.

```sh
curl -X POST "$BASE/api/atoms" -H 'Content-Type: application/json' -d '{"id":"NEW-4","user_prompt":"2 + 2?","agent_assisted":false,"expected":"4","topic":"Arithmetic"}'
```

```json
{"id":"NEW-4","user_prompt":"2 + 2?","tags":[],"created":"2026-07-23","archived":false,"state":"new","streak":0,"lapses":0,"last_rating":null,"last_seen":null,"due":null,"notes":"","attempts":[],"agent_assisted":false,"expected":"4","topic":"Arithmetic"}
```

Success: `201 Created`.

#### `PATCH /api/atoms/{id}`

Shallow-merges allowed fields, validates the resulting DB, and preserves unknown existing keys.

```sh
curl -X PATCH "$BASE/api/atoms/NEW-4" -H 'Content-Type: application/json' -d '{"notes":"keep me"}'
```

```json
{"id":"NEW-4","user_prompt":"2 + 2?","tags":[],"created":"2026-07-23","archived":false,"state":"new","streak":0,"lapses":0,"last_rating":null,"last_seen":null,"due":null,"notes":"keep me","attempts":[],"agent_assisted":false,"expected":"4","topic":"Arithmetic"}
```

### Queues

#### `GET /api/queues`

Each queue gains computed top-level `member_count`, `seen`, and `mastery` (mean `min(streak,3)/3`, unseen included as zero).

```sh
curl "$BASE/api/queues"
```

```json
[{"id":"det","label":"Deterministic queue","algorithm":"manual","members":["DET-1"],"order":["DET-1"],"status":"active","agent_assisted":false,"deadline":null,"member_count":1,"seen":0,"mastery":0.0}]
```

#### `POST /api/queues`

`id` is required. Defaults: label=`id`, algorithm=`fsrs`, empty membership/order, active status. The algorithm and members are schema-validated.

```sh
curl -X POST "$BASE/api/queues" -H 'Content-Type: application/json' -d '{"id":"new","label":"New queue","algorithm":"manual","members":["NEW-4"],"order":["NEW-4"],"agent_assisted":false}'
```

```json
{"id":"new","label":"New queue","algorithm":"manual","members":["NEW-4"],"order":["NEW-4"],"status":"active","created":"2026-07-23","deadline":null,"notes":"","agent_assisted":false}
```

#### `PATCH /api/queues/{id}`

```sh
curl -X PATCH "$BASE/api/queues/new" -H 'Content-Type: application/json' -d '{"notes":"updated"}'
```

```json
{"id":"new","label":"New queue","algorithm":"manual","members":["NEW-4"],"order":["NEW-4"],"status":"active","created":"2026-07-23","deadline":null,"notes":"updated","agent_assisted":false}
```

#### `GET /api/queues/{id}/next?n=N`

`n` defaults to 1. Returns algorithm-ordered IDs and prompts.

```sh
curl "$BASE/api/queues/new/next?n=1"
```

```json
[{"id":"NEW-4","user_prompt":"2 + 2?"}]
```

### Attempts

#### `POST /api/attempts`

Required: `atom_id`, string `answer`. Optional: `via` (default `widget`), `mode` (default `widget`), `rating`, `feedback`, `variant`, `variant_prompt`, offset-aware `ts`, and queue disambiguator `queue`. Legacy `via=applet` or `mode=applet` is accepted and stored as `widget`. Agent-assisted atoms require rating 0–3. Without a rating, deterministic atoms use `scheduler.check_expected` to compute 3/0 and force empty feedback. The server appends the attempt, calls `scheduler.apply_attempt`, and returns the recorded attempt plus scheduler state.

```sh
curl -X POST "$BASE/api/attempts" -H 'Content-Type: application/json' -d '{"atom_id":"DET-1","answer":"  paris ","via":"widget","ts":"2026-07-23T12:00:00+00:00"}'
```

```json
{"attempt":{"ts":"2026-07-23T12:00:00+00:00","rating":3,"mode":"widget","variant":null,"variant_prompt":null,"answer":"  paris ","feedback":"","via":"widget"},"scheduler":{"state":"learning","streak":1,"lapses":0,"last_rating":3,"last_seen":"2026-07-23T12:00:00+00:00","due":"2026-07-28T12:00:00+00:00"}}
```

Agent-assisted observed response:

```sh
curl -X POST "$BASE/api/attempts" -H 'Content-Type: application/json' -d '{"atom_id":"AG-2","answer":"SYN, SYN-ACK, ACK","rating":2,"feedback":"Good.","via":"chat","mode":"spaced-repetition","ts":"2026-07-23T12:00:00+00:00"}'
```

```json
{"attempt":{"ts":"2026-07-23T12:00:00+00:00","rating":2,"mode":"spaced-repetition","variant":null,"variant_prompt":null,"answer":"SYN, SYN-ACK, ACK","feedback":"Good.","via":"chat"},"scheduler":{"state":"learning","streak":1,"lapses":0,"last_rating":2,"last_seen":"2026-07-23T12:00:00+00:00","due":"2026-07-25T12:00:00+00:00"}}
```

### Statistics

#### `GET /api/stats?queue=Q&days=N`

Queue is optional; `days` defaults to 30. Returns scoped totals, seen, mastery, queue summaries, consecutive per-day activity, and rating distribution.

```sh
curl "$BASE/api/stats?queue=new&days=2"
```

```json
{"total":1,"seen":0,"mastery":0.0,"per_queue":[{"id":"det","label":"Deterministic queue","total":1,"seen":0,"mastery":0.0},{"id":"agent","label":"Agent queue","total":1,"seen":0,"mastery":0.0},{"id":"new","label":"New queue","total":1,"seen":0,"mastery":0.0}],"per_day":[{"date":"2026-07-22","count":0},{"date":"2026-07-23","count":0}],"days":2,"rating_dist":{"0":0,"1":0,"2":0,"3":0}}
```

### Inbox

#### `GET /api/inbox`

```sh
curl "$BASE/api/inbox"
```

```json
[{"atom_id":"AG-2","payload":{"matches":[["a","b"]]},"ts":"2026-07-23T12:00:00+00:00"}]
```

#### `POST /api/inbox`

Requires exactly existing `atom_id`, arbitrary `payload`, and offset-aware `ts`; appends to `inbox.json`.

```sh
curl -X POST "$BASE/api/inbox" -H 'Content-Type: application/json' -d '{"atom_id":"AG-2","payload":{"matches":[["a","b"]]},"ts":"2026-07-23T12:00:00+00:00"}'
```

```json
{"index":0,"atom_id":"AG-2","payload":{"matches":[["a","b"]]},"ts":"2026-07-23T12:00:00+00:00"}
```

#### `DELETE /api/inbox/{index}`

```sh
curl -X DELETE "$BASE/api/inbox/0"
```

```json
{"atom_id":"AG-2","payload":{"matches":[["a","b"]]},"ts":"2026-07-23T12:00:00+00:00"}
```

### Live events

#### `GET /api/events`

Watches DB and inbox mtimes. Changes emit `data: reload`; idle clients receive `: ping` about every 1.5 seconds.

```sh
curl -N "$BASE/api/events"
```

```text
: ping

data: reload

```
