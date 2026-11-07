// Running a note's code blocks. One hidden, sandboxed frame per app (the run frame, src/core/run-frame.ts) does
// the work in Web Workers; each run streams its output back here by id. With a server the frame is loaded
// from /frame/run; the serverless builds make it here (JavaScript only: Python's files come from a server).
import { runFrameHtml, runLanguage } from "../../../src/core/run-frame.ts";
import { isLocal } from "@/lib/transport";
import { withBase } from "@/lib/router";

export { runLanguage };

export type RunEvent =
  | { type: "out"; stream: "out" | "err" | "result"; text: string }
  | { type: "image"; src: string }
  | { type: "status"; text: string }
  | { type: "done"; ok: boolean; ms: number; stopped?: boolean };

let frame: HTMLIFrameElement | null = null;
let ready: Promise<HTMLIFrameElement> | null = null;
const listeners = new Map<string, (e: RunEvent) => void>();

function boot(): Promise<HTMLIFrameElement> {
  if (ready) return ready;
  ready = new Promise((resolve) => {
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts");
    f.setAttribute("aria-hidden", "true");
    f.tabIndex = -1;
    f.title = "Code runner";
    f.style.cssText = "position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none;left:-9999px;top:0";
    const onMsg = (e: MessageEvent) => {
      if (e.source !== f.contentWindow || e.data?.etudeRun !== 1) return;
      const { id, ...rest } = e.data;
      if (rest.type === "ready") return resolve(f);
      listeners.get(id)?.(rest as RunEvent);
      if (rest.type === "done") listeners.delete(id);
    };
    window.addEventListener("message", onMsg);
    if (isLocal()) f.srcdoc = runFrameHtml(null);
    else f.src = withBase("/frame/run");
    document.body.appendChild(f);
    frame = f;
  });
  return ready;
}

/** Runs `code`; `on` gets its output as it comes. Returns a function that stops it. */
export function runCode(lang: "js" | "python", code: string, on: (e: RunEvent) => void, opts: { timeout?: number } = {}): () => void {
  const id = crypto.randomUUID();
  listeners.set(id, on);
  const timeout = opts.timeout ?? (lang === "python" ? 30_000 : 10_000);
  void boot().then((f) => f.contentWindow?.postMessage({ etudeRun: 1, type: "run", id, lang, code, timeout }, "*"));
  return () => frame?.contentWindow?.postMessage({ etudeRun: 1, type: "stop", id }, "*");
}
