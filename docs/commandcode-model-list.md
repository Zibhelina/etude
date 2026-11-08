# Plan: Command Code plan model list in the chat picker

## Goal
The Ask Etude / Minimi model picker currently shows a single entry for Command Code, `commandcode:` (blank model = Command Code's default). The user wants the **full list of models their GO plan can actually use** to pick from in the chat, the same way ChatGPT, OpenRouter and Custom already appear as selectable groups.

## Source of truth for model ids
Command Code's upstream model catalog is **not** a runtime API (`cmd --list-models` returns a plain-text list; parse it defensively, don't depend on JSON). The canonical Go-plan set lives in the `command-code-knowledge` skill's `reference/models.md` (Open Source + Stealth + Anthropic + OpenAI + Google + Sakana + Meta + xAI, tagged "Go and above", plus the Live-model-catalog ids kind in the SKILL.md frontmatter). Etude must **not** hardcode the full catalog — it changes often, and a stale picker is worse than `cmd`'s own rejection at turn time. The rule is: the provider resolves models via `cmd --list-models` at runtime (cached, timeout-guarded, failure-safe), parses what's actually usable, and maps parse output to the existing `commandcode:<model>` ref shape.

## How it works

### `src/core/commandcode.ts` (transport helpers only — do NOT duplicate here)
- Add `listCommandCodeModels(opts?: { timeoutMs?: number }): Promise<string[]>`:
  - spawn the same binary as `commandCodeBinaryPath()` with `--list-models`,
  - collect stdout, parse ids defensively (one id per line, skip empty/noise/{json-like} lines; keep obvious `provider/model` and bare ids),
  - return unique, ordered ids; throw `AiError` only if the binary errors (caller decides whether to fall back).
- Keep `commandCodePresent`, `cmdcodeModelName`, `DEFAULT_CMDCODE_TIMEOUT_MS` where they are. New helper name is `listCommandCodeModels` — grep `commandcode` in `src/core/` for the single-spawn-site rule.

### `src/core/agent.ts`
- `models()` — extend the existing Command Code group block (currently line 460-462, single model):
  - try `listCommandCodeModels(fb?.kind === "commandcode" ? fb : undefined)`,
  - on success, set `group.models = ids.map(id => ({ ref: \`commandcode:${id}\`, name: id }))` (name = the id itself; no vision — `cmd` runs text-only, images dropped already),
  - prepend a `(default)` entry `{ ref: "commandcode:", name: cmdcodeModelName(fb) }` so the existing blank-model meaning is preserved,
  - on failure, set `group.error = err.message` and keep the default-only entry so the provider still appears,
  - also let `commandCodePresent()` stay as the gate (binary on PATH), not the list call.
- `resolveModel` already routes any `commandcode:<model>` — **no change** needed there except confirming an unlisted but valid `commandcode:<id>` still works (it does — ref parsing is open-ended).
- `feedbackRef()` returns `commandcode:<model>` (model may be empty today — after this change it will be a real id; confirm the Settings/AI UI shows it in `cmdcodeModelName`).
- `configured()` already true when `cmd` present — unchanged.

### Web (`web/src/lib/agent.ts`, `web/src/components/agent-panel.tsx`, `web/src/components/settings-ai.tsx`)
- No model-list shape change: `ModelGroup.models` already is `{ ref, name, vision? }[]`; the picker renders any number of models per group with search (ChatGPT/OpenRouter groups prove it).
- Verify the picker search/overflow caps (`g.models.slice(0, 50..60)`) don't hide Go models; bump the slice for `commandcode` if it would — a model list of this size (>60) needs the full group rendered, not truncated.
- Settings AI block: model field already accepts any id; no change.

### CLI & docs
- `src/cli/commands/agent.ts` — `--model` help text already lists `commandcode:<model>`; confirm the `agent models` command output picks up the new group automatically (it renders `agent.models(true)`).
- Regenerate `docs/cli.md` via `node scripts/gen-cli-docs.ts`.
- Update `docs/agent.md` Command Code row (mention `--list-models`) and `docs/commandcode-provider.md` (model-list source + the "don't list everything" rule).

## Testing
- `test/commandcode.test.ts` — extend the fake-bin: `listCommandCodeModels` parses `cmd --list-models` text output into ids; failure yields no ids; timeout produces an error.
- `test/agent.test.ts` — the `messages` test can use a `commandcode:<id>` model ref; existing `models()` / `configured()` tests still pass.
- `npm run typecheck` (root `tsconfig.json` + `web/tsconfig.json`).
- `npm run build` — then `etude agent models` CLI smoke + open Ask Etude and pick a listed model.

## Step ordering
1. `src/core/commandcode.ts` — `listCommandCodeModels` + its tests (fake `cmd --list-models`).
2. `src/core/agent.ts` — `models()` group expansion with `group.models` + `group.error`.
3. Verify picker renders all Go models (`agent-panel.tsx` slice check; bump if needed).
4. `npm run typecheck`, `npm test`, `npm run build`.
5. Smoke: `etude agent models` shows Command Code ids; `etude agent ask` with a picked id returns a reply.
6. Docs: `docs/agent.md`, `docs/commandcode-provider.md`, regenerate `docs/cli.md`.

## Key assumptions
- `cmd --list-models` on this box lists id-per-line output (docs say "List the models available for use"); parse is defensive — any unrecognised line is skipped, never fatal.
- The binary is the standalone CLI (`npm i -g command-code`); the desktop AppImage swallows flags (see `docs/commandcode-provider.md` Caveats). Never spawn with `--yolo`.
- The user's plan is the **GO tier**; only models tagged Go-and-above are listed. The full catalog lives upstream at https://commandcode.ai/docs — never hardcode it into the app.
- No streaming changes: the turn still coalesces into one `finalText` per subprocess; only the picker gains entries (tool rows / confirmations / snapshots untouched).
- Sync is a non-goal: no new commands, only the models fetch + picker display.
