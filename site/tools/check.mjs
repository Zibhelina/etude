// Loads the built site in headless Chromium, scrolls through it so every section animates in,
// reports console errors, failed requests and horizontal overflow, and saves screenshots.
//   node site/tools/check.mjs <base-url> <outdir> [page=index.html] [width=1440] [steps-json]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

const [BASE, OUT, PAGE = "index.html", WIDTH = "1440", STEPS = "[]"] = process.argv.slice(2);
const width = Number(WIDTH), mobile = width < 700, height = Number(process.env.H ?? (mobile ? 844 : 900));
mkdirSync(OUT, { recursive: true });
const profile = `${process.env.TMPDIR ?? "/tmp"}/etude-site-check-${process.pid}`;
const port = 9450 + (process.pid % 40);
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", "--force-color-profile=srgb", "about:blank"], { stdio: "ignore" });
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
const pending = new Map(), problems = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  if (d.method === "Runtime.exceptionThrown") problems.push("exception: " + (d.params.exceptionDetails?.exception?.description ?? d.params.exceptionDetails?.text).split("\n")[0]);
  if (d.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(d.params.type)) problems.push(`console.${d.params.type}: ` + d.params.args.map((a) => a.value ?? a.description).join(" "));
  if (d.method === "Log.entryAdded" && d.params.entry.level === "error") problems.push(`log: ${d.params.entry.text} ${d.params.entry.url ?? ""}`);
  if (d.method === "Network.responseReceived" && d.params.response.status >= 400) problems.push(`HTTP ${d.params.response.status} ${d.params.response.url}`);
  if (d.method === "Network.loadingFailed" && !d.params.canceled) problems.push(`failed: ${d.params.errorText} ${d.params.requestId}`);
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable"); await send("Network.enable");
await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
await send("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 });
await send("Page.navigate", { url: BASE + PAGE });
await sleep(3500);
await send("Page.captureScreenshot", { format: "png" }).then((r) => writeFileSync(`${OUT}/top.png`, Buffer.from(r.result.data, "base64")));
for (const st of JSON.parse(STEPS)) {
  const r = await evaluate(st.js);
  if (r !== undefined) console.log("step", st.name ?? "", JSON.stringify(r).slice(0, 400));
  await sleep(st.wait ?? 800);
  if (st.shot) await send("Page.captureScreenshot", { format: "png" }).then((r) => writeFileSync(`${OUT}/${st.shot}.png`, Buffer.from(r.result.data, "base64")));
}
// Scroll the page in steps so reveals and lazy images fire, then capture it whole.
const total = await evaluate("document.documentElement.scrollHeight");
for (let y = 0; y < total; y += Math.round(height * 0.7)) { await evaluate(`scrollTo(0, ${y})`); await sleep(350); }
await sleep(2500);
await evaluate("scrollTo(0, 0)");
await sleep(600);
const ow = await evaluate("document.documentElement.scrollWidth - innerWidth");
if (ow > 0) problems.push(`horizontal overflow ${ow}px`);
const wide = await evaluate(`[...document.querySelectorAll('body *')].filter(e => { const r = e.getBoundingClientRect(); return r.right > innerWidth + 1 && getComputedStyle(e).position !== 'fixed' && !e.closest('.marquee, .stage-tabs, .shots-tabs, .code-tabs, .hero-bg, .cta .big-eps') && !e.closest('pre'); }).slice(0, 8).map(e => e.tagName + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().right))`);
if (wide?.length) problems.push("wider than viewport: " + wide.join(" | "));
const h = await evaluate("document.documentElement.scrollHeight");
const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: h, scale: 1 } });
writeFileSync(`${OUT}/full.png`, Buffer.from(shot.result.data, "base64"));
console.log(JSON.stringify({ page: PAGE, width, height: h, problems }, null, 1));
ws.close(); chrome.kill(); await sleep(300);
rmSync(profile, { recursive: true, force: true });
