// Sign in with ChatGPT inside the phone apps, main-thread half. The core runs in a worker, which
// can't reach Capacitor plugins, so the worker sends { native: { nid, op, args } } and this answers
// with { nativeReply: nid, ok, value | error }. The plugin (ios/App/App/EtudeAuthPlugin.swift)
// does OpenAI's HTTP outside the WebView, keeps the credential files in the Keychain, runs the
// 127.0.0.1 listener and shows the sign-in page in a browser sheet. See setChatGptNativeHost in
// src/core/chatgpt.ts for the worker half.
import { registerPlugin } from "@capacitor/core";

export interface EtudeAuthPlugin {
  request(o: { url: string; method: string; headers: Record<string, string>; body?: string; timeoutMs: number }): Promise<{ status: number; headers: Record<string, string>; body: string }>;
  secureGet(o: { name: string }): Promise<{ value: string | null }>;
  secureSet(o: { name: string; value: string }): Promise<void>;
  listen(o: { port: number }): Promise<{ port: number }>;
  next(): Promise<{ path: string; query: string }>;
  open(o: { url: string }): Promise<void>;
  finish(): Promise<void>;
}

/** The ops the worker may ask for, mapped onto the plugin. */
export function nativeChatGptHandler(plugin: EtudeAuthPlugin = registerPlugin<EtudeAuthPlugin>("EtudeAuth")) {
  const ops: Record<string, (a: any) => Promise<unknown>> = {
    "http": (a) => plugin.request(a),
    "store.get": (a) => plugin.secureGet({ name: a.name }).then((r) => r.value ?? null),
    "store.set": (a) => plugin.secureSet({ name: a.name, value: a.value }),
    "login.listen": (a) => plugin.listen({ port: a.port }),
    "login.next": () => plugin.next(),
    "login.open": (a) => plugin.open({ url: a.url }),
    "login.finish": () => plugin.finish(),
  };
  return async (op: string, args: unknown): Promise<unknown> => {
    const fn = ops[op];
    if (!fn) throw new Error(`no such native op: ${op}`);
    return fn(args ?? {});
  };
}

export type NativeHandler = ReturnType<typeof nativeChatGptHandler>;

/** Error codes survive the hop as "code: message", so the worker can tell a cancel from a failure. */
export function nativeError(e: unknown): string {
  const err = e as { code?: string; message?: string };
  return err?.code ? `${err.code}: ${err.message ?? ""}` : String(err?.message ?? e);
}
