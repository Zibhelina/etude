// Talks to the core worker. `core.call("next", { deck })` calls the engine directly;
// `core.fetch("/api/decks")` is a drop-in `fetch` for the app's own URLs, answered by the worker.
export function startCore() {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  let n = 0;
  type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; stream?: ReadableStreamDefaultController<Uint8Array> };
  const pending = new Map<number, Pending>();
  worker.onmessage = (ev) => {
    const d = ev.data;
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
  const send = <T>(msg: Record<string, unknown>, transfer: Transferable[] = []) => {
    const id = ++n;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, ...msg }, transfer);
    });
  };
  return {
    worker,
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
