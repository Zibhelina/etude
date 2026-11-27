// Agent profiles: who the user talks to in Ask. Each has a name, a round picture, an optional body for the
// corner, a personality in the user's words and a brain: a chat model Etude runs with its own tools, or an
// external agent (ACP) from this device's `ai.agents`. Minimi is the first, built in; his personality is still
// stored in `settings.minimi`, so older versions and `etude settings get minimi` keep working.
// Pure definitions and checks, shared by the engine, the CLI and the web app.

import { MINIMI_MAX } from "./minimi.ts";
import { ACP_PRESETS, type AcpAgentDef } from "./acp-agents.ts";

export const MINIMI_PROFILE_ID = "minimi";
/** At most this many profiles, Minimi included. */
export const PROFILES_MAX = 24;
export const PROFILE_NAME_MAX = 40;
export const PROFILE_PERSONALITY_MAX = MINIMI_MAX;

/** Reasoning effort for a model brain (the same values as `ai.agent.effort`). */
export type BrainEffort = "default" | "minimal" | "low" | "medium" | "high";
export const BRAIN_EFFORTS: BrainEffort[] = ["default", "minimal", "low", "medium", "high"];
/** What an external brain is, so another device can offer to set it up. Never a command: that stays in this device's `ai.agents`. */
export type ExternalVia = "hermes" | "antigravity" | "gemini" | "claude" | "codex" | "custom";
const VIAS: ExternalVia[] = ["hermes", "antigravity", "gemini", "claude", "codex", "custom"];
/** Built-in ACP harnesses an external profile can toggle on or off in Settings and switch between in Ask. */
export const HARNESS_PRESETS = ["hermes", "antigravity", "claude", "codex", "gemini"] as const;
export type HarnessPresetId = (typeof HARNESS_PRESETS)[number];

/** Display label for a built-in external preset ("Hermes", "Antigravity", "Claude Code", "Codex", "Gemini CLI"). */
export function viaLabel(via: ExternalVia | undefined, fallback: string): string {
  if (!via || via === "custom") return fallback;
  return ACP_PRESETS.find((p) => p.id === via)?.label ?? fallback;
}

export type AgentBrain =
  | { kind: "model"; model: string | null; effort?: BrainEffort }
  | { kind: "external"; agent: string; via?: ExternalVia; hermes?: string; harnesses?: Harness[] };

/**
 * One of the programs an external profile can run in: the same someone (name, pictures, memory of its own),
 * a different harness, such as Hermes, Antigravity, Claude Code, Codex or Gemini CLI. `agent` is an entry
 * in this device's `ai.agents`; the brain's own `agent` is the one a new chat starts in.
 */
export interface Harness {
  agent: string;
  /** What the picker calls it ("Hermes", "Antigravity", "Claude Code", "Codex", "Gemini CLI"). */
  name: string;
}
export const HARNESSES_MAX = 6;

/** The harnesses a profile can run in, its own agent first; empty when it has only that one. */
export function harnessesOf(b: AgentBrain): Harness[] {
  if (b.kind !== "external" || !b.harnesses?.length) return [];
  const own = b.harnesses.find((h) => h.agent === b.agent) ?? { agent: b.agent, name: viaLabel(b.via, b.agent) };
  return [own, ...b.harnesses.filter((h) => h.agent !== b.agent)];
}

/** A body's clips, like Minimi's Christmas ones: reading in a loop, looking up, looking at you in a loop, looking back down. */
export const CLIP_NAMES = ["read", "lookUp", "look", "lookDown"] as const;
export type ClipName = (typeof CLIP_NAMES)[number];
/** How the clip files are named in a folder (`read-loop-248.webm`, `look-up-533.webm`…), as Minimi's are. */
export const CLIP_FILE_NAMES: Record<ClipName, string> = { read: "read-loop", lookUp: "look-up", look: "look-loop", lookDown: "look-down" };
/** The video heights a clip may come in: the app plays the one closest above the size it's drawn at. */
export const CLIP_HEIGHTS = ["248", "533"] as const;
/** One clip: a WebM in the media ("files/<sha256>.webm"), or the same clip at 248 and 533 pixels tall. */
export type ClipRef = string | { "248": string; "533": string };
export type AgentClips = Record<ClipName, ClipRef>;
/** Each clip file is at most this big. */
export const CLIP_MAX_BYTES = 4 * 1024 * 1024;

export interface AgentProfile {
  /** Lowercase letters, digits and dashes. `minimi` is Minimi. */
  id: string;
  name: string;
  /** "minimi" (his faces), "files/<sha256>.<ext>" (a picture in the collection's media), or null (the name's first letter). */
  avatar: string | null;
  /** "minimi" (his drawn body, clips and all), "files/<sha256>.png|webp" (a transparent picture), or null (the round launcher). */
  body: string | null;
  /** The body as clips (VP9 with alpha), with `body` as the picture shown before they play and where they can't. */
  clips: AgentClips | null;
  /** What a new chat shows before the first message: a picture ("files/<sha256>.<ext>"), or null for the usual greeting and ideas. */
  banner: string | null;
  /** Free text in the user's words. Empty: Minimi's usual personality, or a plain friendly assistant. */
  personality: string;
  brain: AgentBrain;
}

export const MINIMI_PROFILE: AgentProfile = { id: MINIMI_PROFILE_ID, name: "Minimi", avatar: "minimi", body: "minimi", clips: null, banner: null, personality: "", brain: { kind: "model", model: null } };

/** A value that isn't a profile. The engine turns it into a validation error. */
export class ProfileError extends Error {}
const fail = (why: string): never => {
  throw new ProfileError(why);
};

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const AVATAR_FILE = /^files\/[0-9a-f]{64}\.(?:png|jpg|webp|gif|avif)$/;
const BODY_FILE = /^files\/[0-9a-f]{64}\.(?:png|webp)$/;
const CLIP_FILE = /^files\/[0-9a-f]{64}\.webm$/;
const MODEL_REF = /^(?:etude|chatgpt|openrouter|custom):\S.{0,199}$/;
export const HERMES_PROFILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** A chat model ref a model brain can name: etude:…, chatgpt:…, openrouter:…, custom:… */
export const isModelRef = (s: unknown): s is string => typeof s === "string" && MODEL_REF.test(s);

/** A free id for a new profile, from its name: tutor, tutor-2… */
export function profileId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const root =
    name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 28) || "agent";
  if (!used.has(root)) return root;
  for (let i = 2; ; i++) if (!used.has(`${root}-${i}`)) return `${root}-${i}`;
}

function picture(v: unknown, at: string, re: RegExp, what: string): string | null {
  if (v === null || v === undefined || v === "" || v === "none") return null;
  if (typeof v !== "string") return fail(`${at} must be text or null`);
  const s = v.trim().replace(/^media:/, "").replace(/^\/media\//, "");
  if (s === "minimi") return s;
  if (!re.test(s)) return fail(`${at} must be "minimi", null or ${what}, got "${s.slice(0, 40)}"`);
  return s;
}

/** A banner is always a picture of the user's: Minimi has no art for it. */
function bannerFile(v: unknown, at: string): string | null {
  const s = picture(v, at, AVATAR_FILE, "an image in the media (files/<sha256>.<ext>)");
  if (s === "minimi") return fail(`${at} must be null or an image in the media (files/<sha256>.<ext>)`);
  return s;
}

function clipFile(v: unknown, at: string): string {
  const s = typeof v === "string" ? v.trim().replace(/^media:/, "").replace(/^\/media\//, "") : "";
  if (!CLIP_FILE.test(s)) return fail(`${at} must be a WebM in the media (files/<sha256>.webm)`);
  return s;
}

function clips(v: unknown, at: string, body: string | null): AgentClips | null {
  if (v === null || v === undefined || v === "none") return null;
  if (typeof v !== "object" || Array.isArray(v)) return fail(`${at} must be { read, lookUp, look, lookDown } or null`);
  const c = v as Record<string, unknown>;
  const extra = Object.keys(c).filter((k) => !(CLIP_NAMES as readonly string[]).includes(k));
  if (extra.length) fail(`${at} has ${extra.join(", ")}; the clips are ${CLIP_NAMES.join(", ")}`);
  if (!body || body === "minimi") fail(`${at}: clips need a body picture too (it shows while they load and where they can't play)`);
  const out = {} as AgentClips;
  for (const k of CLIP_NAMES) {
    const r = c[k];
    if (r === undefined || r === null) return fail(`${at}.${k} is missing: a body animates with all four clips (${CLIP_NAMES.join(", ")})`);
    if (typeof r === "object" && !Array.isArray(r)) {
      const sizes = r as Record<string, unknown>;
      if (Object.keys(sizes).some((h) => !(CLIP_HEIGHTS as readonly string[]).includes(h))) fail(`${at}.${k} must be a file or { "248": file, "533": file }`);
      out[k] = { "248": clipFile(sizes["248"], `${at}.${k}.248`), "533": clipFile(sizes["533"], `${at}.${k}.533`) };
    } else out[k] = clipFile(r, `${at}.${k}`);
  }
  return out;
}

/** Every media file a clip set uses. */
export function clipFiles(c: AgentClips | null | undefined): string[] {
  if (!c) return [];
  return CLIP_NAMES.flatMap((k) => {
    const r = c[k];
    return typeof r === "string" ? [r] : [r["248"], r["533"]];
  });
}

/** The file for one clip at a height: the closest size, or its only one. */
export function clipSrc(r: ClipRef, height: "248" | "533"): string {
  return typeof r === "string" ? r : r[height];
}

/** Why some bytes aren't a clip the app can play (a WebM with VP9 and an alpha channel, at most 4 MiB), or null. */
export function clipProblem(data: Uint8Array): string | null {
  if (data.byteLength > CLIP_MAX_BYTES) return `it's ${(data.byteLength / 1048576).toFixed(1)} MB; a clip can be at most ${CLIP_MAX_BYTES / 1048576} MB`;
  const head = data.subarray(0, 65536);
  const has = (bytes: number[]) => {
    outer: for (let i = 0; i + bytes.length <= head.length; i++) {
      for (let j = 0; j < bytes.length; j++) if (head[i + j] !== bytes[j]) continue outer;
      return true;
    }
    return false;
  };
  const ascii = (t: string) => [...t].map((ch) => ch.charCodeAt(0));
  if (!(head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) || !has(ascii("webm"))) return "it isn't a WebM video";
  if (!has(ascii("V_VP9"))) return "it isn't VP9 (the only codec browsers draw with transparency)";
  // Matroska's AlphaMode element set to 1 (what ffmpeg writes for yuva420p).
  if (!has([0x53, 0xc0, 0x81, 0x01])) return "it has no alpha channel (encode with -pix_fmt yuva420p)";
  return null;
}

function brain(v: unknown, at: string): AgentBrain {
  if (v === null || v === undefined) return { kind: "model", model: null };
  if (typeof v !== "object" || Array.isArray(v)) return fail(`${at} must be { kind: "model", model } or { kind: "external", agent }`);
  const b = v as Record<string, unknown>;
  if (b.kind === "model") {
    const m = b.model === null || b.model === undefined || b.model === "" ? null : String(b.model).trim();
    if (m !== null && m.startsWith("agent:")) return fail(`${at}: an external agent is { kind: "external", agent: "${m.slice(6)}" }, not a model`);
    if (m !== null && !MODEL_REF.test(m)) return fail(`${at}.model must be chatgpt:<model>, openrouter:<model>, custom:<model> or null for the default`);
    const out: AgentBrain = { kind: "model", model: m };
    if (b.effort !== undefined && b.effort !== null) {
      if (!BRAIN_EFFORTS.includes(b.effort as BrainEffort)) return fail(`${at}.effort must be one of ${BRAIN_EFFORTS.join(", ")}`);
      out.effort = b.effort as BrainEffort;
    }
    return out;
  }
  if (b.kind === "external") {
    const a = String(b.agent ?? "").trim();
    if (!ID.test(a)) return fail(`${at}.agent must be the id of an agent in Settings → AI → Agents (lowercase letters, digits, dashes)`);
    const out: AgentBrain = { kind: "external", agent: a };
    if (b.via !== undefined && b.via !== null) {
      if (!VIAS.includes(b.via as ExternalVia)) return fail(`${at}.via must be one of ${VIAS.join(", ")}`);
      out.via = b.via as ExternalVia;
    }
    if (b.hermes !== undefined && b.hermes !== null && b.hermes !== "") {
      if (typeof b.hermes !== "string" || !HERMES_PROFILE.test(b.hermes)) return fail(`${at}.hermes must be a Hermes profile name (letters, digits, - _ .)`);
      out.hermes = b.hermes;
    }
    if (b.harnesses !== undefined && b.harnesses !== null) {
      if (!Array.isArray(b.harnesses)) return fail(`${at}.harnesses must be a list of { agent, name }`);
      if (b.harnesses.length > HARNESSES_MAX) return fail(`${at}.harnesses has more than ${HARNESSES_MAX}`);
      const seen = new Set<string>();
      const list: Harness[] = b.harnesses.map((h, i) => {
        const r = (h ?? {}) as Record<string, unknown>;
        const agent = String(r.agent ?? "").trim();
        const name = String(r.name ?? "").replace(/\s+/g, " ").trim();
        if (!ID.test(agent)) return fail(`${at}.harnesses[${i}].agent must be the id of an agent in Settings → AI → Agents`);
        if (!name || [...name].length > PROFILE_NAME_MAX) return fail(`${at}.harnesses[${i}].name must be 1 to ${PROFILE_NAME_MAX} characters`);
        if (seen.has(agent)) return fail(`${at}.harnesses lists "${agent}" twice`);
        seen.add(agent);
        return { agent, name };
      });
      if (list.length) out.harnesses = list;
    }
    return out;
  }
  return fail(`${at}.kind must be "model" or "external"`);
}

/**
 * Checks one profile. `personality` may be left out (kept as undefined), which for Minimi means "his stored one".
 */
export function checkProfile(raw: unknown, at = "profile"): Omit<AgentProfile, "personality"> & { personality?: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail(`${at} must be an object`);
  const p = raw as Record<string, unknown>;
  const id = String(p.id ?? "").trim();
  if (!ID.test(id)) fail(`${at}.id must be 1 to 32 lowercase letters, digits or dashes`);
  const name = String(p.name ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) fail(`${at}.name is empty`);
  if ([...name].length > PROFILE_NAME_MAX) fail(`${at}.name is too long (at most ${PROFILE_NAME_MAX} characters)`);
  const out: Omit<AgentProfile, "personality"> & { personality?: string } = {
    id,
    name,
    avatar: picture(p.avatar, `${at}.avatar`, AVATAR_FILE, "an image in the media (files/<sha256>.<ext>)"),
    body: picture(p.body, `${at}.body`, BODY_FILE, "a PNG or WebP in the media (files/<sha256>.png)"),
    brain: brain(p.brain, `${at}.brain`),
    clips: null,
    banner: bannerFile(p.banner, `${at}.banner`),
  };
  out.clips = clips(p.clips, `${at}.clips`, out.body);
  if (p.personality !== undefined) {
    if (typeof p.personality !== "string") fail(`${at}.personality must be text`);
    const t = (p.personality as string).trim();
    if (t.length > PROFILE_PERSONALITY_MAX) fail(`${at}.personality is too long (at most ${PROFILE_PERSONALITY_MAX} characters)`);
    out.personality = t;
  }
  return out;
}

/**
 * Checks a stored or typed list. Minimi is always there, first; a list without him gets him back. Ids are unique.
 * Minimi's entry keeps `personality` only when it was given (an edit); the stored list never carries it.
 */
export function checkProfiles(raw: unknown): (Omit<AgentProfile, "personality"> & { personality?: string })[] {
  if (raw === undefined || raw === null) return [{ ...MINIMI_PROFILE, personality: undefined }];
  if (!Array.isArray(raw)) return fail("agentProfiles must be a list of { id, name, avatar, body, clips, banner, personality, brain }");
  const seen = new Set<string>();
  const list = raw.map((p, i) => {
    const c = checkProfile(p, `agentProfiles[${i}]`);
    if (seen.has(c.id)) fail(`two agents have the id "${c.id}"`);
    seen.add(c.id);
    return c;
  });
  if (list.length > PROFILES_MAX) fail(`at most ${PROFILES_MAX} agents`);
  const mi = list.findIndex((p) => p.id === MINIMI_PROFILE_ID);
  const minimi = mi >= 0 ? list.splice(mi, 1)[0] : { ...MINIMI_PROFILE, personality: undefined };
  return [minimi, ...list];
}

/** One line about the brain, for lists. */
export function brainSummary(b: AgentBrain, agentName?: string): string {
  if (b.kind === "external") return b.via === "hermes" && b.hermes ? `Hermes · ${b.hermes}` : `${agentName ?? b.agent} (external agent)`;
  return b.model ?? "Default model";
}

/**
 * What the user picks on an agent's card. Hermes and the other agents become the card's own entry in this
 * device's `ai.agents` (id = the profile's id); the profile keeps only which kind it is (and the Hermes profile),
 * so another device can offer to set it up. The command itself never leaves the device.
 */
export type BrainPick =
  | { kind: "model"; model: string | null; effort?: BrainEffort }
  | { kind: "hermes"; profile: string }
  | { kind: "agent"; preset: Exclude<ExternalVia, "hermes">; command?: string; args?: string[]; env?: Record<string, string> };

/** The brain and this device's agent entry (or none) a pick makes for a profile. Throws ProfileError. */
export function pickToBrain(profileId: string, name: string, raw: unknown): { brain: AgentBrain; agent: AcpAgentDef | null } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("brain must be { kind: model | hermes | agent, … }");
  const pick = raw as Record<string, unknown>;
  if (pick.kind === "model") return { brain: brain({ kind: "model", model: pick.model ?? null, effort: pick.effort }, "brain"), agent: null };
  if (pick.kind === "hermes") {
    const p = String(pick.profile ?? "").trim() || "default";
    if (!HERMES_PROFILE.test(p)) return fail("brain.profile must be a Hermes profile name (letters, digits, - _ .)");
    const def = ACP_PRESETS.find((x) => x.id === "hermes")!.make({ profile: p });
    return { brain: { kind: "external", agent: profileId, via: "hermes", hermes: p }, agent: { ...def, id: profileId, name } };
  }
  if (pick.kind === "agent") {
    const preset = ACP_PRESETS.find((x) => x.id === pick.preset && x.id !== "hermes");
    if (!preset) return fail("brain.preset must be antigravity, gemini, claude, codex or custom");
    const def: AcpAgentDef = { ...preset.make(), id: profileId, name };
    if (preset.id === "custom") {
      def.command = String(pick.command ?? "").trim();
      if (!def.command) return fail("a custom agent needs its command");
      if (pick.args !== undefined && (!Array.isArray(pick.args) || pick.args.some((x) => typeof x !== "string"))) return fail("brain.args must be a list of words");
      def.args = [...((pick.args as string[] | undefined) ?? [])];
    }
    if (pick.env !== undefined && pick.env !== null) {
      const env = pick.env as Record<string, unknown>;
      if (typeof env !== "object" || Array.isArray(env) || Object.entries(env).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== "string")) return fail("brain.env must map variable names to text");
      if (Object.keys(env).length) def.env = { ...(env as Record<string, string>) };
    }
    return { brain: { kind: "external", agent: profileId, via: preset.id as ExternalVia }, agent: def };
  }
  return fail("brain.kind must be model, hermes or agent");
}

/** Which kind an agent entry is, from its preset or its command. */
export function viaOf(def: Pick<AcpAgentDef, "command" | "args" | "preset">): ExternalVia {
  if (def.command === "hermes" && def.args.length === 3 && def.args[0] === "-p" && def.args[2] === "acp") return "hermes";
  if (def.preset && def.preset !== "hermes") return def.preset;
  if (def.command === "agy") return "antigravity";
  if (def.command === "gemini") return "gemini";
  if (def.command === "claude-agent-acp") return "claude";
  if (def.command === "codex-acp") return "codex";
  return "custom";
}
