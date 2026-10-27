// Store screenshots: captures the real Etude web app (the same build the phone apps wrap) in
// headless Chromium at each store size, then sets each capture under a short caption in the
// website's typography, at the exact pixel size App Store Connect and Play Console ask for.
//   node store/tools/screens.mjs <app-url> <outdir> [only-target]
// The app should run on a scratch collection (see store/README.md). Console errors fail the run.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const [APP, OUT, ONLY] = process.argv.slice(2);
if (!APP || !OUT) throw new Error("usage: screens.mjs <app-url> <outdir> [target]");
const here = fileURLToPath(new URL(".", import.meta.url));
const fonts = fileURLToPath(new URL("../../site/dist/", import.meta.url));

// Output sizes. css = the app's viewport width inside the frame; the height follows the frame.
const TARGETS = [
  { id: "iphone-6.9", w: 1320, h: 2868, css: 390, store: "App Store, iPhone 6.9\"" },
  { id: "iphone-6.5", w: 1284, h: 2778, css: 390, store: "App Store, iPhone 6.5\"" },
  { id: "ipad-13", w: 2064, h: 2752, css: 900, store: "App Store, iPad 13\"" },
  { id: "android-phone", w: 1080, h: 1920, css: 390, store: "Google Play, phone" },
  { id: "android-7in", w: 1200, h: 1920, css: 600, store: "Google Play, 7\" tablet" },
  { id: "android-10in", w: 1600, h: 2560, css: 800, store: "Google Play, 10\" tablet" },
];

// The scenes, in store order. steps run in the page after it loads; ready waits for a condition.
const deck = (n) => encodeURIComponent(n);
const SCENES = [
  { id: "01-decks", caption: "Practice <em>anything.</em>", sub: "Your decks, on your device.", url: "/" },
  {
    id: "02-map", caption: "Cards that are <em>small apps.</em>", sub: "Tap the country on a real map.",
    url: `/study?deck=${deck("Geography::Countries of the World::South America")}`, frame: true,
  },
  {
    id: "03-elements", caption: "Find it on a <em>blank table.</em>", sub: "The periodic table, one cell at a time.",
    url: `/study?deck=${deck("Chemistry::Periodic table::3 Find it on the table")}`, frame: true,
  },
  {
    id: "04-morse", caption: "Tap it out. <em>Get graded.</em>", sub: "Morse, music, code, maths and more.",
    url: `/study?deck=${deck("Morse code::Letters")}`, frame: true,
  },
  { id: "05-stats", caption: "See what you <em>remember.</em>", sub: "FSRS schedules every review.", url: "/stats" },
  // The phone apps hide Publish and the GitHub link (no local server); hide them here too.
  { id: "06-market", caption: "Free decks, <em>ready to go.</em>", sub: "Install from the Market in one tap.", url: "/market", steps: [`[...document.querySelectorAll("a,button")].filter((e) => /^(Publish|Browse on GitHub)$/.test(e.innerText.trim())).map((e) => (e.style.display = "none")).length`] },
];

const profile = join(process.env.TMPDIR ?? "/tmp", `etude-store-shots-${process.pid}`);
const port = 9300 + (process.pid % 60);
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", "--force-color-profile=srgb", "--allow-file-access-from-files", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
try {
  let ws;
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
      await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
      break;
    } catch { await sleep(200); }
  }
  let id = 0, current = "";
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    if (d.method === "Runtime.exceptionThrown") problems.push(`${current}: exception ${d.params.exceptionDetails?.exception?.description?.split("\n")[0] ?? d.params.exceptionDetails?.text}`);
    if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") problems.push(`${current}: console.error ${d.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 200)}`);
    if (d.method === "Log.entryAdded" && d.params.entry.level === "error") problems.push(`${current}: log ${d.params.entry.text.slice(0, 200)} ${d.params.entry.url ?? ""}`);
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

  const layout = (t) => {
    const pad = Math.round(t.w * 0.07);
    const capH = Math.round(t.h * (t.w / t.h > 0.6 ? 0.17 : 0.19));
    const screenW = t.w - pad * 2;
    const screenH = t.h - capH - pad;
    return { pad, capH, screenW, screenH, scale: screenW / t.css };
  };

  const report = [];
  for (const t of TARGETS.filter((t) => !ONLY || t.id === ONLY)) {
    const L = layout(t);
    const cssH = Math.ceil((L.screenH + L.pad) / L.scale);
    mkdirSync(join(OUT, "raw", t.id), { recursive: true });
    mkdirSync(join(OUT, t.id), { recursive: true });
    for (const s of SCENES) {
      current = `${t.id}/${s.id}`;
      const mobile = t.css < 700;
      await send("Emulation.setDeviceMetricsOverride", { width: t.css, height: cssH, deviceScaleFactor: L.scale, mobile });
      await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      await send("Page.navigate", { url: APP + s.url });
      await sleep(2500);
      if (s.frame) {
        // Wait until the card frame has drawn something.
        for (let i = 0; i < 20; i++) { if (await evaluate(`!!document.querySelector("iframe") && document.querySelector("iframe").getBoundingClientRect().height > 100`)) break; await sleep(300); }
        await sleep(1500);
      }
      for (const st of s.steps ?? []) { await evaluate(st); await sleep(400); }
      const text = await evaluate(`document.body.innerText.slice(0, 160).replace(/\\s+/g, " ")`);
      const raw = join(OUT, "raw", t.id, `${s.id}.png`);
      const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      writeFileSync(raw, Buffer.from(shot.result.data, "base64"));
      report.push({ target: t.id, scene: s.id, text });
    }
    // Compose: one page at the exact output size, device scale 1.
    for (const s of SCENES) {
      current = `${t.id}/${s.id} compose`;
      await send("Emulation.setDeviceMetricsOverride", { width: t.w, height: t.h, deviceScaleFactor: 1, mobile: false });
      await send("Emulation.setTouchEmulationEnabled", { enabled: false });
      const html = composePage(t, L, s, `file://${join(OUT, "raw", t.id, `${s.id}.png`)}`);
      const file = join(OUT, "raw", t.id, `${s.id}.html`);
      writeFileSync(file, html);
      await send("Page.navigate", { url: `file://${file}` });
      await sleep(700);
      await evaluate(`document.fonts.ready.then(() => true)`);
      const shot = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(OUT, t.id, `${s.id}.png`), Buffer.from(shot.result.data, "base64"));
    }
    console.log("done", t.id, `${t.w}x${t.h}`, `app viewport ${t.css}x${cssH} @${L.scale.toFixed(2)}`);
  }
  writeFileSync(join(OUT, "raw", "report.json"), JSON.stringify({ report, problems }, null, 1));
  ws.close();
} finally {
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log("0 console errors");

function composePage(t, L, s, img) {
  const cap = Math.round(t.w * (t.w / t.h > 0.6 ? 0.058 : 0.074));
  const sub = Math.round(cap * 0.42);
  const radius = Math.round(L.screenW * 0.06);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: "Inter"; src: url("file://${fonts}assets/fonts/inter.woff2") format("woff2"); font-weight: 100 900; }
@font-face { font-family: "KaTeX_Main"; src: url("file://${fonts}runtime/vendor/fonts/KaTeX_Main-Regular.woff2") format("woff2"); font-style: normal; }
@font-face { font-family: "KaTeX_Main"; src: url("file://${fonts}runtime/vendor/fonts/KaTeX_Main-Italic.woff2") format("woff2"); font-style: italic; }
html, body { margin: 0; width: ${t.w}px; height: ${t.h}px; overflow: hidden; background: oklch(0.145 0.004 85); color: oklch(0.96 0.004 85); }
.cap { position: absolute; left: ${L.pad}px; right: ${L.pad}px; top: 0; height: ${L.capH}px; display: flex; flex-direction: column; justify-content: center; }
h1 { margin: 0; font: 400 ${cap}px/1.08 "KaTeX_Main", Georgia, serif; letter-spacing: -0.01em; }
h1 em { font-style: italic; background: linear-gradient(transparent 82%, oklch(0.7 0.19 350 / 0.85) 82%, oklch(0.7 0.19 350 / 0.85) 90%, transparent 90%); }
p { margin: ${Math.round(sub * 0.7)}px 0 0; font: 400 ${sub}px/1.35 "Inter", sans-serif; color: oklch(0.72 0.01 85); }
.screen { position: absolute; left: ${L.pad}px; top: ${L.capH}px; width: ${L.screenW}px; height: ${L.screenH + L.pad}px; border-radius: ${radius}px ${radius}px 0 0; overflow: hidden; box-shadow: 0 0 0 ${Math.max(2, Math.round(t.w / 500))}px oklch(1 0 0 / 0.1); }
.screen img { display: block; width: ${L.screenW}px; }
</style></head><body><div class="cap"><h1>${s.caption}</h1><p>${s.sub}</p></div><div class="screen"><img src="${img}"></div></body></html>`;
}
