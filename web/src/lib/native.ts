// Where this copy of the app runs. The desktop app talks to a Node server; the browser build and the
// phone apps (Capacitor) run the core in a worker in the page, so anything that needs the server
// (self-update, the ChatGPT sign-in callback on 127.0.0.1, publishing with `gh`) is hidden there.
import { isLocal } from "@/lib/transport";
import { api } from "@/lib/api";

type CapacitorGlobal = { isNativePlatform?: () => boolean; getPlatform?: () => string; isPluginAvailable?: (name: string) => boolean };
const cap = (): CapacitorGlobal | undefined => (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;

/** True when there is no Etude server behind the app (browser build or a phone app). */
export const serverless = () => isLocal();

/** True inside the Android or iOS app. */
export const inNativeShell = () => !!cap()?.isNativePlatform?.();

/**
 * True where Sign in with ChatGPT can finish: the desktop app (its server's 127.0.0.1 listener)
 * and the phone apps that ship the EtudeAuth plugin (iOS today). Not the plain browser build: there
 * auth.openai.com can't be called (no CORS) and nothing can listen on 127.0.0.1.
 */
export const chatGptSignInHere = () => !serverless() || (inNativeShell() && !!cap()?.isPluginAvailable?.("EtudeAuth"));

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
