// End-to-end check of the hero's live cards: plays the chess mate with real mouse clicks, checks
// it, rates it, then answers the math card, and reports what the page shows.
//   node site/tools/interact.mjs <base-url> <outdir> [width]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

const [BASE, OUT, WIDTH = "1440"] = process.argv.slice(2);
const width = Number(WIDTH), mobile = width < 700;
mkdirSync(OUT, { recursive: true });
const profile = `${process.env.TMPDIR ?? "/tmp"}/etude-site-int-${process.pid}`;
const port = 9500 + (process.pid % 40);
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
for (let i = 0; i < 80; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    break;
  } catch { await sleep(200); }
}
let id = 0;
const pending = new Map(), errors = [], sessions = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails?.exception?.description?.split("\n")[0] ?? d.params.exceptionDetails?.text);
  if (d.method === "Target.attachedToTarget" && d.params.targetInfo.type === "iframe") sessions.push(d.params.sessionId);
};
const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
const evaluate = async (expr, sessionId) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId)).result?.result?.value;
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64")); };
await send("Page.enable"); await send("Runtime.enable");
await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
await send("Emulation.setDeviceMetricsOverride", { width, height: mobile ? 844 : 900, deviceScaleFactor: 2, mobile });
await send("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 });
await send("Page.navigate", { url: BASE + "index.html" });
await sleep(3500);
if (mobile) { await evaluate(`scrollTo(0, document.querySelector("#stage").getBoundingClientRect().top + scrollY - 70)`); await sleep(800); }
// The hero plays the deck by itself: pause it and reopen the chess card so the test starts clean.
await evaluate(`(() => { const t = document.querySelector(".demo-toggle"); if (t && /Playing/.test(t.textContent)) t.click(); document.querySelectorAll(".stage-tab")[0].click(); })()`);
await sleep(2500);

/** The CDP session of the current card frame (card frames are out-of-process: sandboxed). */
async function frameContext() {
  const src = await evaluate(`document.querySelector(".stage-body iframe").src`);
  for (let k = 0; k < 20; k++) {
    for (const sid of [...sessions].reverse()) {
      const href = await evaluate("location.href", sid).catch(() => null);
      if (href === src) return sid;
    }
    await sleep(250);
  }
  // Same-process frame: evaluate through the main session's frame context instead.
  return null;
}
async function frameRect() { return evaluate(`(() => { const r = document.querySelector(".stage-body iframe").getBoundingClientRect(); return { x: r.x, y: r.y }; })()`); }
async function click(x, y) {
  for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, pointerType: "mouse" });
}
async function clickSquare(ctx, sq) {
  const r = await evaluate(`(() => { const e = document.querySelector('[data-sq="${sq}"]'); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`, ctx);
  const f = await frameRect();
  await click(f.x + r.x, f.y + r.y);
}
const report = {};
if (process.env.PROBE_TAB) {
  await evaluate(`document.querySelectorAll(".stage-tab")[${process.env.PROBE_TAB}].click()`);
  await sleep(2600);
  const sid = await frameContext();
  console.log(JSON.stringify(await evaluate(`(() => ({ w: innerWidth, kb: [...document.querySelectorAll(".kb-oct")].map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width)]; }), body: document.body.scrollHeight }))()`, sid)));
  process.exit(0);
}
let ctx = await frameContext();
report.chessMounted = await evaluate(`!!document.querySelector('[data-sq="g5"]')`, ctx);
await clickSquare(ctx, "g5"); await sleep(250);
await clickSquare(ctx, "f7"); await sleep(600);
report.checkEnabled = await evaluate(`!document.querySelector("[data-check]").disabled`);
await shot("chess-moved");
await evaluate(`document.querySelector("[data-check]").click()`);
await sleep(1500);
report.verdict = await evaluate(`document.querySelector(".verdict").textContent`);
report.ratings = await evaluate(`[...document.querySelectorAll(".rate")].map(b => b.textContent.trim() + (b.classList.contains("suggested") ? " *" : ""))`);
report.frameResult = await evaluate(`document.body.dataset.mode + " | " + (document.querySelector(".ch-answer")?.textContent ?? "")`, ctx);
await shot("chess-graded");
await evaluate(`document.querySelector('.rate[data-r="3"]').click()`);
await sleep(2600);
report.afterRate = await evaluate(`document.querySelector(".stage-tab[aria-selected=true]").textContent`);
// Math card: type an equivalent but different form.
await evaluate(`document.querySelectorAll(".stage-tab")[3].click()`);
await sleep(2500);
ctx = await frameContext();
const prompt = await evaluate(`document.querySelector(".prose")?.textContent`, ctx);
report.mathPrompt = prompt;
report.mathTyped = await evaluate(`(() => {
  const m = /f\\(x\\) = x(\\d) ?(\\\\?\\w+|e)/.exec(document.querySelector(".prose").textContent);
  return m ? m[0] : null;
})()`, ctx);
await shot("math-open");
// An equivalent form the author never wrote: factored instead of expanded.
const m = /f\(x\)=x(\d)(cosx|sinx|ex|lnx)/.exec(String(prompt).replace(/\s/g, ""));
const answers = { cosx: (n) => `x^${n - 1}(${n}cos(x) - x sin(x))`, sinx: (n) => `x^${n - 1}(${n}sin(x) + x cos(x))`, ex: (n) => `x^${n - 1}e^x(${n} + x)`, lnx: (n) => `x^${n - 1}(${n}ln(x) + 1)` };
const typed = m ? answers[m[2]](Number(m[1])) : "0";
report.mathTyped = typed;
await evaluate(`(() => { const i = document.querySelector("#answer"); i.value = ${JSON.stringify(typed)}; i.dispatchEvent(new Event("input", { bubbles: true })); return document.querySelector(".mx-preview").textContent; })()`, ctx);
await sleep(500);
await evaluate(`document.querySelector("[data-check]").click()`);
await sleep(1200);
report.mathVerdict = await evaluate(`document.querySelector(".verdict").textContent`);
await shot("math-graded");
console.log(JSON.stringify(report, null, 1));
if (errors.length) console.log("errors:", errors);
ws.close(); chrome.kill(); await sleep(300);
rmSync(profile, { recursive: true, force: true });
