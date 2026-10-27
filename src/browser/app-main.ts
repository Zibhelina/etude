// The Etude web app with no server: the core runs in a worker in this tab, and the app's own
// requests (/api, /frame) go to it instead of the network. See web/src/lib/transport.ts.
import { startCore } from "./client.ts";

const core = startCore();
(globalThis as any).__etudeTransport = (input: RequestInfo | URL, init?: RequestInit) => core.fetch(input, init);
(globalThis as any).__etudeLocal = true;
(globalThis as any).__etudeCore = core; // for tests and debugging
// Ask the browser not to clear the collection when it runs low on space.
navigator.storage?.persist?.().catch(() => {});

// @ts-ignore: the web app has its own tsconfig (web/tsconfig.json)
await import("../../web/src/main.tsx");
