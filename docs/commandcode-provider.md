# Command Code provider for Ask Etude (Minimi)

**Date:** 2026-11-08
**Commit prefix:** `agent:`
**Status:** Implemented, 506 tests passing, typecheck clean. **Write-up last touched:**
2026-11-08 (cleanup: helpers single-sourced in `commandcode.ts`, doc refresh for the
`agent models` summary and the stale `web/dist` note; the smoke test now works first-try —
`cmd -p "say hi"` → 2.5s, `etude agent ask "say hi in 3 words"` → saved conversation with
model `"cmd (default model)"`, ~3.5s per turn).

## Why

The user's Etude AI setup is a **Command Code GO subscription (`cmd login`)**, which is only
usable through the Command Code CLI. Etude's Minimi / "Ask Etude" chat previously only routed
through ChatGPT-plan (HTTP Responses API), OpenRouter, or any OpenAI-compatible endpoint
(OpenAI, local servers). None of those know about a `cmd login` session.

This project adds a **`commandcode`** provider kind that answers one assistant turn by spawning
headless `cmd -p` locally. The GO subscription usage, the login, and every turn stay on the
laptop — nothing is uploaded to a third-party endpoint.

## What changed (and where)

### Provider shape (`src/core/ai.ts`)
- New interface `CommandCodeProvider { kind: "commandcode"; model: string; timeoutMs?: number }`
  (model = the id passed to `cmd -p --model`; empty means Command Code's default).
- `ChatProvider` is now `OpenAiChatProvider | ChatGptProvider | CommandCodeProvider`.
- `chat()` gains a `commandcode` branch that proxies grading (text-only) to
  `commandCodeTurn`. Image answers are **rejected** with an `AiError` — the vision provider
  must be OpenAI-compatible (grading fallback path is unchanged).

### The subprocess transport (`src/core/commandcode.ts`, new)
- `commandCodeTurn(provider, system, messages, signal)`:
  - builds one query string via `buildQuery` (`System: …\n\nUser: …\n\nAssistant: …`),
  - spawns `$ETUDE_CMDCODE_BIN` (`cmd`-equivalent binary; default `cmd`) with
    `-p <query> --output-format json [--model <id>]`,
  - parses the **last** result line's `finalText` (NDJSON) via `parseFinalText`,
  - never passes `--yolo` (headless writes stay blocked),
  - timeout = `provider.timeoutMs ?? 300_000`, `-1000` ms is the floor in the UI; a Stop
    signal (`signal`) kills the child with `SIGTERM`.
- `DEFAULT_CMDCODE_TIMEOUT_MS = 300_000` (5 minutes per subprocess call).
- Bin override: `ETUDE_CMDCODE_BIN` env var, else the literal `cmd`; tests fake the binary with
  a node one-liner and set that env var.
- `listCommandCodeModels()` — spawns `cmd --list-models` (15s timeout, same binary), parses
  `parseModelList(out)`: group headers (`Open Source`, `Anthropic`, …) are skipped, id +
  description lines are kept, footers (`Pass the full id`, `Docs:`, `Decision models`) and
  noise are dropped; the `(default)` suffix sets the `default` flag. This is the **only**
  source of model ids — never hardcode the catalog (it changes upstream;
  `reference/models.md` in the Command Code skill is prose, not data).

### Agent wiring (`src/core/agent-llm.ts`, `src/core/agent.ts`)
- `llmTurn` now routes `commandcode` to `commandCodeCmdTurn`, which:
  - packs tool-call artifacts as `[tool calls: name(args), …]` lines into the prompt,
  - calls `commandCodeTurn`, streams the whole reply through `onText` once, returns with
    `toolCalls: []` — one turn = one subprocess; **tool rows, confirmations, snapshots and
    undo all run unchanged in `Agent.send`** because `execFilePromise` never touches Etude
    writes itself.
- `resolveModel` accepts `commandcode:<model>` (empty model = default). `feedbackRef` returns
  `commandcode:<model>`. `models()` adds a **Command Code** group when `cmd` is on `PATH`
  (`commandCodePresent`) or when the feedback provider already is `commandcode`, with the
  `commandcode:` (default) entry first followed by every id from `listCommandCodeModels()`;
  a failed list sets `group.error` and keeps the default-only entry so the group still appears.
- `configured()` also returns true when `cmd` is present.
- Images are dropped for commandcode (`provider.kind === "commandcode" ? [] : …`).

### Settings UI (`web/src/components/settings-model.ts`, `settings-ai.tsx`,
`pages/settings.tsx`, `onboarding.tsx`, `web/src/lib/agent.ts`)
- `PresetId` gained `"commandcode"`; `presetAi("commandcode")` sets
  `{ kind: "commandcode", model: "", timeoutMs: 300000 }`; `matchPreset` detects it.
- `Backend type ChatProvider` mirrors the server shape; `isCommandCode` guard; validation is
  timeout-only (1–600 s); the Block in Settings shows **Model** (empty = default) and
  **Timeout** fields. `PRESETS`, `PRESET_LABEL`, `PRESET_NAME` and the settings summary got the
  new row. `ModelGroup.provider` now includes `"commandcode"`.

### CLI (`src/cli/commands/agent.ts`)
- `--model` help now lists `commandcode:<model>`.

### Docs
- `docs/agent.md`: models table row for Command Code + the new ref shape.
- `docs/cli.md`: regenerated (`node scripts/gen-cli-docs.ts` — included).
- This file.

## Design constraints kept

- **Minimi's persona / system prompt untouched** (`src/core/minimi.ts`,
  `src/core/agent.ts` `systemPrompt`) — the same instructions go into the `cmd -p` query.
- **Safety gates unchanged**: destructive commands still show dry-run + Allow/Deny;
  snapshot/undo (last 10), `AGENT_DENY` list, agent-guard (attached-file vs settings
  restrictions), and `~/.etude/agent-*` storage are all identical.
- **Grading is not special-cased**: text grading can also use commandcode; images cannot.
- **No sync / no new commands**: only a provider kind + UI. Existing provider contracts
  (`feedback`, `vision`, `decision`) keep working exactly as before.
- **Env key handling unchanged**: no key for commandcode; `COMMAND_CODE_API_KEY` is honored
  by `cmd -p` itself if present, per its docs.

## Testing

- `test/commandcode.test.ts` (new, 6 tests): `parseFinalText` ordering/garbage tolerance,
  `buildQuery` shape, `commandCodeTurn` against a fake node one-liner (happy path), non-zero
  exit → `AiError` with stderr, missing binary → error names the binary, and verifies the
  default timeout. Plus `parseModelList` (skips noise/footers, `(default)` flag) and
  `listCommandCodeModels` happy-path + missing-binary cases.
- Full suite: `npm test` → 509 tests (508 pass, 1 skip pre-existing). `npm run typecheck`
  clean (`tsconfig.json` + `web/tsconfig.json`).

## Verification

```sh
npm run build      # regenerate web/dist so the preset row appears
npm start          # open http://127.0.0.1:4610
# Settings → AI grading → "Command Code" preset

# Or directly:
./node_modules/.bin/etude settings set ai.feedback.kind=commandcode ai.feedback.model=
./node_modules/.bin/etude agent ask "hi"
```

## Caveats a future agent should know

- The binary must really be the **standalone CLI** (`npm i -g command-code`).
  The desktop AppImage's Electron shell swallows `-p` args and prints nothing; pointing
  `ETUDE_CMDCODE_BIN` at it will silently succeed with empty output, or at best fail with a
  confusing error. `cmd` on `PATH` is the contract.
- Headless `cmd -p` is explicitly blocked from writes/shell by Command Code's default.
  Never add `--yolo` to the spawn — Etude's own tool rows are the only write path, and
  passing `--yolo` would drop the confirm gate the plan depends on.
- Replies are **not streamed token-by-token** over the wire (`onText` fires once with the
  whole `finalText`) — the UI shows the reply after the subprocess exits. This is inherent
  to `cmd -p --output-format json`.
- `toolCalls` from `commandCodeCmdTurn` is always `[]` — Etude never executes tool calls a
  headless `cmd` would make; it only renders `finalText` as the reply. Multi-step agent
  behavior still works because `Agent.send` re-renders the accumulated history into each
  subsequent subprocess query.

## If the repo gets updated (future agent)

Run this when `main` moves under you (rebase, upstream PR changes, new provider kinds,
refactored `agent.ts`):

1. `npm test` — if a new provider kind lands, `test/commandcode.test.ts` must still pass and
   `test/agent.test.ts`'s resolve/confirm/undo assertions unchanged. The full suite is 506
   tests today; any new provider that adds a `ChatProvider` branch will need a similar
   `commandCodePresent` / `cmdcodeModelName` treatment in `src/core/commandcode.ts` —
   **single source of truth**: keep provider-specific helpers there, never duplicate them
   in `agent.ts`/`ai.ts` (they were initially duplicated and were refactored up).
2. `npm run typecheck` — `tsconfig.json` (server/CLI) + `web/tsconfig.json`. The union
   `ChatProvider` appears in `src/core/ai.ts` and `web/src/components/settings-model.ts`;
   both must stay in sync. A new kind breaks exhaustive `switch`/ternary chains on
   `feedback.kind` — `tsc` will point at them (search for `kind === "chatgpt"` /
   `kind === "openai-chat"`).
3. `node scripts/gen-cli-docs.ts` then `npm test` — `test/cli-docs.test.ts` fails when
   `docs/cli.md` is stale; always regenerate after changing any command flag/summary
   (e.g. the `agent models` summary now names Command Code).
4. `npm run build` — regenerates `web/dist`. The server serves the checked-in bundle
   (`web/dist`), so a fresh build is required for any Settings/model-picker change to
   appear; a bare `npm start` will serve the old bundle and the new row won't show.
5. `npm i -g command-code && cmd login` — `cmd` on `PATH` is the contract. The desktop
   AppImage is **not** a substitute (see Caveats). `ETUDE_CMDCODE_BIN` overrides the binary
   path for tests/CI; it is never set in production.
6. Smoke test: `./node_modules/.bin/etude settings set ai.feedback.kind=commandcode` then
   `etude agent ask "hi"` — a reply proves the spawn, NDJSON parse, and tool loop are intact.
   A destructive ask must still show Allow/Deny before anything runs.

### Where the logic lives (don't split it)

- `src/core/commandcode.ts` — the *only* place `cmd -p` is spawned: `commandCodeTurn`,
  `commandCodePresent`, `cmdcodeModelName`, `commandCodeBinaryPath`,
  `DEFAULT_CMDCODE_TIMEOUT_MS`.
- `src/core/agent-llm.ts` — `llmTurn` routes `commandcode` → `commandCodeCmdTurn`
  (renders tool artifacts into the prompt text, not into tool calls).
- `src/core/ai.ts` — grading `chat()` branch (rejects images).
- Web mirror: `web/src/components/settings-model.ts` + `settings-ai.tsx` (+ `settings.tsx`
  summary, `onboarding.tsx` label).
