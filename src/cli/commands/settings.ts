import { DEFAULT_SETTINGS, type Settings } from "../../core/engine.ts";
import { command, group, CliError } from "../registry.ts";
import { deepDelete, deepGet, deepSet, looseValue, splitPair } from "../input.ts";

group({ name: "settings", summary: "App settings: AI providers and models, day start, learn-ahead", defaultVerb: "get" });

/** Settings with the API key status (never the keys themselves). */
function view(e: any) {
  const s: Settings = e.settings();
  const envs = [s.ai.decision?.apiKeyEnv, s.ai.feedback?.apiKeyEnv, s.ai.vision?.apiKeyEnv].filter(Boolean) as string[];
  return { ...s, keyStatus: Object.fromEntries(envs.map((k) => [k, !!process.env[k]])), dbPath: e.path, mediaDir: e.mediaDir };
}

command({
  name: "settings get",
  summary: "Current settings, or one dotted key. Key values are never printed: only whether each key's env var is set.",
  args: [{ name: "key", description: "Dotted key, e.g. ai.feedback.model." }],
  flags: [{ name: "defaults", type: "boolean", description: "Show the built-in defaults instead." }],
  examples: ["etude settings", "etude settings get ai.feedback.model"],
  run(ctx) {
    const s = ctx.flags.defaults ? DEFAULT_SETTINGS : view(ctx.e);
    if (!ctx.args.key) return s;
    const v = deepGet(s, ctx.args.key);
    if (v === undefined) throw new CliError(`no setting "${ctx.args.key}"`, "not_found");
    return { key: ctx.args.key, value: v };
  },
});

command({
  name: "settings set",
  summary: "Change settings with dotted key=value pairs (JSON values when they parse).",
  description:
    "Examples of keys: dayStartHour, learnAheadMinutes, ai.autoFeedback (ai-graded|always|never), ai.language, ai.decision (null disables the decision model), ai.decision.model, ai.feedback.model, ai.feedback.url, ai.feedback.apiKeyEnv, ai.vision. API keys themselves live in the environment or $ETUDE_HOME/.env, never in settings.",
  args: [{ name: "pairs", description: "key=value pairs.", required: true, variadic: true }],
  writes: true,
  dryRun: true,
  examples: ["etude settings set dayStartHour=4", "etude settings set ai.feedback.model=deepseek/deepseek-v4.1-flash-1017", "etude settings set ai.decision=null"],
  output: "{ changed: { key: { from, to } }, settings }",
  run(ctx) {
    const e = ctx.e;
    const cur = e.settings() as any;
    const next = structuredClone(cur);
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    for (const p of ctx.args.pairs) {
      const [k, raw] = splitPair(p, "key=value");
      if (/apiKey$|secret|token/i.test(k) && !/Env$/.test(k)) throw new CliError(`refusing to store a secret in settings; put it in the environment or ${ctx.home}/.env and set ${k}Env instead`, "validation");
      const top = k.split(".")[0];
      if (!(top in cur)) throw new CliError(`unknown setting "${top}" (settings: ${Object.keys(cur).join(", ")})`, "validation");
      const v = looseValue(raw);
      const parent = k.split(".").slice(0, -1).join(".");
      if (parent && deepGet(next, parent) === null) {
        // Re-enabling a provider that was null: start from its default.
        const def = deepGet(DEFAULT_SETTINGS, parent);
        if (def && typeof def === "object") deepSet(next, parent, structuredClone(def));
      }
      changed[k] = { from: deepGet(cur, k) ?? null, to: v };
      deepSet(next, k, v);
    }
    const saved = e.updateSettings({ ...next, ai: next.ai });
    return { changed, settings: saved };
  },
});

command({
  name: "settings unset",
  summary: "Reset dotted keys to their defaults.",
  args: [{ name: "keys", description: "Dotted keys.", required: true, variadic: true }],
  writes: true,
  dryRun: true,
  examples: ["etude settings unset ai.feedback.model dayStartHour"],
  run(ctx) {
    const e = ctx.e;
    const next = structuredClone(e.settings()) as any;
    for (const k of ctx.args.keys) {
      const def = deepGet(DEFAULT_SETTINGS, k);
      if (def === undefined) {
        if (!deepDelete(next, k)) throw new CliError(`no setting "${k}"`, "not_found");
      } else deepSet(next, k, structuredClone(def));
    }
    return { reset: ctx.args.keys, settings: e.updateSettings(next) };
  },
});

command({
  name: "settings test-ai",
  summary: "Grade a fixed sample answer with the configured providers, to check keys and models. Costs a fraction of a cent.",
  output: "{ verdict?, verdictError?, feedback?, feedbackError? }",
  run: (ctx) => ctx.e.testAi(),
});
