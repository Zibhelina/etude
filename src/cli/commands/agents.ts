import { agentFor } from "../../core/agent.ts";
import { profileCommandRefusal } from "../../core/agent-guard.ts";
import { BRAIN_EFFORTS, CLIP_FILE_NAMES, CLIP_NAMES, clipProblem, type AgentBrain, type BrainPick, type AgentClips, type AgentProfile, type ClipRef } from "../../core/agent-profiles.ts";
import type { Etude } from "../../core/engine.ts";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { command, group, CliError, type Ctx } from "../registry.ts";

group({ name: "agents", summary: "Who you talk to in Ask: agent profiles with a name, a picture, a body, a personality and a brain", defaultVerb: "list" });

const PICTURE = "A local image (copied into the collection's media, so Sync carries it), `minimi` for Minimi's own art, or `none`.";

/** Only the user changes who they talk to: Ask Etude and `etude mcp` are refused, whatever the provider. */
function userOnly(ctx: Ctx, name: string) {
  if (ctx.agent || ctx.mcp) throw new CliError(profileCommandRefusal(name)!, "validation");
}

/** A picture flag as stored: minimi, null, a media file already in the collection, or a local file imported now. */
function picture(e: Etude, v: string | undefined, dry: boolean, body = false): string | null | undefined {
  if (v === undefined) return undefined;
  const s = v.trim();
  if (!s || s === "none" || s === "null") return null;
  if (s === "minimi") return s;
  if (/^(media:)?files\//.test(s)) return s.replace(/^media:/, "");
  const m = e.importMedia(s, { dryRun: dry });
  if (m.kind !== "image") throw new CliError(`${s} isn't an image`, "validation");
  if (body && !/\.(png|webp)$/.test(m.file)) throw new CliError("a body must be a transparent PNG or WebP", "validation");
  return m.file;
}

/** `--banner`: a picture of the user's, or none. */
function banner(e: Etude, v: string | undefined, dry: boolean): string | null | undefined {
  if (v?.trim() === "minimi") throw new CliError("a banner is a picture of your own (a file), or none", "validation");
  return picture(e, v, dry);
}

/**
 * `--clips <dir>`: the four clips from a folder, named as Minimi's are (read-loop, look-up, look-loop, look-down),
 * each as `<name>-248.webm` and `<name>-533.webm` or one `<name>.webm`; imported into the media. `none` removes them.
 */
function clips(e: Etude, v: string | undefined, dry: boolean): AgentClips | null | undefined {
  if (v === undefined) return undefined;
  const s = v.trim();
  if (!s || s === "none" || s === "null") return null;
  if (!existsSync(s) || !statSync(s).isDirectory()) throw new CliError(`${s} isn't a folder (give the folder with read-loop-248.webm, look-up-248.webm… or none)`, "not_found");
  const one = (file: string) => {
    const data = readFileSync(file);
    const why = clipProblem(data);
    if (why) throw new CliError(`${file}: ${why}`, "validation");
    return e.storeMedia(file.split(/[\\/]/).pop()!, data, { dryRun: dry }).file;
  };
  const out = {} as AgentClips;
  const missing: string[] = [];
  for (const k of CLIP_NAMES) {
    const base = join(s, CLIP_FILE_NAMES[k]);
    let r: ClipRef | null = null;
    if (existsSync(`${base}-248.webm`) && existsSync(`${base}-533.webm`)) r = { "248": one(`${base}-248.webm`), "533": one(`${base}-533.webm`) };
    else for (const f of [`${base}.webm`, `${base}-533.webm`, `${base}-248.webm`]) if (!r && existsSync(f)) r = one(f);
    if (r) out[k] = r;
    else missing.push(`${CLIP_FILE_NAMES[k]}-248.webm`);
  }
  if (missing.length) throw new CliError(`${s} has no ${missing.join(", ")} (each clip as <name>-248.webm and <name>-533.webm, or <name>.webm)`, "not_found");
  return out;
}

function personality(flags: Record<string, any>): string | undefined {
  if (flags["personality-file"] !== undefined) {
    try {
      return readFileSync(flags["personality-file"] === "-" ? 0 : flags["personality-file"], "utf8");
    } catch (e) {
      throw new CliError(`couldn't read ${flags["personality-file"]}: ${(e as Error).message}`, "not_found");
    }
  }
  return flags.personality;
}

const PROVIDERS = ["chatgpt", "openrouter", "custom"];

/**
 * The brain flags: `--external <agent id>` names an agent entry as is; `--hermes`, `--provider`/`--model`/`--effort`
 * are picks, as on the agent's card in Settings (Hermes gets the card's own entry on this device).
 */
function brain(flags: Record<string, any>, cur?: AgentBrain): { brain?: AgentBrain; pick?: BrainPick } {
  const modelish = flags.model !== undefined || flags.provider !== undefined || flags.effort !== undefined;
  const given = [flags.external !== undefined, flags.hermes !== undefined, modelish].filter(Boolean).length;
  if (given > 1) throw new CliError("give one brain: --external, --hermes, or --provider/--model/--effort", "usage");
  if (flags.external !== undefined) return { brain: { kind: "external", agent: String(flags.external) } };
  if (flags.hermes !== undefined) return { pick: { kind: "hermes", profile: String(flags.hermes) } };
  if (!modelish) return {};
  if (flags.provider !== undefined && !PROVIDERS.includes(String(flags.provider))) throw new CliError(`--provider must be ${PROVIDERS.join(", ")}`, "usage");
  if (flags.effort !== undefined && !BRAIN_EFFORTS.includes(flags.effort)) throw new CliError(`--effort must be one of ${BRAIN_EFFORTS.join(", ")}`, "usage");
  const old = cur?.kind === "model" ? cur : null;
  let model: string | null;
  if (flags.provider !== undefined) {
    if (flags.model === undefined || ["", "default", "null"].includes(String(flags.model))) throw new CliError("--provider needs --model <model> (e.g. --provider openrouter --model deepseek/deepseek-v4.1-flash-1017)", "usage");
    model = `${flags.provider}:${String(flags.model).replace(/^(chatgpt|openrouter|custom):/, "")}`;
  } else if (flags.model !== undefined) model = ["", "default", "null"].includes(String(flags.model)) ? null : String(flags.model);
  else model = old?.model ?? null;
  const effort = flags.effort ?? old?.effort;
  return { pick: { kind: "model", model, ...(effort ? { effort } : {}) } };
}

const SHAPE = "{ id, name, avatar, body, clips: { read, lookUp, look, lookDown } | null, banner, personality, brain: { kind: model, model, effort? } | { kind: external, agent, via?, hermes?, harnesses?: [{ agent, name }] }, default, available, note?, agentName?, setup?: { command, args, env?, via } }";
const redactSetup = (p: any, redact: boolean) =>
  redact && p?.setup?.env ? { ...p, setup: { ...p.setup, env: Object.fromEntries(Object.keys(p.setup.env).map((k) => [k, "[redacted]"])) } } : p;
const shown = (e: Etude, id: string, redact = false) => {
  const all = agentFor(e).profiles();
  const p = all.profiles.find((x) => x.id === id)!;
  return redactSetup({ ...p, default: all.default === p.id }, redact);
};

const editFlags = [
  { name: "avatar", type: "string" as const, description: `The round picture in the chat. ${PICTURE}`, placeholder: "FILE" },
  { name: "body", type: "string" as const, description: `The figure in the corner, a transparent PNG (shown at Minimi's size). ${PICTURE} Without one the corner shows the avatar in a round button.`, placeholder: "FILE" },
  { name: "clips", type: "string" as const, description: "Animate the body like Minimi's Christmas clips: a folder with read-loop, look-up, look-loop and look-down, each as -248.webm and -533.webm (or one .webm), VP9 with alpha, at most 4 MB each. The body picture shows until they play and where they can't (Safari, reduced motion). `none` removes them.", placeholder: "DIR" },
  { name: "banner", type: "string" as const, description: "What a new chat with it shows before the first message, in place of the greeting and ideas: a local image (copied into the collection's media, so Sync carries it), or `none` for the usual start.", placeholder: "FILE" },
  { name: "personality", type: "string" as const, description: "Who it is, in your words. For an external agent these go to it as your notes with each message.", placeholder: "TEXT" },
  { name: "personality-file", type: "string" as const, description: "Read the personality from a file (- for stdin).", placeholder: "FILE" },
  { name: "model", type: "string" as const, description: "Brain: a chat model Etude runs with its own tools (chatgpt:<model>, openrouter:<model>, custom:<model>, or just the model with --provider), or `default` for the default assistant model.", placeholder: "REF" },
  { name: "provider", type: "string" as const, description: "Brain: which provider --model is from: chatgpt, openrouter or custom.", placeholder: "PROVIDER" },
  { name: "effort", type: "string" as const, description: "How long a model brain thinks before acting: default, minimal, low, medium or high.", placeholder: "EFFORT" },
  { name: "hermes", type: "string" as const, description: "Brain: Hermes with one of its profiles, run on this computer as `hermes -p <profile> acp`. Personality and memory come from Hermes.", placeholder: "PROFILE" },
  { name: "external", type: "string" as const, description: "Brain: an existing entry in this computer's ai.agents, by id (advanced; --hermes sets one up for you).", placeholder: "AGENT" },
  { name: "harness", type: "string" as const, multiple: true, description: "For an external brain: a harness it can also run in, as Name=agent (an entry in ai.agents), picked per chat in the message box. Repeat for several, list its own agent too to name it (Hermes=tutor), or `none` to keep only its own agent.", placeholder: "NAME=AGENT" },
];

/** `--harness Hermes=tutor --harness Antigravity=tutor-agy` → the list; `none` → empty. */
function harnesses(v: unknown): { agent: string; name: string }[] | undefined {
  const list = (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).map(String);
  if (!list.length) return undefined;
  if (list.length === 1 && list[0] === "none") return [];
  return list.map((x) => {
    const i = x.lastIndexOf("=");
    if (i <= 0 || i === x.length - 1) throw new CliError(`--harness takes Name=agent (e.g. Antigravity=tutor-agy), not "${x}"`, "usage");
    return { name: x.slice(0, i).trim(), agent: x.slice(i + 1).trim() };
  });
}

command({
  name: "agents list",
  summary: "Your agent profiles, Minimi first, with the default one marked.",
  description: "An external agent's profile is `available: false` on a device where that agent isn't set up (the agents list itself never syncs).",
  examples: ["etude agents", "etude agents list"],
  output: `{ default, profiles: [${SHAPE}] }`,
  run(ctx) {
    const redact = !!(ctx.agent || ctx.mcp);
    const all = agentFor(ctx.e).profiles();
    return { default: all.default, profiles: all.profiles.map((p) => redactSetup({ ...p, default: p.id === all.default }, redact)) };
  },
});

command({
  name: "agents show",
  summary: "One agent profile.",
  args: [{ name: "id", description: "Profile id (minimi, tutor…).", required: true }],
  output: SHAPE,
  run(ctx) {
    return shown(ctx.e, ctx.e.agentProfile(ctx.args.id).id, !!(ctx.agent || ctx.mcp));
  },
});

command({
  name: "agents add",
  summary: "Add someone to talk to in Ask: a name, pictures, a personality and a brain.",
  description: "The id comes from the name unless --id is given. Brains: --hermes <profile> (Hermes on this computer; the command it runs stays on this device and never syncs), --provider chatgpt|openrouter|custom --model <m> [--effort <e>], or --external <agent id>. Without any, the default assistant model.",
  args: [{ name: "name", description: "What the chat calls it, up to 40 characters.", required: true }],
  flags: [{ name: "id", type: "string", description: "Its id (lowercase letters, digits, dashes).", placeholder: "ID" }, ...editFlags, { name: "default", type: "boolean", description: "Make it the default for new chats and the corner." }],
  writes: true,
  dryRun: true,
  examples: ["etude agents add Tutor --avatar ~/tutor.png --body ~/tutor-body.png --clips ~/tutor-clips --hermes tutor --personality-file notes.md --default", "etude agents add Coach --provider openrouter --model deepseek/deepseek-v4.1-flash-1017 --effort low --personality \"A patient tutor.\""],
  output: SHAPE,
  run(ctx) {
    userOnly(ctx, "agents add");
    const e = ctx.e;
    const b = brain(ctx.flags);
    const p = e.addAgentProfile(
      { id: ctx.flags.id, name: ctx.args.name, avatar: picture(e, ctx.flags.avatar, ctx.dry) ?? null, body: picture(e, ctx.flags.body, ctx.dry, true) ?? null, clips: clips(e, ctx.flags.clips, ctx.dry) ?? null, banner: banner(e, ctx.flags.banner, ctx.dry) ?? null, personality: personality(ctx.flags) ?? "", brain: b.brain },
      { makeDefault: !!ctx.flags.default, clipsChecked: ctx.dry },
    );
    if (b.pick) e.setAgentBrain(p.id, b.pick);
    const hs = harnesses(ctx.flags.harness);
    if (hs) e.setAgentHarnesses(p.id, hs);
    return shown(e, p.id);
  },
});

command({
  name: "agents edit",
  summary: "Change an agent profile: its name, pictures, clips, banner, personality or brain. Minimi too.",
  description: "A new --body that isn't a picture (none, minimi) takes the clips away too; clips need a body picture.",
  args: [{ name: "id", description: "Profile id.", required: true }],
  flags: [{ name: "name", type: "string", description: "A new name.", placeholder: "NAME" }, ...editFlags],
  writes: true,
  dryRun: true,
  examples: ["etude agents edit minimi --personality \"Speaks only in haiku.\"", "etude agents edit tutor --avatar ~/tutor-v2.png", "etude agents edit tutor --clips ~/tutor-clips", "etude agents edit tutor --clips none", "etude agents edit tutor --banner ~/tutor-banner.png", "etude agents edit coach --model default", "etude agents edit tutor --provider openrouter --model deepseek/deepseek-v4.1-flash-1017", "etude agents edit tutor --hermes tutor", "etude agents edit minimi --effort medium", "etude agents edit tutor --harness Hermes=tutor --harness Antigravity=tutor-agy"],
  output: SHAPE,
  run(ctx) {
    userOnly(ctx, "agents edit");
    const e = ctx.e;
    const b = brain(ctx.flags, e.agentProfile(ctx.args.id).brain);
    const patch: Partial<Omit<AgentProfile, "id">> = { name: ctx.flags.name, avatar: picture(e, ctx.flags.avatar, ctx.dry), body: picture(e, ctx.flags.body, ctx.dry, true), clips: clips(e, ctx.flags.clips, ctx.dry), banner: banner(e, ctx.flags.banner, ctx.dry), personality: personality(ctx.flags), brain: b.brain };
    const hs = harnesses(ctx.flags.harness);
    if (Object.values(patch).every((v) => v === undefined) && !b.pick && !hs) throw new CliError("nothing to change: give --name, --avatar, --body, --clips, --banner, --personality, --hermes, --provider/--model/--effort, --external or --harness", "usage");
    const id = Object.values(patch).some((v) => v !== undefined) ? e.editAgentProfile(ctx.args.id, patch, { clipsChecked: ctx.dry }).id : e.agentProfile(ctx.args.id).id;
    if (b.pick) e.setAgentBrain(id, b.pick);
    if (hs) e.setAgentHarnesses(id, hs);
    return shown(e, id);
  },
});

command({
  name: "agents duplicate",
  summary: "Copy an agent profile under a new name.",
  args: [{ name: "id", description: "Profile id to copy.", required: true }],
  flags: [{ name: "name", type: "string", description: "The copy's name (default: \"<name> copy\").", placeholder: "NAME" }],
  writes: true,
  dryRun: true,
  output: SHAPE,
  run(ctx) {
    userOnly(ctx, "agents duplicate");
    return shown(ctx.e, ctx.e.duplicateAgentProfile(ctx.args.id, ctx.flags.name).id);
  },
});

command({
  name: "agents remove",
  summary: "Remove an agent profile. Minimi can't be removed. Its chats stay and continue with Minimi.",
  args: [{ name: "id", description: "Profile id.", required: true }],
  writes: true,
  dryRun: true,
  confirm: true,
  output: "{ removed, default }",
  run(ctx) {
    userOnly(ctx, "agents remove");
    return ctx.e.removeAgentProfile(ctx.args.id);
  },
});

command({
  name: "agents permission",
  summary: "How much Ask asks before it acts: before every change, only before what could do harm, or never.",
  description: "`ask`: every change waits for a yes. `dangerous` (the default): only deletes, resets and, for an external agent, commands, deletes and edits to sensitive files. `allow`: nothing is asked. It covers every chat on this collection. An external agent (Hermes, Claude Code) only asks about what it treats as needing a yes itself; Etude answers those for you under `dangerous` and `allow`. Without a level, prints the current one.",
  args: [{ name: "level", description: "ask, dangerous or allow." }],
  writes: true,
  examples: ["etude agents permission", "etude agents permission ask", "etude agents permission allow"],
  output: "{ permission }",
  run(ctx) {
    const a = agentFor(ctx.e);
    if (ctx.args.level === undefined) return { permission: a.permission() };
    userOnly(ctx, "agents permission");
    return { permission: a.setPermission(ctx.args.level) };
  },
});

command({
  name: "agents default",
  summary: "Make a profile the default: new chats start with it and its body sits in the corner.",
  args: [{ name: "id", description: "Profile id.", required: true }],
  writes: true,
  dryRun: true,
  examples: ["etude agents default tutor", "etude agents default minimi"],
  output: "{ default }",
  run(ctx) {
    userOnly(ctx, "agents default");
    return ctx.e.setDefaultAgentProfile(ctx.args.id);
  },
});
