// Where this copy of the app runs. The desktop app talks to a Node server; the browser build and the
// phone apps (Capacitor) run the core in a worker in the page, so anything that needs the server
// (self-update, the ChatGPT sign-in callback on 127.0.0.1, publishing with `gh`) is hidden there.
import { isLocal } from "@/lib/transport";
import { api } from "@/lib/api";

type CapacitorGlobal = { isNativePlatform?: () => boolean; getPlatform?: () => string };
const cap = (): CapacitorGlobal | undefined => (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;

/** True when there is no Etude server behind the app (browser build or a phone app). */
export const serverless = () => isLocal();

/** True inside the Android or iOS app. */
export const inNativeShell = () => !!cap()?.isNativePlatform?.();

/** "android", "ios" or "web". */
export const shellPlatform = () => (inNativeShell() ? (cap()?.getPlatform?.() ?? "web") : "web");

/** The core worker, in the serverless build (see src/browser/app-main.ts). */
export const localCore = (): { call<T = unknown>(method: string, ...args: unknown[]): Promise<T> } | undefined => (globalThis as { __etudeCore?: never }).__etudeCore;

/** Stores an API key in the app's private storage (the serverless counterpart of ~/.etude/.env). Empty removes it. */
export async function saveLocalKey(name: string, value: string): Promise<void> {
  const core = localCore();
  if (!core) throw new Error("keys are set in ~/.etude/.env on the desktop");
  await core.call("_setEnv", name, value.trim() || null);
}

/** Saves an API key wherever this copy keeps them: the app's private storage, or $ETUDE_HOME/.env through the server. */
export async function saveApiKey(name: string, value: string): Promise<void> {
  if (serverless()) await saveLocalKey(name, value);
  else await api.saveKey(name, value.trim());
}
