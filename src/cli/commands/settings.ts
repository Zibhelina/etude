import { DEFAULT_SETTINGS, type Settings } from "../../core/engine.ts";
import { chatGptStatus, chatGptLogout, listChatGptModels, openInBrowser, beginChatGptLogin, readChatGptHostId, importChatGptCredentials, ChatGptError } from "../../core/chatgpt.ts";
import { chatProviderKeyEnv } from "../../core/ai.ts";
import { agentSettingRefusal } from "../../core/agent-guard.ts";
import { EnvKeyError, setEnvKey } from "../../core/env-file.ts";
import { AVATAR_CHARACTERS, AVATAR_EMOJI_BG } from "../../core/avatar.ts";
import { BANNER_PRESETS } from "../../core/banner.ts";
import { command, group, CliError } from "../registry.ts";
import { deepDelete, deepGet, deepSet, looseValue, splitPair } from "../input.ts";

group({ name: "settings", summary: "App settings: AI providers and models, day start, learn-ahead, ChatGPT sign-in", defaultVerb: "get" });

/** Settings with the API key status (never the keys themselves). */
function view(e: any) {
  const s: Settings = e.settings();
  const envs = [s.ai.decision?.apiKeyEnv, chatProviderKeyEnv(s.ai.feedback), chatProviderKeyEnv(s.ai.vision)].filter(Boolean) as string[];
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
    "Examples of keys: dayStartHour, learnAheadMinutes, ai.autoFeedback (ai-graded|always|never), ai.language, ai.decision (null disables the decision model), ai.decision.model, ai.feedback.model, ai.feedback.url, ai.feedback.apiKeyEnv, ai.vision, onboarding.level (simple|standard|tinker), onboarding.done, fun (true shows Minimi, the mascot; false keeps the plain ε), minimi (Minimi's personality in your words; empty keeps his usual one), minimiFace (the face he wears: deadpan, wink, proud, smug, hi, wand, close, curious, reading, sleepy, shocked or thinking), accent (the app's accent over any theme: green, teal, blue, violet, pink, red, orange, amber, graphite, a #rrggbb color, or null for the theme's own), avatar (your picture: {kind:\"char\",id}, {kind:\"emoji\",e,bg}, {kind:\"photo\",media}, or null for your initial; see `etude settings avatar`), banner (the cover behind your picture: a preset id like sky or night, image:files/<sha>.<ext>[:y], or null to match your picture; see `etude settings banner`), name (your name in the app, up to 40 characters; empty uses the account's). API keys themselves live in the environment or $ETUDE_HOME/.env (see `etude settings key set`), never in settings.",
  args: [{ name: "pairs", description: "key=value pairs.", required: true, variadic: true }],
  writes: true,
  dryRun: true,
  examples: ["etude settings set dayStartHour=4", "etude settings set ai.feedback.model=deepseek/deepseek-v4.1-flash-1017", "etude settings set ai.decision=null", "etude settings set accent=blue", "etude settings set banner=night"],
  output: "{ changed: { key: { from, to } }, settings }",
  run(ctx) {
    const e = ctx.e;
    const cur = e.settings() as any;
    const next = structuredClone(cur);
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    for (const p of ctx.args.pairs) {
      const [k, raw] = splitPair(p, "key=value");
      const refused = ctx.agent ? agentSettingRefusal(k) : null;
      if (refused) throw new CliError(refused, "validation");
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
      const refused = ctx.agent ? agentSettingRefusal(k) : null;
      if (refused) throw new CliError(refused, "validation");
      const def = deepGet(DEFAULT_SETTINGS, k);
      if (def === undefined) {
        if (!deepDelete(next, k)) throw new CliError(`no setting "${k}"`, "not_found");
      } else deepSet(next, k, structuredClone(def));
    }
    return { reset: ctx.args.keys, settings: e.updateSettings(next) };
  },
});

// --------------------------------------------------------- your picture

command({
  name: "settings avatar get",
  summary: "Your picture, and the characters you can pick from.",
  description: "The picture shows next to your name in the sidebar and Settings. null means the first letter of your name.",
  examples: ["etude settings avatar get"],
  output: "{ avatar, characters: [{ id, name }] }",
  run: (ctx) => ({ avatar: ctx.e.settings().avatar, characters: AVATAR_CHARACTERS }),
});

command({
  name: "settings avatar set",
  summary: "Pick your picture: a character, an emoji on a colour, a photo, or your initial.",
  description:
    `The value is a character id (see \`etude settings avatar get\`), \`emoji:<emoji>\` (with --bg, default ${AVATAR_EMOJI_BG}), \`photo:<file>\` (a local image, copied into the collection's media so Sync carries it; the app crops photos to a 256 px circle, the CLI keeps the file as it is) or \`initial\`.`,
  args: [{ name: "value", description: "fox, emoji:🦊, photo:~/me.webp or initial.", required: true }],
  flags: [{ name: "bg", type: "string", description: "The emoji's background, #rrggbb.", placeholder: "COLOR" }],
  writes: true,
  dryRun: true,
  examples: ["etude settings avatar set fox", "etude settings avatar set emoji:🦊 --bg '#24726e'", "etude settings avatar set photo:./me.webp", "etude settings avatar set initial"],
  output: "{ from, to }",
  run(ctx) {
    const e = ctx.e;
    const from = e.settings().avatar;
    const raw = String(ctx.args.value).trim();
    let value: unknown = raw;
    if (raw.startsWith("emoji:")) value = { kind: "emoji", e: raw.slice(6), bg: ctx.flags.bg ?? AVATAR_EMOJI_BG };
    else if (raw.startsWith("photo:") && !/^photo:(media:)?files\//.test(raw)) {
      const m = e.importMedia(raw.slice(6), { dryRun: ctx.dry });
      if (m.kind !== "image") throw new CliError("a photo must be an image file", "validation");
      value = { kind: "photo", media: m.file };
    }
    const to = e.updateSettings({ avatar: value as any }).avatar;
    return { from, to };
  },
});

// --------------------------------------------------------- your banner

command({
  name: "settings banner get",
  summary: "Your banner (the cover behind your picture) and the colours and patterns it can be. null matches your picture.",
  examples: ["etude settings banner get"],
  output: "{ banner, presets: [{ id, bg, pattern }] }",
  run: (ctx) => ({ banner: ctx.e.settings().banner, presets: BANNER_PRESETS.map(({ id, bg, pattern }) => ({ id, bg, pattern })) }),
});

command({
  name: "settings banner set",
  summary: "Set your banner: a preset, an image of your own, or match (follow your picture).",
  description:
    "The value is a preset id (see `etude settings banner get`), `image:<file>` (a local image, copied into the collection's media so Sync carries it; --y sets where it sits, 0 top to 100 bottom, default 50) or `match`. The app downscales uploaded images to 1600 px wide; the CLI keeps the file as it is.",
  args: [{ name: "value", description: "Preset id, image:<file> or match.", required: true }],
  flags: [{ name: "y", type: "string", description: "For an image: vertical position, 0 (top) to 100 (bottom)." }],
  writes: true,
  dryRun: true,
  examples: ["etude settings banner set night", "etude settings banner set image:./cover.jpg --y 30", "etude settings banner set match"],
  output: "{ from, to }",
  run(ctx) {
    const e = ctx.e;
    const from = e.settings().banner;
    const raw = String(ctx.args.value).trim();
    let value: unknown = raw;
    const y = ctx.flags.y === undefined ? undefined : Number(ctx.flags.y);
    if (raw.startsWith("image:")) {
      let media = raw.slice(6).replace(/^media:/, "");
      if (!/^files\//.test(media)) {
        const m = e.importMedia(media, { dryRun: ctx.dry });
        if (m.kind !== "image") throw new CliError("a banner image must be an image file", "validation");
        media = m.file;
      }
      value = { kind: "image", media, y: y ?? 50 };
    }
    const to = e.updateSettings({ banner: value as any }).banner;
    return { from, to };
  },
});

command({
  name: "settings test-ai",
  summary: "Grade a fixed sample answer with the configured providers, to check keys and models. Costs a fraction of a cent.",
  output: "{ verdict?, verdictError?, feedback?, feedbackError? }",
  run: (ctx) => ctx.e.testAi(),
});

command({
  name: "settings onboarding",
  summary: "Whether first-run setup would show (not done and no decks yet), and the comfort level picked there.",
  description:
    "Setup shows only while onboarding.done is false and the collection has no decks; a collection with decks is marked done when this is read, so existing users never see it. Settings → About → Run setup again opens it on any collection. The level (simple|standard|tinker) only changes what setup offers.",
  examples: ["etude settings onboarding", "etude settings set onboarding.level=tinker", "etude settings set onboarding.done=false"],
  output: "{ done, level, show, decks }",
  run: (ctx) => ctx.e.onboardingStatus(),
});

// --------------------------------------------------------- API keys

command({
  name: "settings key set",
  summary: "Save one API key to $ETUDE_HOME/.env (owner-only), read from stdin so it never appears in the shell history.",
  description:
    "The name is the environment variable the settings point at (ai.feedback.apiKeyEnv, ai.decision.apiKeyEnv), e.g. OPENROUTER_API_KEY or OPENAI_API_KEY. Other lines in the file are kept. A running server picks the key up when it is set through Settings; one started earlier needs a restart to see a key set here.",
  args: [{ name: "name", description: "Variable name: capital letters, digits and _, at most 64.", required: true }],
  writes: true,
  noDb: true,
  examples: ["printf %s \"$KEY\" | etude settings key set OPENROUTER_API_KEY", "etude settings key set OPENAI_API_KEY < key.txt"],
  output: "{ name, set: true, path }",
  run(ctx) {
    const value = ctx.stdin().trim();
    if (!value) throw new CliError("pipe the key on stdin (it is never taken as an argument); use `etude settings key unset` to remove one", "usage");
    return keyResult(() => setEnvKey(ctx.home, ctx.args.name, value, ctx.env));
  },
});

command({
  name: "settings key unset",
  summary: "Remove one API key from $ETUDE_HOME/.env.",
  args: [{ name: "name", description: "Variable name.", required: true }],
  writes: true,
  noDb: true,
  examples: ["etude settings key unset OPENAI_API_KEY"],
  output: "{ name, set: false, path }",
  run: (ctx) => keyResult(() => setEnvKey(ctx.home, ctx.args.name, null, ctx.env)),
});

function keyResult(fn: () => { name: string; set: boolean; path: string }) {
  try {
    return fn();
  } catch (e) {
    if (e instanceof EnvKeyError) throw new CliError(e.message, "validation");
    throw e;
  }
}

// --------------------------------------------------------- ChatGPT plan

const statusView = (home: string) => ({ ...chatGptStatus(home), hostId: readChatGptHostId(home) });
const chatgptError = (e: unknown) => (e instanceof ChatGptError ? new CliError(e.message, "external") : e);

command({
  name: "settings chatgpt login",
  summary: "Sign in with ChatGPT, so grading uses the user's ChatGPT Plus or Pro plan instead of an API key.",
  description:
    "Opens OpenAI's sign-in page in the system browser and waits for the loopback callback on 127.0.0.1. The browser must run on this machine: a 127.0.0.1 callback never reaches a server on another host. Tokens are saved to $ETUDE_HOME/chatgpt.json with owner-only permissions.",
  flags: [
    { name: "no-open", type: "boolean", description: "Don't launch a browser; the URL is printed instead." },
    { name: "timeout", type: "number", description: "Seconds to wait for the callback. Default 600." },
  ],
  noDb: true,
  writes: true,
  examples: ["etude settings chatgpt login", "etude settings chatgpt login --no-open"],
  output: "{ signedIn, email, plan, clientId, hostId, credentialsPath, opened }",
  async run(ctx) {
    try {
      const session = await beginChatGptLogin({ home: ctx.home, timeoutMs: (Number(ctx.flags.timeout) || 600) * 1000 });
      ctx.note(`Open this URL to finish signing in:\n${session.url}`);
      const opened = ctx.flags["no-open"] ? false : openInBrowser(session.url);
      if (!opened) ctx.note("Couldn't open a browser; open the URL above on this machine.");
      await session.wait;
      return { ...statusView(ctx.home), opened };
    } catch (e) {
      throw chatgptError(e);
    }
  },
});

command({
  name: "settings chatgpt status",
  summary: "Whether this install is signed in with ChatGPT, for which account, and whether plan usage is granted.",
  noDb: true,
  examples: ["etude settings chatgpt status"],
  output: "{ signedIn, email, plan, planType, expiresAt, needsReauth, usageUrl, credentialsPath, hostId }",
  run: (ctx) => statusView(ctx.home),
});

command({
  name: "settings chatgpt logout",
  summary: "End the ChatGPT session and delete the saved tokens. The app registration is kept for a later sign-in.",
  writes: true,
  noDb: true,
  examples: ["etude settings chatgpt logout"],
  output: "{ signedIn: false, revoked, warning?, email, clientId, hostId, credentialsPath }",
  async run(ctx) {
    const out = await chatGptLogout(ctx.home).catch((e) => {
      throw chatgptError(e);
    });
    return { ...out, ...statusView(ctx.home) };
  },
});

command({
  name: "settings chatgpt models",
  summary: "The models the signed-in ChatGPT account offers for plan usage (slug and display name).",
  noDb: true,
  examples: ["etude settings chatgpt models"],
  output: "{ models: [{ slug, displayName }] }",
  async run(ctx) {
    const models = await listChatGptModels(ctx.home).catch((e) => {
      throw chatgptError(e);
    });
    return { models };
  },
});

command({
  name: "settings chatgpt import",
  summary: "Adopt a chatgpt.json signed in on another machine (the self-hosted-VM path). This host gets its own host id.",
  args: [{ name: "file", description: "The credential file copied from the other machine.", required: true }],
  writes: true,
  noDb: true,
  examples: ["scp laptop:~/.etude/chatgpt.json /tmp/ && etude settings chatgpt import /tmp/chatgpt.json"],
  output: "{ signedIn, email, hostId, credentialsPath, plan }",
  run(ctx) {
    try {
      const imported = importChatGptCredentials(ctx.home, ctx.args.file);
      return { ...imported, ...statusView(ctx.home) };
    } catch (e) {
      if (e instanceof ChatGptError) throw new CliError(e.message, "validation");
      throw e;
    }
  },
});
