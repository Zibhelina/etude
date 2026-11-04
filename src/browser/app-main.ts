// The Etude web app with no server: the core runs in a worker in this tab, and the app's own
// requests (/api, /frame) go to it instead of the network. See web/src/lib/transport.ts.
// The same build runs in the Android and iOS apps (capacitor.config.ts); native-shell.ts adds the
// back button, status bar, keyboard and deep links there.
import { startCore } from "./client.ts";
import { native, startNativeShell } from "./native-shell.ts";

// A link to one of the app's screens on a static host lands on its 404 page, which saves the path
// and reloads the app at its root (site/src/404.html). Put the path back before the app reads it.
try {
  const route = sessionStorage.getItem("etude.route");
  const base = String(import.meta.env.VITE_APP_BASE ?? "");
  if (route) {
    sessionStorage.removeItem("etude.route");
    if (base && route.startsWith(base + "/")) history.replaceState(null, "", route);
  }
} catch {}

// In the phone apps the worker gets native HTTP, the Keychain and the sign-in sheet (ChatGPT plan).
const hasAuthPlugin = native && !!(globalThis as any).Capacitor?.isPluginAvailable?.("EtudeAuth");
const core = startCore(hasAuthPlugin ? { native: (await import("./native-chatgpt.ts")).nativeChatGptHandler() } : {});
(globalThis as any).__etudeTransport = (input: RequestInfo | URL, init?: RequestInit) => core.fetch(input, init);
(globalThis as any).__etudeLocal = true;
(globalThis as any).__etudeCore = core; // for tests and debugging
// Ask the browser not to clear the collection when it runs low on space.
navigator.storage?.persist?.().catch(() => {});

// @ts-ignore: the web app has its own tsconfig (web/tsconfig.json)
await import("../../web/src/main.tsx");
void startNativeShell().catch((e) => console.warn("native shell:", e));

// The web edition (etude.study/app/) keeps itself on the device so it opens offline (sw.js).
const webBase = String(import.meta.env.VITE_APP_BASE ?? "");
if (webBase && !native && "serviceWorker" in navigator) {
  navigator.serviceWorker.register(`${webBase}/sw.js`, { scope: `${webBase}/` }).catch((e) => console.warn("service worker:", e));
}
