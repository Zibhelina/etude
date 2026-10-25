// Captures real Etude screens for the website over CDP.
// Usage: node site/tools/shoot.mjs <base-url> <outdir> <spec.json>
// spec: [{ name, url, width, height, scale, mobile, wait, steps: [js], clip: {x,y,width,height} | "selector" }]
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
const [BASE, OUT, SPEC] = process.argv.slice(2);
const specs = JSON.parse(readFileSync(SPEC, "utf8"));
mkdirSync(OUT, { recursive: true });
const profile = `${process.env.TMPDIR ?? "/tmp"}/etude-site-shoot-${process.pid}`;
const port = 9400 + (process.pid % 50);
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
const pending = new Map();
const errors = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails?.exception?.description?.split("\n")[0] ?? "exception");
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
await send("Page.enable");
await send("Runtime.enable");
for (const s of specs) {
  errors.length = 0;
  await send("Emulation.setDeviceMetricsOverride", { width: s.width ?? 1440, height: s.height ?? 900, deviceScaleFactor: s.scale ?? 2, mobile: !!s.mobile });
  await send("Emulation.setTouchEmulationEnabled", { enabled: !!s.mobile, maxTouchPoints: s.mobile ? 5 : 0 });
  await send("Emulation.setSafeAreaInsetsOverride", { insets: s.mobile ? { top: 59, bottom: 34, left: 0, right: 0 } : { top: 0, bottom: 0, left: 0, right: 0 } });
  await send("Page.navigate", { url: BASE + s.url });
  await sleep(s.wait ?? 2500);
  for (const st of s.steps ?? []) { const r = await evaluate(st); if (r !== undefined) console.log(s.name, "step:", JSON.stringify(r).slice(0, 200)); await sleep(s.stepWait ?? 900); }
  let clip;
  if (typeof s.clip === "string") {
    const box = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(s.clip)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    if (box) clip = { ...box, scale: 1 };
    else console.error(s.name, "clip selector missing", s.clip);
  } else if (s.clip) clip = { ...s.clip, scale: 1 };
  const r = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
  writeFileSync(`${OUT}/${s.name}.png`, Buffer.from(r.result.data, "base64"));
  if (errors.length) console.error(s.name, "errors", errors.join(" | "));
  console.log("shot", s.name);
}
ws.close(); chrome.kill(); await sleep(300);
rmSync(profile, { recursive: true, force: true });
