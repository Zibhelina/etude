// End-to-end check of the repertoire (the live gallery of every card type): opens types from the
// programme with real clicks, answers them with real mouse and keyboard input through CDP, presses
// Check and reports the verdict the page shows. Also saves a screenshot of each.
//   node site/tools/repertoire.mjs <base-url> <outdir> [width=1440] [height]
// ONLY=chess,math limits the run to some types; SHOTS_ONLY=1 opens each type and screenshots it.
// SUITE=1 drives the new-decks section (#decks) instead, every item of each deck (or ITEMS=n).
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

const [BASE, OUT, WIDTH = "1440", HEIGHT] = process.argv.slice(2);
const SUITE = !!process.env.SUITE;
// Where the card lives: the repertoire, or the new-decks suite (same frames, same scripts).
const A = SUITE
  ? { section: "#decks .suite", frame: ".suite-body iframe", verdict: ".suite-verdict", check: "[data-suite-check]", next: "[data-suite-next]", state: "window.__suite?.()", item: (t) => `[data-suite-type="${t}"]`, list: `[...document.querySelectorAll("[data-suite-type]")].map((b) => b.dataset.suiteType)`, anchor: "#decks" }
  : { section: "#repertoire .rep", frame: ".rep-body iframe", verdict: ".rep-verdict", check: "[data-rep-check]", next: "[data-rep-variant]", state: "window.__rep?.()", item: (t) => `.rep-item[data-type="${t}"]`, list: `[...document.querySelectorAll(".rep-item")].map((b) => b.dataset.type)`, anchor: "#repertoire" };
const width = Number(WIDTH), mobile = width < 700, height = Number(HEIGHT ?? (mobile ? 844 : 900));
mkdirSync(OUT, { recursive: true });
const profile = `${process.env.TMPDIR ?? "/tmp"}/etude-site-rep-${process.pid}`;
const port = 9600 + (process.pid % 40);
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", "--force-color-profile=srgb", "--autoplay-policy=no-user-gesture-required", "about:blank"], { stdio: "ignore" });
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
const pending = new Map(), problems = [], sessions = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  if (d.method === "Runtime.exceptionThrown") problems.push("exception: " + (d.params.exceptionDetails?.exception?.description ?? d.params.exceptionDetails?.text).split("\n")[0]);
  if (d.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(d.params.type)) problems.push(`console.${d.params.type}: ` + d.params.args.map((a) => a.value ?? a.description).join(" "));
  if (d.method === "Target.attachedToTarget" && d.params.targetInfo.type === "iframe") {
    sessions.push(d.params.sessionId);
    send("Runtime.enable", {}, d.params.sessionId);
  }
};
const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
// The site's card frames are same-origin, so they run in the page's process and have no CDP
// session of their own: a "frame:<selector>" context evaluates inside that frame's window instead.
const inFrameExpr = (sel, expr) => `document.querySelector(${JSON.stringify(sel + ":not(.leaving)")}).contentWindow.eval(${JSON.stringify(expr)})`;
const evaluate = async (expr, sessionId) => {
  if (typeof sessionId === "string" && sessionId.startsWith("frame:")) return evaluate(inFrameExpr(sessionId.slice(6), expr));
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
  return r.result?.result?.value;
};
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64")); };
await send("Page.enable"); await send("Runtime.enable");
await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
await send("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 });
await send("Page.navigate", { url: BASE + "index.html" + A.anchor });
await sleep(3000);
await evaluate(`document.documentElement.style.scrollBehavior = "auto"`);
// Pause the hero's autoplay so it doesn't share the CPU or the cursor.
await evaluate(`(() => { const t = document.querySelector(".demo-toggle"); if (t && /Playing/.test(t.textContent)) t.click(); })()`);

async function scrollToRep() {
  await evaluate(`scrollTo(0, document.querySelector(${JSON.stringify(A.section)}).getBoundingClientRect().top + scrollY - ${mobile ? 16 : 80})`);
  await sleep(500);
}
async function center(sel, sid) {
  return evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height }; })()`, sid);
}
async function frameOffset() { return evaluate(`(() => { const r = document.querySelector(${JSON.stringify(A.frame + ":not(.leaving)")}).getBoundingClientRect(); return { x: r.x, y: r.y }; })()`); }
async function mouse(type, x, y, extra = {}) { await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: type === "mouseMoved" ? 0 : 1, pointerType: "mouse", ...extra }); }
async function tap(x, y) {
  if (mobile) {
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await sleep(40);
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else { await mouse("mouseMoved", x, y, { buttons: 0 }); await mouse("mousePressed", x, y, { buttons: 1 }); await mouse("mouseReleased", x, y, { buttons: 0 }); }
}
async function drag(a, b) {
  if (mobile) {
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: a.x, y: a.y }] });
    for (let i = 1; i <= 16; i++) { await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: a.x + ((b.x - a.x) * i) / 16, y: a.y + ((b.y - a.y) * i) / 16 }] }); await sleep(16); }
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    return;
  }
  await mouse("mouseMoved", a.x, a.y, { buttons: 0 });
  await mouse("mousePressed", a.x, a.y, { buttons: 1 });
  for (let i = 1; i <= 16; i++) { await mouse("mouseMoved", a.x + ((b.x - a.x) * i) / 16, a.y + ((b.y - a.y) * i) / 16, { buttons: 1 }); await sleep(16); }
  await mouse("mouseReleased", b.x, b.y, { buttons: 0 });
}
/** Point (in page coordinates) of an element inside the card frame, so the page itself receives the input. */
async function inFrame(sid, sel, at = [0.5, 0.5]) {
  const r = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView?.({ block: "nearest" }); const b = e.getBoundingClientRect(); return { x: b.x + b.width * ${at[0]}, y: b.y + b.height * ${at[1]} }; })()`, sid);
  if (!r) throw new Error(`no ${sel} in the card (${await evaluate(`location.href + " | " + document.body?.innerHTML.slice(0, 200)`, sid).catch((e) => "frame gone " + e.message)} | page: ${await evaluate(`JSON.stringify(${A.state}?.phase) + " " + document.querySelector(${JSON.stringify(A.frame + ":not(.leaving)")})?.src + " " + document.querySelector(${JSON.stringify(A.verdict)}).textContent`)})`);
  const f = await frameOffset();
  return { x: f.x + r.x, y: f.y + r.y };
}
async function svgPoint(sid, sel, x, y) {
  const r = await evaluate(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); const p = s.createSVGPoint(); p.x = ${x}; p.y = ${y}; const q = p.matrixTransform(s.getScreenCTM()); return { x: q.x, y: q.y }; })()`, sid);
  const f = await frameOffset();
  return { x: f.x + r.x, y: f.y + r.y };
}
async function clickIn(sid, sel, at) { const p = await inFrame(sid, sel, at); await keepVisible(p); const q = await inFrame(sid, sel, at); await tap(q.x, q.y); await sleep(120); }
/** Scrolls the page so a point is on screen (the card can be taller than the viewport). */
async function keepVisible(p) {
  // The card's foot (Check, verdict) sticks to the bottom of the screen: keep targets clear of it.
  if (p.y > 90 && p.y < height - 170) return;
  await evaluate(`scrollBy(0, ${Math.round(p.y - height * 0.4)})`);
  await sleep(250);
}
/** Brings a slider closer with arrow keys until `off()` is under `tol`. */
async function nudgeRange(sid, sel, off, tol) {
  let last = await off();
  for (let n = 0; n < 60 && last > tol; n++) {
    await key("ArrowRight", "ArrowRight", 39);
    const now = await off();
    if (now > last) { await key("ArrowLeft", "ArrowLeft", 37); await key("ArrowLeft", "ArrowLeft", 37); for (let m = 0; m < 60 && (await off()) > tol; m++) await key("ArrowLeft", "ArrowLeft", 37); return; }
    last = now;
  }
}
async function typeText(text) { for (const ch of text) await send("Input.dispatchKeyEvent", { type: "char", text: ch }); }
async function key(k, code, keyCode, modifiers = 0) {
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: keyCode, modifiers });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: keyCode, modifiers });
}

/** The CDP session of the current card frame (sandboxed frames run out of process). */
async function frameSession() {
  const src = await evaluate(`document.querySelector(${JSON.stringify(A.frame + ":not(.leaving)")})?.src`);
  for (let k = 0; k < 30; k++) {
    for (const sid of [...sessions].reverse()) {
      const href = await evaluate("location.href", sid).catch(() => null);
      if (href === src) {
        const mounted = await evaluate(`!!document.querySelector("#card")?.children.length`, sid).catch(() => false);
        if (mounted) return sid;
      }
    }
    // Same-origin frame (the site's own cards): no session of its own, so evaluate through its window.
    const local = `frame:${A.frame}`;
    if (await evaluate(`!!document.querySelector("#card")?.children.length`, local).catch(() => false)) return local;
    await sleep(200);
  }
  throw new Error("card frame not found");
}
/** Waits until an expression is true inside the card. */
async function until(sid, expr, ms = 15000) { for (let t = 0; t < ms; t += 200) { if (await evaluate(expr, sid).catch(() => false)) return; await sleep(200); } throw new Error(`timed out waiting for ${expr}`); }
/** A screenshot of the screen, to tell whether the picture changed (a clipped capture skips the WebGL canvas). */
async function frameShot() { return (await send("Page.captureScreenshot", { format: "png" })).result.data; }
const flippyKills = [];
/** The prepared view and key the page holds for the current card (to compute the right answer). */
const state = () => evaluate(A.state);

async function openType(type) {
  await scrollToRep();
  const sel = A.item(type);
  let p = await center(sel);
  if (!p) throw new Error(`no programme entry for ${type}`);
  // On a phone the programme is a horizontal strip: bring the entry into it first.
  await evaluate(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ inline: "center", block: "nearest" })`);
  await sleep(350);
  await scrollToRep();
  p = await center(sel);
  await tap(p.x, p.y);
  await sleep(400);
  return frameSession();
}
async function check() {
  const done = await evaluate(`document.querySelector(${JSON.stringify(A.verdict)}).textContent.trim()`);
  if (done) return done;
  const p = await center(A.check);
  await keepVisible(p);
  const q = await center(A.check);
  await tap(q.x, q.y);
  await sleep(700);
  return evaluate(`document.querySelector(${JSON.stringify(A.verdict)}).textContent.trim()`);
}

// Solvers: real input only. Each reads the prepared key (what the server would hold) to know the answer.
const SOLVE = {
  async typed(sid, s) { await clickIn(sid, "#answer"); await typeText("canberra"); await key("Enter", "Enter", 13); return "enter"; },
  async mcq(sid, s) {
    const i = s.view.options.findIndex((o) => s.key.correct.includes(o.id));
    await clickIn(sid, ".prose"); // give the card the keyboard, then pick with a number key as in the app
    await key(String(i + 1), `Digit${i + 1}`, 49 + i);
    return "auto";
  },
  async estimate(sid, s) {
    const { min, max } = s.view, t = (s.key.answer - min) / (max - min);
    await clickIn(sid, ".es-slider", [t, 0.5]);
    await nudgeRange(sid, ".es-slider", () => evaluate(`Math.abs(Number(document.querySelector(".es-value").textContent.replace(/[^0-9.]/g, "")) - ${s.key.answer}) / ${s.key.answer}`, sid), s.key.tolerance / 3);
  },
  async balance(sid, s) {
    for (let k = 0; k < s.key.solution.length; k++) { await clickIn(sid, `.bl-term[data-k="${k}"] .bl-coef`); await key("a", "KeyA", 65, 2); await typeText(String(s.key.solution[k])); }
    await key("Enter", "Enter", 13);
    return "enter";
  },
  async color(sid, s) {
    const [h, sat, l] = s.key.hsl, want = { h, s: sat, l }, max = { h: 359, s: 100, l: 100 };
    for (const k of ["h", "s", "l"]) {
      const sel = `.co-slider[data-k="${k}"] input`;
      await clickIn(sid, sel, [want[k] / max[k], 0.5]);
      for (let n = 0; n < 40; n++) {
        const v = await evaluate(`Number(document.querySelector(${JSON.stringify(sel)}).value)`, sid);
        if (Math.round(v) === Math.round(want[k])) break;
        await key(v < want[k] ? "ArrowRight" : "ArrowLeft", v < want[k] ? "ArrowRight" : "ArrowLeft", v < want[k] ? 39 : 37);
      }
    }
  },
  async interval(sid, s) {
    await clickIn(sid, ".iv-btn"); // hear it first: a real gesture starts the audio
    await sleep(1200);
    await clickIn(sid, `.iv-opt[data-id="${s.key.answer}"]`);
  },
  async timeline(sid, s) {
    for (const [id, year] of Object.entries(s.key.years)) {
      const a = await inFrame(sid, `.tl-chip[data-id="${id}"]`);
      await keepVisible(a);
      const a2 = await inFrame(sid, `.tl-chip[data-id="${id}"]`);
      const t = (year - s.view.from) / (s.view.to - s.view.from);
      const b = await inFrame(sid, ".tl", [t, 0.5]);
      await drag(a2, b);
      await sleep(250);
    }
  },
  async code(sid, s) {
    await clickIn(sid, ".cm-content");
    await key("a", "KeyA", 65, 2); // Ctrl+A
    await send("Input.insertText", { text: s.fields.reference });
    await sleep(300);
  },
  async sprint(sid, s) {
    await clickIn(sid, ".sp-start");
    await sleep(300);
    for (let k = 0; k < s.view.target + 1; k++) { await typeText(String(s.key.answers[k])); await key("Enter", "Enter", 13); await sleep(90); }
    await sleep(31000);
    return "auto";
  },
  async typing(sid, s) {
    await clickIn(sid, ".ty-box");
    await sleep(200);
    // The 25-word item ends itself on the last word; a timed one ends when the clock runs out.
    for (const w of s.view.words.slice(0, s.view.seconds ? 30 : undefined)) { await typeText(w + " "); await sleep(60); }
    if (s.view.seconds) await sleep(s.view.seconds * 1000 + 500);
    return "auto";
  },
  async match(sid, s) {
    for (const [l, r] of Object.entries(s.key.pairs)) { await clickIn(sid, `.chip[data-id="${l}"]`); await clickIn(sid, `.chip[data-id="${r}"]`); }
  },
  async cloze(sid, s) {
    for (let i = 0; i < s.key.answers.length; i++) { await clickIn(sid, `input[data-i="${i}"]`); await typeText(s.key.answers[i][0]); }
  },
  async numeric(sid, s) { await clickIn(sid, "input[data-part='0']"); await typeText(`${s.key.parts[0].answer} km/h`); },
  async order(sid, s) {
    if (mobile) {
      // Touch: drag each block up into its place.
      for (let target = 0; target < s.key.order.length; target++) {
        const idNow = s.key.order[target];
        const a = await inFrame(sid, `.block[data-id="${idNow}"] .grip`);
        await keepVisible(a);
        const a2 = await inFrame(sid, `.block[data-id="${idNow}"] .grip`);
        const b = await inFrame(sid, `.blocks .block:nth-child(${target + 1})`, [0.05, 0.3]);
        if (Math.abs(b.y - a2.y) > 4) await drag(a2, { x: a2.x, y: b.y });
        await sleep(300);
      }
      return;
    }
    // Keyboard reordering: focus a block, Alt+arrow moves it.
    for (let target = 0; target < s.key.order.length; target++) {
      const idNow = s.key.order[target];
      const pos = await evaluate(`[...document.querySelectorAll(".block")].findIndex((b) => b.dataset.id === ${JSON.stringify(idNow)})`, sid);
      await clickIn(sid, `.block[data-id="${idNow}"] .num`);
      for (let k = pos; k > target; k--) { await key("ArrowUp", "ArrowUp", 38, 1); await sleep(60); }
    }
  },
  async math(sid, s) {
    const p = String(s.view.prompt ?? s.fields.prompt);
    await clickIn(sid, "#answer");
    await typeText(mathAnswer(p, s));
  },
  async chess(sid, s) { const a = s.key.answers[0]; await clickIn(sid, `[data-sq="${a.slice(0, 2)}"]`); await clickIn(sid, `[data-sq="${a.slice(2, 4)}"]`); },
  async chord(sid, s) {
    for (const pc of s.key.pcs) await clickIn(sid, `.cd-kb .key[data-m="${48 + pc}"]`, [1, 3, 6, 8, 10].includes(pc) ? [0.5, 0.45] : [0.5, 0.86]);
  },
  async "graph-walk"(sid, s) { for (const n of s.key.order) await clickIn(sid, `.gw-node[data-id="${n}"]`); },
  async regex(sid, s) { await clickIn(sid, ".rx-pattern"); await typeText(s.key.solution ?? s.fields.solution); },
  async "bug-hunt"(sid, s) { for (const l of s.key.bugs) await clickIn(sid, `.bh-line[data-n="${l}"]`); },
  async bits(sid, s) { for (let i = 0; i < s.key.pattern.length; i++) if (s.key.pattern[i] === "1") await clickIn(sid, `.bt-attempt .bt-bit[data-i="${i}"]`); },
  async plot(sid, s) { for (const [x, y] of s.key.points) { const p = await svgPoint(sid, ".pl-svg", x, -y); await keepVisible(p); const q = await svgPoint(sid, ".pl-svg", x, -y); await tap(q.x, q.y); await sleep(150); } },
  async staff(sid, s) { await clickIn(sid, `.st-kb .key[data-m="${60 + s.key.pc}"]`, [1, 3, 6, 8, 10].includes(s.key.pc) ? [0.5, 0.45] : [0.5, 0.86]); },
  async "unit-circle"(sid, s) { const t = (s.key.target * Math.PI) / 180; const p = await svgPoint(sid, ".uc-svg", 0.92 * Math.cos(t), -0.92 * Math.sin(t)); await keepVisible(p); const q = await svgPoint(sid, ".uc-svg", 0.92 * Math.cos(t), -0.92 * Math.sin(t)); await tap(q.x, q.y); },
  // The new Market decks.
  async "country-map"(sid, s) {
    if (s.view.face !== "locate") { await clickIn(sid, ".cm-input"); await typeText(s.key.country); await key("Enter", "Enter", 13); return "enter"; }
    // A point inside the country's own shape (or its dot, for a small one), on screen.
    const at = await evaluate(`(() => {
      const i = ${s.key.index}, svg = document.querySelector(".cm-svg"), path = document.querySelector('.cm-land [data-i="' + i + '"]');
      const dot = document.querySelector('.cm-dots [data-i="' + i + '"]');
      const box = svg.getBoundingClientRect(), m = svg.getScreenCTM(), pt = svg.createSVGPoint();
      const ok = (q) => q.x > box.left + 4 && q.x < box.right - 4 && q.y > box.top + 4 && q.y < box.bottom - 4;
      if (path) { const b = path.getBBox(); for (let k = 0; k < 4000; k++) { pt.x = b.x + b.width * ((k * 0.618) % 1); pt.y = b.y + b.height * ((k * 0.382 + 0.5) % 1); if (path.isPointInFill(pt)) { const q = pt.matrixTransform(m); if (ok(q)) return { x: q.x, y: q.y }; } } }
      if (dot) { const r = dot.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }
      return null; })()`, sid);
    if (!at) throw new Error("country not on the map");
    const f = await frameOffset();
    await keepVisible({ x: f.x + at.x, y: f.y + at.y });
    const f2 = await frameOffset();
    await tap(f2.x + at.x, f2.y + at.y);
    await sleep(300);
  },
  async element(sid, s) {
    const t = s.key.tile;
    switch (s.view.mode) {
      case "locate": await clickIn(sid, `.pt-cell[data-z="${t.z}"]`); return;
      case "identify": await clickIn(sid, ".pt-in"); await typeText(t.symbol); await key("Enter", "Enter", 13); return "enter";
      case "name": await clickIn(sid, ".pt-in"); await typeText(t.name); await key("Enter", "Enter", 13); return "enter";
      case "symbol": await clickIn(sid, ".pt-in"); await typeText(t.symbol); await key("Enter", "Enter", 13); return "enter";
      case "config": await clickIn(sid, ".pt-in"); await typeText(s.key.config); return;
      case "family": await clickIn(sid, `.pt-fam[data-v="${t.family}"]`); await clickIn(sid, `.pt-blk[data-v="${t.blocks[0]}"]`); return;
      case "numbers": for (const p of s.view.parts) { await clickIn(sid, `input[data-p="${p}"]`); await typeText(String(s.key[p])); } return;
      case "mass": await clickIn(sid, ".pt-in"); await typeText(String(s.key.mass)); return;
    }
  },
  async flippy(sid) {
    // Start the game, then shoot down invaders by flipping their bits: keys 1-8 on a desktop, taps on the bit tiles on a phone.
    await clickIn(sid, ".fb-canvas", [0.5, 0.4]);
    await sleep(600);
    const W = 480, H = 576, tile = (i) => [(12 + i * 57 + 28.5) / W, (458 + 29) / H];
    const target = Number(process.env.KILLS ?? 3);
    for (let n = 0; n < 400; n++) {
      const st = await evaluate(`(() => { const d = document.querySelector(".fb-stage")?.dataset ?? {}; return { phase: d.phase, kills: Number(d.kills), next: d.next }; })()`, sid);
      if (st.kills >= target || st.phase !== "play") break;
      if (st.next) {
        const v = Number(st.next);
        for (let i = 0; i < 8; i++) if (v & (1 << (7 - i))) {
          if (mobile) { const p = await inFrame(sid, ".fb-canvas", tile(i)); await tap(p.x, p.y); }
          else await key(String(i + 1), `Digit${i + 1}`, 49 + i);
          await sleep(70);
        }
        await sleep(900);
      } else await sleep(250);
    }
    const kills = await evaluate(`Number(document.querySelector(".fb-stage").dataset.kills)`, sid);
    flippyKills.push(kills);
    // Then let one land: the game ends itself and the card submits the run.
    for (let n = 0; n < 120; n++) { if ((await evaluate(`document.querySelector(${JSON.stringify(A.verdict)}).textContent.trim()`)).length) break; await sleep(500); }
    return "auto";
  },
  async basic() { return "self"; },
  async free(sid) {
    await clickIn(sid, ".cm-content");
    await send("Input.insertText", { text: "Base case: $n = 1$ gives $1 = 1$. Step: add $n + 1$ to both sides." });
    await sleep(300);
  },
  async draw(sid) {
    const a = await inFrame(sid, ".canvas", [0.3, 0.3]), b = await inFrame(sid, ".canvas", [0.7, 0.6]);
    await keepVisible(a); const a2 = await inFrame(sid, ".canvas", [0.3, 0.3]), b2 = await inFrame(sid, ".canvas", [0.7, 0.6]);
    await drag(a2, b2);
  },
};
function mathAnswer(p, s) {
  const m = /x\^\{(\d)\}\s*(\\sin x|\\cos x|e\^\{x\}|\\ln x)/.exec(p);
  if (m) {
    const n = Number(m[1]), lo = n - 1 === 1 ? "x" : `x^${n - 1}`;
    return { "\\sin x": `${lo}(${n}sin(x) + x cos(x))`, "\\cos x": `${lo}(${n}cos(x) - x sin(x))`, "e^{x}": `${lo}e^x(${n} + x)`, "\\ln x": `${lo}(${n}ln(x) + 1)` }[m[2]];
  }
  return String(s.key.answers?.[0] ?? s.fields.answers?.[0] ?? "");
}

const report = [];
async function solveCurrent(type, sid, row) {
  const s = await state();
  row.item = s.item ?? undefined;
  const how = await (SOLVE[type] ?? (async () => "skip"))(sid, s);
  if (how === "skip") row.skipped = true;
  await sleep(300);
  if (how === "auto" || how === "enter") { await sleep(700); row.verdict = await evaluate(`document.querySelector(${JSON.stringify(A.verdict)}).textContent.trim()`); }
  if (!row.verdict) row.verdict = await check();
  const g = SUITE ? await evaluate(`window.__suite?.()?.grade`) : null;
  if (g) row.score = g.score;
}
if (SUITE) {
  const only = process.env.ONLY?.split(",");
  const types = (await evaluate(A.list)).filter((t) => !only || only.includes(t));
  for (const type of types) {
    const n = await evaluate(`(() => { const e = window.__suiteCount?.(${JSON.stringify(type)}); return e ?? 1; })()`);
    for (let k = 0; k < Math.min(n, Number(process.env.ITEMS ?? 99)); k++) {
      const row = { type };
      try {
        let sid;
        if (k === 0) sid = await openType(type);
        else { const p = await center(A.next); await keepVisible(p); const q = await center(A.next); await tap(q.x, q.y); await sleep(700); sid = await frameSession(); }
        await sleep(600);
        await solveCurrent(type, sid, row);
        await sleep(500);
        await scrollToRep();
        await shot(`suite-${type}-${k}`);
      } catch (e) { row.error = String(e.message ?? e).split("\n")[0]; }
      report.push(row);
    }
  }
  console.log(JSON.stringify({ width, report, flippyKills, problems }, null, 1));
  ws.close(); chrome.kill(); await sleep(300);
  rmSync(profile, { recursive: true, force: true });
  process.exit(0);
}
const ONLY = process.env.ONLY?.split(",");
const types = (await evaluate(A.list)).filter((t) => !ONLY || ONLY.includes(t));
for (const type of types) {
  const row = { type };
  try {
    const sid = await openType(type);
    await sleep(600);
    if (process.env.SHOTS_ONLY) { await scrollToRep(); await shot(`open-${type}`); report.push(row); continue; }
    const s = await state();
    const how = await (SOLVE[type] ?? (async () => "skip"))(sid, s);
    if (how === "skip") row.skipped = true;
    await sleep(300);
    if (how === "auto" || how === "enter") { await sleep(700); row.verdict = await evaluate(`document.querySelector(${JSON.stringify(A.verdict)}).textContent.trim()`); }
    if (!row.verdict) row.verdict = await check();
    await sleep(500);
    await scrollToRep();
    await shot(`graded-${type}`);
  } catch (e) { row.error = String(e.message ?? e).split("\n")[0]; }
  report.push(row);
}
console.log(JSON.stringify({ width, report, problems }, null, 1));
ws.close(); chrome.kill(); await sleep(300);
rmSync(profile, { recursive: true, force: true });
