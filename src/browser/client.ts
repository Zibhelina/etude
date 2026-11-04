// Talks to the core worker. `core.call("next", { deck })` calls the engine directly;
// `core.fetch("/api/decks")` is a drop-in `fetch` for the app's own URLs, answered by the worker.
//
// The collection is one SQLite file in the browser's private storage (OPFS), and only one worker
// can hold it open. So only one tab runs the core: a tab takes the "etude-collection" lock before it
// starts its worker. A second tab says Etude is open elsewhere and waits; "Use it here" asks the
// other tab to let go, and that one steps aside the same way.
import { nativeError, type NativeHandler } from "./native-chatgpt.ts";

const LOCK = "etude-collection";

/** `native`: in the phone apps, answers the worker's requests for native HTTP, storage and sign-in. */
export function startCore(opts: { native?: NativeHandler; platform?: "ios" | "android" | "web" } = {}) {
  let worker: Worker | null = null;
  let n = 0;
  type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; stream?: ReadableStreamDefaultController<Uint8Array> };
  const pending = new Map<number, Pending>();
  const onmessage = (ev: MessageEvent) => {
    const d = ev.data;
    if (d?.native) {
      const { nid, op, args } = d.native;
      const w = ev.target as Worker;
      if (!opts.native) return w.postMessage({ nativeReply: nid, ok: false, error: "no native host in this build" });
      opts.native(op, args).then(
        (value) => w.postMessage({ nativeReply: nid, ok: true, value }),
        (e) => w.postMessage({ nativeReply: nid, ok: false, error: nativeError(e) }),
      );
      return;
    }
    const p = pending.get(d.id);
    if (!p) return;
    if (d.chunk) return p.stream?.enqueue(new Uint8Array(d.chunk));
    if (d.end) {
      p.stream?.close();
      return pending.delete(d.id);
    }
    if (!d.ok) {
      pending.delete(d.id);
      return p.reject(new Error(d.error));
    }
    if (d.value?.stream) {
      // Keep the entry: chunks follow. Hand back a streaming Response now.
      const body = new ReadableStream<Uint8Array>({ start: (c) => void (p.stream = c) });
      return p.resolve(new Response(body, { status: d.value.status, headers: d.value.headers }));
    }
    pending.delete(d.id);
    p.resolve(d.value);
  };

  const started = takeCollection(async () => {
    // Another tab asked for the collection: write out what's pending, then stop.
    const w = worker;
    worker = null;
    if (!w) return;
    const id = ++n;
    await Promise.race([
      new Promise<void>((resolve) => {
        pending.set(id, { resolve: () => resolve(), reject: () => resolve() });
        w.postMessage({ id, method: "_flush", args: [] });
      }),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
    w.terminate();
  }).then(() => {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = onmessage;
    // First message, before any call: whether the app hands the worker a native host.
    // Also where it runs, for anonymous error reports (src/core/telemetry.ts); an automated browser sends none.
    worker.postMessage({ hello: { native: !!opts.native, platform: opts.platform ?? "web", automated: !!(globalThis.navigator as { webdriver?: boolean } | undefined)?.webdriver || /HeadlessChrome/.test(globalThis.navigator?.userAgent ?? "") } });
    return worker;
  });

  const send = async <T>(msg: Record<string, unknown>, transfer: Transferable[] = []) => {
    const w = await started;
    if (worker !== w) return new Promise<T>(() => {}); // this tab let go; the page is covered
    const id = ++n;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      w.postMessage({ id, ...msg }, transfer);
    });
  };
  return {
    get worker() {
      return worker;
    },
    call<T = any>(method: string, ...args: unknown[]): Promise<T> {
      return send<T>({ method, args });
    },
    async fetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
      const req = new Request(new URL(String(input instanceof Request ? input.url : input), location.href), init);
      const body = req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer();
      const out = await send<any>({ http: { method: req.method, url: req.url, headers: Object.fromEntries(req.headers.entries()), body } }, body ? [body] : []);
      if (out instanceof Response) return out;
      const status = out.status;
      return new Response(status === 204 || status === 304 ? null : out.body, { status, headers: out.headers });
    },
  };
}

/**
 * Resolves once this tab holds the collection lock. `release` runs when another tab takes it over;
 * after that this tab shows the "open in another tab" cover and reloads if it gets the lock back.
 */
function takeCollection(release: () => Promise<void>): Promise<void> {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks || typeof BroadcastChannel === "undefined") return Promise.resolve();
  const channel = new BroadcastChannel("etude-tabs");
  let letGo: (() => void) | null = null;
  let held = false;
  let cover: HTMLElement | null = null;

  const hold = (resolve: () => void) => () =>
    new Promise<void>((done) => {
      held = true;
      cover?.remove();
      cover = null;
      letGo = done;
      resolve();
    });

  return new Promise<void>((resolve) => {
    channel.onmessage = async (e) => {
      if (e.data !== "take" || !held) return;
      held = false;
      await release();
      cover = showCover(true, () => channel.postMessage("take"));
      letGo?.();
      // The page's state went with the worker: start over if the lock comes back.
      void locks.request(LOCK, () => {
        location.reload();
        return new Promise(() => {});
      });
    };
    void locks.request(LOCK, { ifAvailable: true }, (lock) => {
      if (lock) return hold(resolve)();
      cover = showCover(false, () => channel.postMessage("take"));
      void locks.request(LOCK, hold(resolve));
      return undefined;
    });
  });
}

/** Covers the page: the collection is open in another tab. */
function showCover(movedAway: boolean, useHere: () => void): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "etude-tab-cover-h");
  el.dataset.etudeTabCover = "";
  el.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:24px;background:var(--background,#0b0b0b);color:var(--foreground,#f2f2f2);font:15px/1.5 Inter,system-ui,sans-serif;text-align:center";
  el.innerHTML = `<div style="max-width:340px">
    <img src="${import.meta.env.BASE_URL}logo.svg" alt="" width="72" height="72" style="display:block;margin:0 auto 16px">
    <h1 id="etude-tab-cover-h" style="font-size:20px;font-weight:600;margin:0 0 6px">Etude is open in another tab</h1>
    <p style="margin:0 0 20px;opacity:.65">${movedAway ? "You moved it to another tab." : "Your collection can be open in one tab at a time."} Close that tab, or keep studying here.</p>
    <button type="button" style="font:inherit;font-weight:600;padding:10px 22px;border:0;border-radius:999px;background:var(--foreground,#f2f2f2);color:var(--background,#0b0b0b);cursor:pointer">Use it here</button>
  </div>`;
  el.querySelector("button")!.addEventListener("click", useHere);
  document.body.appendChild(el);
  return el;
}
