// Agent profiles in the app: who you talk to in Ask (src/core/agent-profiles.ts). One shared copy of the list,
// kept in step after every change; a localStorage copy avoids a flash of Minimi before the list loads.
import { useEffect, useState } from "react";
import { etudeFetch } from "./transport";
import { HARNESS_PRESETS, MINIMI_PROFILE, MINIMI_PROFILE_ID, type AgentProfile, type BrainPick, type ExternalVia, type HarnessPresetId } from "../../../src/core/agent-profiles.ts";

export { HARNESS_PRESETS, MINIMI_PROFILE_ID, type AgentBrain, type AgentProfile, type BrainPick, type ExternalVia, type HarnessPresetId } from "../../../src/core/agent-profiles.ts";

/** A profile as the app shows it: whether it can answer on this device, its agent's own name, and its entry here. */
export type ProfileView = AgentProfile & { available: boolean; note?: string; agentName?: string; setup?: { command: string; args: string[]; env?: Record<string, string>; via: ExternalVia } };
export interface ProfilesState {
  default: string;
  profiles: ProfileView[];
}

const KEY = "etude.agentProfiles";
const EVENT = "etude:agent-profiles";
const FALLBACK: ProfilesState = { default: MINIMI_PROFILE_ID, profiles: [{ ...MINIMI_PROFILE, available: true }] };

let state: ProfilesState = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return v && Array.isArray(v.profiles) && v.profiles.length ? v : FALLBACK;
  } catch {
    return FALLBACK;
  }
})();

function set(next: ProfilesState) {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
  window.dispatchEvent(new Event(EVENT));
  return next;
}

async function call(method: string, path: string, body?: unknown): Promise<ProfilesState & { created?: string }> {
  const res = await etudeFetch(path, { method, headers: { "Content-Type": "application/json" }, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error ?? res.statusText);
  set({ default: data.default, profiles: data.profiles });
  return data;
}

export const profilesApi = {
  load: () => call("GET", "/api/agent/profiles"),
  add: (p: Partial<AgentProfile> & { makeDefault?: boolean }) => call("POST", "/api/agent/profiles", p),
  duplicate: (id: string, name?: string) => call("POST", "/api/agent/profiles", { duplicate: id, ...(name ? { name } : {}) }),
  edit: (id: string, patch: Partial<Omit<AgentProfile, "id">>) => call("PATCH", `/api/agent/profiles/${encodeURIComponent(id)}`, patch),
  remove: (id: string) => call("DELETE", `/api/agent/profiles/${encodeURIComponent(id)}`),
  setDefault: (id: string) => call("POST", `/api/agent/profiles/${encodeURIComponent(id)}/default`),
  /** The brain from an agent's card: a model, Hermes with a profile, or another agent (its entry stays on this device). */
  setBrain: (id: string, pick: BrainPick) => call("PUT", `/api/agent/profiles/${encodeURIComponent(id)}/brain`, pick),
  /** Toggle a harness (Hermes, Antigravity, Claude Code, Codex, Gemini CLI) on or off for an external agent. */
  toggleHarness: (id: string, toggle: HarnessPresetId, enabled: boolean, hermesProfile?: string) =>
    call("PUT", `/api/agent/profiles/${encodeURIComponent(id)}/harnesses`, { toggle, enabled, ...(hermesProfile ? { hermesProfile } : {}) }),
  /** Make one of an external agent's harnesses the default for new chats, keeping the other enabled harnesses. */
  setDefaultHarness: (id: string, harness: HarnessPresetId, hermesProfile?: string) =>
    call("PUT", `/api/agent/profiles/${encodeURIComponent(id)}/harnesses`, { default: harness, ...(hermesProfile ? { hermesProfile } : {}) }),
  /** Whether Hermes and the built-in ACP adapters are on this computer, plus Hermes profiles. */
  hermes: async (): Promise<{ installed: boolean; available: boolean; profiles: string[]; presets?: Partial<Record<HarnessPresetId, boolean>> }> => {
    try {
      const res = await etudeFetch("/api/agent/hermes");
      if (!res.ok) throw new Error(res.statusText);
      return await res.json();
    } catch {
      return { installed: false, available: false, profiles: [] };
    }
  },
};

export const profilesNow = () => state;
/** A profile by id; a missing one (removed, or not synced yet) is Minimi. Null is the default one. */
export const profileFrom = (s: ProfilesState, id: string | null | undefined): ProfileView => s.profiles.find((p) => p.id === (id ?? s.default)) ?? s.profiles[0] ?? FALLBACK.profiles[0];

let loading: Promise<unknown> | null = null;
export function useAgentProfiles(): ProfilesState {
  const [s, setS] = useState(state);
  useEffect(() => {
    const h = () => setS(state);
    window.addEventListener(EVENT, h);
    // Once per page load, and again when the window comes back (another device may have changed them).
    loading ??= profilesApi.load().catch(() => {});
    const again = () => void profilesApi.load().catch(() => {});
    window.addEventListener("focus", again);
    return () => {
      window.removeEventListener(EVENT, h);
      window.removeEventListener("focus", again);
    };
  }, []);
  return s;
}

/** The default profile: the one the corner shows and new chats start with. */
export const useDefaultProfile = () => {
  const s = useAgentProfiles();
  return profileFrom(s, null);
};

/** A media ref (files/…) as a URL the app can load. */
export const mediaUrl = (ref: string) => `/media/${ref}`;

/** Opens Settings → AI at the agents. */
export const AGENTS_ANCHOR = "/settings#ai-agents";
