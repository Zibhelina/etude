// The document that runs code from a note's code blocks. It's loaded in a sandboxed iframe (opaque origin,
// no access to the app or its API) and runs each snippet in a Web Worker, so a loop that never ends can be
// stopped by ending the worker. JavaScript runs as written; Python runs in Pyodide, which the Etude server
// serves from /runtime/pyodide/ (packages like numpy are fetched once and kept). The frame's policy only lets
// code reach those files, so a snippet can't send a page anywhere.
//
// The app talks to it with postMessage: { etudeRun: 1, type: "run", id, lang, code, timeout } and gets back
// "out" (stdout/stderr text), "image" (a plot as a PNG data URL), "status" ("Loading Python…") and "done".

/** Languages a code block can run, by the names people write on the fence. */
export const RUNNABLE: Record<string, "js" | "python"> = { js: "js", javascript: "js", mjs: "js", python: "python", py: "python" };

export const runLanguage = (lang: string | null | undefined) => RUNNABLE[String(lang ?? "").trim().toLowerCase()] ?? null;

// The worker for JavaScript: console goes to the output, the snippet runs as an async function body (so
// top-level await works), and a returned value is shown like a REPL's.
const JS_WORKER = `
const send = (m) => postMessage(m);
const show = (v) => {
  if (typeof v === "string") return v;
  try { return v instanceof Error ? (v.stack || String(v)) : typeof v === "object" && v !== null ? JSON.stringify(v, null, 2) ?? String(v) : String(v); } catch { return String(v); }
};
for (const [k, stream] of [["log", "out"], ["info", "out"], ["debug", "out"], ["warn", "err"], ["error", "err"]])
  console[k] = (...a) => send({ type: "out", stream, text: a.map(show).join(" ") + "\\n" });
console.table = (t) => send({ type: "out", stream: "out", text: show(t) + "\\n" });
onmessage = async (e) => {
  const { code } = e.data;
  const AsyncFunction = (async () => {}).constructor;
  try {
    const value = await new AsyncFunction(code)();
    if (value !== undefined) send({ type: "out", stream: "result", text: show(value) + "\\n" });
    send({ type: "done", ok: true });
  } catch (err) {
    send({ type: "out", stream: "err", text: (err && err.stack ? String(err.stack).split("\\n").filter((l) => !/AsyncFunction|blob:/.test(l)).join("\\n") : String(err)) + "\\n" });
    send({ type: "done", ok: false });
  }
};
`;

// The worker for Python. Pyodide loads once per worker; each run gets fresh globals. Imports are installed
// from the lock file before running, plots made with matplotlib come back as pictures, and the last line's
// value is printed like in a REPL. input() isn't available (nothing to type into).
const PY_WORKER = (index: string) => `
const send = (m) => postMessage(m);
let py = null;
async function boot() {
  send({ type: "status", text: "Loading Python…" });
  const { loadPyodide } = await import(${JSON.stringify(index + "pyodide.mjs")});
  py = await loadPyodide({ indexURL: ${JSON.stringify(index)}, packageBaseUrl: ${JSON.stringify(index)}, stdout: () => {}, stderr: () => {} });
  py.setStdin({ error: true });
  await py.runPythonAsync("import os\\nos.environ['MPLBACKEND'] = 'Agg'");
}
// Pyodide's traceback starts in its own files. Keep only the frames in the block's code, each with its line.
function userTraceback(msg, code) {
  const lines = msg.replace(/\\n+$/, "").split("\\n");
  if (!msg.includes('"<code>"')) return msg;
  const src = code.split("\\n");
  const out = [];
  let keep = false;
  for (const l of lines) {
    if (l.startsWith("Traceback")) { out.push(l); continue; }
    const f = /^  File "([^"]+)", line (\\d+)/.exec(l);
    if (f) {
      keep = f[1] === "<code>";
      if (keep) {
        out.push(l.replace('"<code>"', '"your code"'));
        const at = src[Number(f[2]) - 1];
        if (at !== undefined && !/^\\s/.test(lines[lines.indexOf(l) + 1] ?? "")) out.push("    " + at.trim());
      }
      continue;
    }
    if (/^\\s/.test(l)) { if (keep) out.push(l); continue; }
    keep = false;
    out.push(l);
  }
  return out.join("\\n");
}
let ready = null;
onmessage = async (e) => {
  const { code } = e.data;
  try {
    ready ??= boot();
    await ready;
    py.setStdout({ batched: (t) => send({ type: "out", stream: "out", text: t + "\\n" }) });
    py.setStderr({ batched: (t) => send({ type: "out", stream: "err", text: t + "\\n" }) });
    let loading = false;
    await py.loadPackagesFromImports(code, {
      messageCallback: (m) => { if (!loading && /^Loading /.test(m)) { loading = true; send({ type: "status", text: m.replace(/^Loading /, "Getting ").replace(/,? ?$/, "") + "…" }); } },
      errorCallback: (m) => send({ type: "out", stream: "err", text: m + "\\n" }),
    });
    send({ type: "status", text: "" });
    const ns = py.globals.get("dict")();
    ns.set("__code__", code);
    ns.set("__name__", "__main__");
    await py.runPythonAsync(\`
from pyodide.code import eval_code_async as __eval
__r = await __eval(__code__, globals(), filename="<code>")
if __r is not None:
    import sys as __sys
    __sys.stdout.write(repr(__r) + "\\\\n")
\`, { globals: ns });
    const figs = await py.runPythonAsync(\`
import sys
out = []
if "matplotlib.pyplot" in sys.modules:
    import io, base64, warnings
    import matplotlib.pyplot as plt
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        for n in plt.get_fignums():
            b = io.BytesIO()
            plt.figure(n).savefig(b, format="png", dpi=144, bbox_inches="tight")
            out.append(base64.b64encode(b.getvalue()).decode())
    plt.close("all")
out
\`, { globals: ns });
    for (const b64 of figs.toJs()) send({ type: "image", src: "data:image/png;base64," + b64 });
    figs.destroy?.();
    ns.destroy?.();
    send({ type: "done", ok: true });
  } catch (err) {
    const msg = String(err && err.message || err);
    const tb = userTraceback(msg, code);
    send({ type: "status", text: "" });
    send({ type: "out", stream: "err", text: tb.replace(/\\n+$/, "") + "\\n" });
    send({ type: "done", ok: false });
  }
};
`;

/**
 * The run frame. `base` is the Etude server's public root; with none (the serverless builds) only JavaScript
 * runs, because Pyodide's files come from the server.
 */
export function runFrameHtml(base: string | null): string {
  let origin = "";
  if (base) {
    try {
      origin = new URL(base).origin;
    } catch {
      origin = "";
    }
  }
  const index = origin ? `${origin}/runtime/pyodide/` : "";
  const csp = [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:${index ? ` ${index}` : ""}`,
    `connect-src${index ? ` ${index}` : " 'none'"}`,
    "worker-src blob:",
    "img-src data: blob:",
    "style-src 'unsafe-inline'",
  ].join("; ");
  const js = JSON.stringify(JS_WORKER);
  const pyw = index ? JSON.stringify(PY_WORKER(index)) : "null";
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><script>
const sources = { js: ${js}, python: ${pyw} };
const urls = {};
const url = (lang) => (urls[lang] ??= URL.createObjectURL(new Blob([sources[lang]], { type: "text/javascript" })));
// Python keeps its worker between runs (loading it takes seconds); JavaScript gets a new one each time.
const live = {};
const reply = (m) => parent.postMessage({ etudeRun: 1, ...m }, "*");
const jobs = new Map();
function stop(id, why) {
  const q = queue.findIndex((m) => m.id === id);
  if (q >= 0) {
    queue.splice(q, 1);
    reply({ type: "status", id, text: "" });
    return reply({ type: "done", id, ok: false, stopped: true, ms: 0 });
  }
  const j = jobs.get(id);
  if (!j) return;
  jobs.delete(id);
  clearTimeout(j.timer);
  j.worker.terminate();
  if (live[j.lang] === j.worker) delete live[j.lang];
  reply({ type: "status", id, text: "" });
  reply({ type: "out", id, stream: "err", text: why + "\\n" });
  reply({ type: "done", id, ok: false, stopped: true, ms: Math.round(performance.now() - j.t0) });
  if (j.lang === "python") next();
}
onmessage = (e) => {
  const m = e.data;
  if (!m || m.etudeRun !== 1) return;
  if (m.type === "stop") return stop(m.id, "Stopped.");
  if (m.type !== "run") return;
  if (!sources[m.lang]) {
    reply({ type: "out", id: m.id, stream: "err", text: m.lang === "python" ? "Python runs with the Etude app or server; this copy of Etude has none.\\n" : "Etude can't run " + m.lang + " yet.\\n" });
    return reply({ type: "done", id: m.id, ok: false, ms: 0 });
  }
  // Python has one interpreter: a run that comes while another is going waits for it.
  if (m.lang === "python" && [...jobs.values()].some((j) => j.lang === "python")) {
    queue.push(m);
    return reply({ type: "status", id: m.id, text: "Waiting for the other Python block…" });
  }
  start(m);
};
const queue = [];
function next() {
  const m = queue.shift();
  if (m) start(m);
}
function start(m) {
  const worker = m.lang === "python" ? (live.python ??= new Worker(url("python"))) : new Worker(url("js"));
  const t0 = performance.now();
  const job = { lang: m.lang, worker, t0, timer: 0 };
  // The clock starts once the language is loaded, so the first Python run isn't cut off while it downloads.
  const arm = () => { clearTimeout(job.timer); job.timer = setTimeout(() => stop(m.id, "Stopped after " + Math.round(m.timeout / 1000) + " s. A loop that never ends?"), m.timeout); };
  jobs.set(m.id, job);
  worker.onmessage = (ev) => {
    const d = ev.data;
    if (d.type === "status") (d.text ? clearTimeout(job.timer) : arm());
    reply({ ...d, id: m.id, ...(d.type === "done" ? { ms: Math.round(performance.now() - t0) } : {}) });
    if (d.type === "done") {
      clearTimeout(job.timer);
      jobs.delete(m.id);
      if (m.lang !== "python") worker.terminate();
      else next();
    }
  };
  worker.onerror = (ev) => { ev.preventDefault(); stop(m.id, String(ev.message || "The code crashed.")); };
  arm();
  worker.postMessage({ code: m.code });
}
reply({ type: "ready" });
</script></body></html>`;
}
