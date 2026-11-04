// The worker's entry. It only holds on to messages and loads the real worker (worker-core.ts).
// Keep it free of static imports: the build then never puts shared code in this chunk, so no other
// chunk imports it. WebKit evaluates a worker's entry module a second time when a chunk imports it,
// which booted the collection twice on OPFS.
const queued: MessageEvent[] = [];
self.onmessage = (ev: MessageEvent) => void queued.push(ev);
((self as any).__etudeEvals ??= { entry: 0, core: 0 }).entry++;
import("./worker-core.ts").then(
  ({ start }) => start(queued),
  (e) => {
    const error = `Error: couldn't load the Etude core: ${e instanceof Error ? e.message : String(e)}`;
    const fail = (ev: MessageEvent) => void (ev.data?.id != null && (self as any).postMessage({ id: ev.data.id, ok: false, error }));
    queued.forEach(fail);
    self.onmessage = fail;
  },
);
