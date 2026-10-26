// The Etude website. Everything that looks live is: the hero runs real card types with the app's
// card runtime and grades them with the types' own scripts; the deadline chart runs ts-fsrs.
import katex from "../runtime/vendor/katex.js";
import math from "../runtime/mathexpr.js";
import { DEMOS, PRELUDE, TYPE_FILES, GENERATOR, GALLERY, SCHEDULERS } from "../data.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const tex = (s, display = false) => katex.renderToString(s, { throwOnError: false, displayMode: display, output: "html" });
/** Inline markdown that's enough for prompts and feedback: $math$, $$display$$, **bold**, *italic*, `code`. */
function md(s) {
  return String(s ?? "")
    .split(/(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`|\n\n)/)
    .map((p) => {
      if (p.startsWith("$$")) return tex(p.slice(2, -2), true);
      if (p.startsWith("$") && p.length > 2) return tex(p.slice(1, -1));
      if (p.startsWith("**")) return `<strong>${esc(p.slice(2, -2))}</strong>`;
      if (p.startsWith("*") && p.length > 2) return `<em>${esc(p.slice(1, -1))}</em>`;
      if (p.startsWith("`")) return `<code>${esc(p.slice(1, -1))}</code>`;
      if (p === "\n\n") return "<br>";
      return esc(p);
    })
    .join("");
}
/** Runs `fn` once when `el` first scrolls into view. */
function whenVisible(el, fn, margin = "0px 0px -15% 0px") {
  if (!el) return;
  const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && (io.disconnect(), fn())), { rootMargin: margin });
  io.observe(el);
}
/** Tracks whether `el` is on screen, for loops that should pause off screen. */
function visibility(el) {
  const state = { on: false };
  new IntersectionObserver((es) => es.forEach((e) => (state.on = e.isIntersecting)), { threshold: 0.2 }).observe(el);
  return state;
}

/**
 * Card frames load without a blank flash: the card on screen stays (and stops taking input) while
 * the next one loads out of sight, and the skeleton only shows when loading takes long enough to
 * notice, as it does on a first visit or a slow connection. Switching between cached cards is a
 * crossfade.
 */
function frameSwapper(body, loader) {
  let timer = null, shown = null;
  return {
    add(frame) {
      clearTimeout(timer);
      for (const f of $$("iframe", body)) if (f !== shown) f.remove();
      if (shown) {
        // Lift the old card out of the flow where it is, so the new one can take its place.
        const { offsetTop: top, offsetLeft: left, offsetWidth: width } = shown;
        Object.assign(shown.style, { position: "absolute", top: `${top}px`, left: `${left}px`, width: `${width}px` });
        shown.classList.add("leaving");
      }
      body.appendChild(frame);
      const slow = () => { shown?.classList.add("gone"); loader.classList.remove("hide"); };
      if (shown) timer = setTimeout(slow, 220); else slow();
    },
    mounted(frame) {
      clearTimeout(timer);
      if (shown && shown !== frame) shown.remove();
      shown = frame;
      frame.classList.remove("loading");
      frame.classList.add("enter");
      loader.classList.add("hide");
    },
  };
}
// Card frames on this site are same-origin (allow-same-origin): every card here is one of
// Etude's own types, and a same-origin frame shares the page's HTTP cache, so KaTeX, the runtime
// and the fonts download once instead of once per card. The app keeps its frames opaque-origin,
// because there a card can come from anyone.
const SANDBOX = "allow-scripts allow-same-origin";
// The scheduler is small and every rating needs it: fetch it once the page is idle.
const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 4000 }) : setTimeout(fn, 1500));
let prefetched = false;
/** Once the first card is up: the scheduler and the other hero cards, so the next ones open at once. */
function prefetchFrames() {
  if (prefetched || navigator.connection?.saveData) return;
  prefetched = true;
  loadFsrs();
  for (const d of DEMOS) {
    const l = document.createElement("link");
    l.rel = "prefetch"; l.href = `frames/${d.type}.html`;
    document.head.appendChild(l);
  }
}

// ------------------------------------------------------------------ page chrome
const nav = $("#nav");
const onScroll = () => nav.classList.toggle("scrolled", scrollY > 8);
addEventListener("scroll", onScroll, { passive: true });
onScroll();

const revealer = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && (e.target.classList.add("in"), revealer.unobserve(e.target))), { rootMargin: "0px 0px -8% 0px" });
$$("[data-reveal]").forEach((el) => revealer.observe(el));

for (const b of $$("[data-copy]")) {
  b.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); } catch { return; }
    b.classList.add("done");
    setTimeout(() => b.classList.remove("done"), 1400);
  });
}

fetch("https://api.github.com/repos/Zibhelina/etude")
  .then((r) => (r.ok ? r.json() : null))
  .then((d) => {
    const n = d?.stargazers_count;
    const el = $("[data-stars]");
    if (el && n > 0) { el.textContent = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); el.hidden = false; }
  })
  .catch(() => {});

// ------------------------------------------------- the card engine, in the page
// Same helpers as the server's QuickJS sandbox (src/core/sandbox.ts), same seeding as the engine.
function runScript(body, params, args, seed) {
  const bindings = params.map((p) => (p === "rng" ? `__makeRng(${seed >>> 0})` : `__args[${JSON.stringify(p)}]`)).join(", ");
  const src = `${PRELUDE}\nstd.math = __math;\nconst __fn = function (${params.join(", ")}) {\n${body}\n};\nreturn JSON.stringify(__fn(${bindings}) ?? null);`;
  return JSON.parse(new Function("__args", "__math", src)(args, math));
}
function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function prepare(demo, seed, face = "main") {
  let fields = { ...demo.fields };
  if (typeof fields.generator === "string") {
    fields = { ...fields, ...runScript(fields.generator, ["rng"], {}, seed) };
    delete fields.generator;
  }
  if (demo.prepare) {
    const out = runScript(demo.prepare, ["fields", "face", "rng"], { fields, face }, hashString(`${seed}:${demo.id}:${face}`));
    return { view: out?.view ?? {}, key: out?.key ?? {}, fields };
  }
  const view = {}, key = {};
  for (const [k, v] of Object.entries(fields)) (demo.private.includes(k) ? key : view)[k] = v;
  return { view, key, fields };
}
const verdictOf = (s) => (s == null ? "ungraded" : s >= 0.999 ? "correct" : s <= 0.001 ? "incorrect" : "partial");
const suggest = (s) => (s == null ? null : s >= 0.95 ? 3 : s >= 0.5 ? 2 : 1);
function grade(demo, prep, answer) {
  const t0 = performance.now();
  const out = runScript(demo.grade, ["answer", "view", "key", "fields"], { answer, view: prep.view, key: prep.key, fields: prep.fields }) ?? {};
  const score = out.score == null ? null : Math.max(0, Math.min(1, Number(out.score)));
  return { score, verdict: verdictOf(score), feedback: out.feedback, details: out.details, suggested: suggest(score), grader: { kind: "script", ms: Math.max(1, Math.round(performance.now() - t0)) } };
}

const THEME_VARS = ["--background", "--foreground", "--card", "--card-foreground", "--popover", "--popover-foreground", "--muted", "--muted-foreground", "--secondary", "--secondary-foreground", "--border", "--input", "--primary", "--primary-foreground", "--accent", "--accent-foreground", "--ring", "--destructive", "--success", "--warning", "--danger", "--highlight", "--again", "--hard", "--good", "--easy", "--new", "--learn", "--review", "--radius", "--font-sans", "--font-mono"];
function theme() {
  const cs = getComputedStyle(document.documentElement);
  const vars = {};
  for (const v of THEME_VARS) { const val = cs.getPropertyValue(v).trim(); if (val) vars[v] = val; }
  return { scheme: "dark", vars };
}

function humanInterval(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h`;
  const d = h / 24;
  if (d < 30) return `${d < 10 ? Math.round(d * 10) / 10 : Math.round(d)}d`.replace(".0d", "d");
  const mo = d / 30.4;
  if (mo < 12) return `${Math.round(mo * 10) / 10}mo`.replace(".0mo", "mo");
  return `${Math.round((d / 365) * 10) / 10}y`.replace(".0y", "y");
}
const RATING = { 1: "Again", 2: "Hard", 3: "Good", 4: "Easy" };
const VERDICT = { correct: "Correct", partial: "Partly right", incorrect: "Not quite" };
/** A drill's numbers, the way the app shows them after a run: "5 invaders · 0.74 s per invader". */
const metricLine = (metrics, details) => metrics
  .map((m) => { const v = details?.[m.key]; return v == null ? null : `<b class="tabular">${Number(v).toFixed(m.digits ?? 0)}${m.unit === "%" ? "%" : m.unit ? ` ${m.unit}` : ""}</b> ${esc(m.label.toLowerCase().replace(m.unit === "s" ? /^seconds\s+/ : /^$/, ""))}`; })
  .filter(Boolean).join(" · ");

let fsrsMod = null;
const loadFsrs = () => (fsrsMod ??= import("../vendor/ts-fsrs.js"));

// ---------------------------------------------------------------- the hero stage
const stage = $("#stage");
if (stage) {
  const tabs = $(".stage-tabs", stage), body = $(".stage-body", stage), loader = $(".stage-loader", stage);
  const checkBtn = $("[data-check]", stage), verdictEl = $(".verdict", stage), ratings = $(".ratings", stage);
  let cur = null; // { demo, prep, seed, frame, phase, result }
  const stageVis = visibility(stage);
  const swap = frameSwapper(body, loader);
  let index = 0;

  if (!tabs.children.length) tabs.innerHTML = DEMOS.map((d, i) => `<button class="stage-tab" role="tab" type="button" aria-selected="${i === 0}" data-i="${i}">${esc(d.label)}</button>`).join("");
  tabs.addEventListener("click", (e) => {
    const b = e.target.closest("[data-i]");
    if (b) open(Number(b.dataset.i));
  });

  const post = (msg) => cur?.frame.contentWindow?.postMessage({ etude: 1, ...msg }, "*");
  // Fade the window's edges only where the card actually continues.
  const edges = () => {
    const scrolls = body.scrollHeight > body.clientHeight + 2;
    body.classList.toggle("scrolls", scrolls);
    body.classList.toggle("scrolled", scrolls && body.scrollTop > 4);
    body.classList.toggle("at-end", scrolls && body.scrollTop + body.clientHeight >= body.scrollHeight - 4);
  };
  body.addEventListener("scroll", edges, { passive: true });

  function open(i, seed = (Math.random() * 2 ** 32) >>> 0) {
    index = i;
    const demo = DEMOS[i];
    $$(".stage-tab", tabs).forEach((t, j) => t.setAttribute("aria-selected", String(j === i)));
    // Scroll the tab strip only: scrollIntoView would also scroll the page back up to the hero.
    const t = $(`[data-i="${i}"]`, tabs);
    if (t) tabs.scrollTo({ left: t.offsetLeft - tabs.clientWidth / 2 + t.offsetWidth / 2, behavior: reduced ? "auto" : "smooth" });
    verdictEl.innerHTML = "";
    ratings.hidden = true;
    checkBtn.parentElement.hidden = false;
    checkBtn.disabled = true;
    let prep;
    try { prep = prepare(demo, seed); } catch (e) { verdictEl.textContent = `Couldn't prepare the card: ${e.message}`; return; }
    const old = cur?.frame;
    const frame = document.createElement("iframe");
    frame.title = `${demo.name} card`;
    frame.setAttribute("sandbox", SANDBOX);
    frame.className = "loading";
    frame.style.height = old ? old.style.height : "380px";
    frame.src = `frames/${demo.type}.html`;
    cur = { demo, prep, seed, frame, phase: "loading", ready: true };
    swap.add(frame);
    body.scrollTop = 0;
  }

  addEventListener("message", (e) => {
    if (!cur || e.source !== cur.frame.contentWindow) return;
    const msg = e.data;
    if (!msg || msg.etude !== 1) return;
    switch (msg.type) {
      case "loaded":
        post({ type: "init", view: cur.prep.view, mode: "answer", answer: null, result: null, theme: theme() });
        break;
      case "mounted":
        cur.phase = "answer";
        swap.mounted(cur.frame);
        checkBtn.disabled = !cur.ready;
        idle(prefetchFrames);
        break;
      case "size":
        if (typeof msg.height === "number") cur.frame.style.height = `${Math.max(120, Math.min(msg.height + 4, 2000))}px`;
        requestAnimationFrame(edges);
        break;
      case "ready-state":
        cur.ready = !!msg.ready;
        if (cur.phase === "answer") checkBtn.disabled = !cur.ready;
        break;
      case "submit":
        onSubmit(msg.answer);
        break;
      case "key":
        if (msg.key === "Mod+Enter" && cur.phase === "answer") post({ type: "collect" });
        else if (cur.phase === "result" && /^[1-4]$/.test(msg.key)) rate(Number(msg.key));
        else if (cur.phase === "result" && (msg.key === " " || msg.key === "Enter") && cur.result?.suggested) rate(cur.result.suggested);
        break;
      case "error":
        verdictEl.textContent = `Card error: ${msg.message}`;
        break;
      case "demo-ack":
        acks.get(msg.id)?.(msg.point ?? null);
        acks.delete(msg.id);
        break;
    }
  });

  checkBtn.addEventListener("click", () => cur?.phase === "answer" && post({ type: "collect" }));
  addEventListener("keydown", (e) => {
    if (!cur || !stage.matches(":hover, :focus-within")) return;
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && cur.phase === "answer") { e.preventDefault(); post({ type: "collect" }); }
    else if (cur.phase === "result" && /^[1-4]$/.test(e.key) && !e.target.closest("input, textarea")) rate(Number(e.key));
  });

  async function onSubmit(answer) {
    if (cur.phase !== "answer") return;
    cur.phase = "grading";
    checkBtn.disabled = true;
    let g;
    try { g = grade(cur.demo, cur.prep, answer); } catch (e) { g = { score: null, verdict: "ungraded", feedback: `Grader error: ${e.message}`, suggested: null, grader: { kind: "script" } }; }
    cur.result = g;
    cur.phase = "result";
    post({ type: "result", result: { grade: g, key: cur.prep.key, answer } });
    const pct = g.verdict === "partial" && g.score != null ? `<span class="m tabular">${Math.round(g.score * 100)}%</span>` : "";
    verdictEl.innerHTML = `<span class="v ${g.verdict}">${VERDICT[g.verdict] ?? "Rate yourself"}</span>${pct}<span class="m">· checked by the card's script in ${g.grader.ms} ms</span>`;
    verdictEl.classList.remove("pop"); void verdictEl.offsetWidth; verdictEl.classList.add("pop");
    // The answer and explanation grow the card: bring them into view inside the window.
    // The typing test puts its result (wpm, accuracy) at the top instead, so it stays there.
    setTimeout(() => body.scrollTo({ top: cur.demo.type === "typing" ? 0 : body.scrollHeight, behavior: reduced ? "auto" : "smooth" }), 350);
    checkBtn.parentElement.hidden = true;
    const { fsrs, generatorParameters, createEmptyCard } = await loadFsrs();
    const f = fsrs(generatorParameters({ enable_fuzz: false, learning_steps: ["1m", "10m"], relearning_steps: ["10m"] }));
    const now = new Date();
    const next = f.repeat(createEmptyCard(now), now);
    ratings.innerHTML = [1, 2, 3, 4].map((r) => `<button type="button" class="rate r${r}${g.suggested === r ? " suggested" : ""}" data-r="${r}">${RATING[r]}<small>${humanInterval(next[r].card.due - now)}</small></button>`).join("");
    ratings.hidden = false;
  }
  ratings.addEventListener("click", (e) => {
    const b = e.target.closest("[data-r]");
    if (b) rate(Number(b.dataset.r));
  });
  async function rate(r) {
    if (cur?.phase !== "result") return;
    cur.phase = "rated";
    const b = $(`[data-r="${r}"]`, ratings);
    verdictEl.innerHTML = `<span class="v" style="color:var(--${["", "again", "hard", "good", "easy"][r]})">${RATING[r]}</span><span class="m">· back in ${b?.querySelector("small")?.textContent ?? "a while"}. Next card…</span>`;
    ratings.hidden = true;
    await sleep(1100);
    while (!stageVis.on) await sleep(400);
    open((index + 1) % DEMOS.length);
  }

  // ------------------------------------------------ autoplay: a cursor plays the deck
  // Solvers turn a card's prepared view and key into taps. Ratings vary like a real session.
  const W = (pc) => [1, 3, 6, 8, 10].includes(pc) ? [0.5, 0.45] : [0.5, 0.86];
  const SOLVE = {
    chess: (p) => [{ sel: `[data-sq="${p.key.answers[0].slice(0, 2)}"]` }, { sel: `[data-sq="${p.key.answers[0].slice(2, 4)}"]` }],
    "unit-circle": (p) => { const t = ((p.key.target + 15) * Math.PI) / 180; return [{ sel: ".uc-svg", svg: [0.92 * Math.cos(t), -0.92 * Math.sin(t)] }]; },
    chord: (p) => p.key.pcs.map((pc) => ({ sel: `.cd-kb .key[data-m="${48 + pc}"]`, at: W(pc) })),
    math: (p) => {
      const m = /x\^\{(\d)\}\s*(\\sin x|\\cos x|e\^\{x\}|\\ln x)/.exec(p.fields.prompt ?? "");
      const n = m ? Number(m[1]) : 0, lo = n - 1 === 1 ? "x" : `x^${n - 1}`;
      const f = { "\\sin x": `${lo}(${n}sin(x) + x cos(x))`, "\\cos x": `${lo}(${n}cos(x) - x sin(x))`, "e^{x}": `${lo}e^x(${n} + x)`, "\\ln x": `${lo}(${n}ln(x) + 1)` };
      return [{ sel: "#answer" }, { kind: "type", sel: "#answer", text: m ? f[m[2]] : String(p.key.answers?.[0] ?? "") }];
    },
    "graph-walk": (p) => p.key.order.map((id) => ({ sel: `.gw-node[data-id="${id}"]`, pause: 180 })),
    staff: (p) => [{ sel: `.st-kb .key[data-m="${60 + p.key.pc}"]`, at: W(p.key.pc) }],
    plot: (p) => p.key.points.map(([x, y]) => ({ sel: ".pl-svg", svg: [x, -y] })),
    timeline: (p) => Object.entries(p.key.years).map(([id, y]) => ({ kind: "drag", sel: `.tl-chip[data-id="${id}"]`, to: { sel: ".tl", at: [(y - p.view.from) / (p.view.to - p.view.from), 0.6] } })),
    color: (p) => ["h", "s", "l"].map((k, i) => ({ kind: "range", sel: `.co-slider[data-k="${k}"] input`, value: p.key.hsl[i] })),
    // About 110 wpm with an uneven hand. The test ends itself on the last word.
    typing: (p) => [{ sel: ".ty-box" }, { kind: "type", sel: ".ty-box", into: ".ty-input", text: p.view.words.join(" "), delay: 105 }],
  };
  // Mostly the suggested rating, sometimes Easy: a person who knows some cards cold.
  const RATE = { typing: 3, timeline: 3, chess: 3, "unit-circle": 2, chord: 4, math: 3, "graph-walk": 3, staff: 4, plot: 3, color: 3 };
  const cursor = document.createElement("div");
  cursor.className = "demo-cursor";
  cursor.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3l14 8-6.2 1.6L9.6 19z"/></svg><i></i>`;
  stage.appendChild(cursor);
  const toggle = document.createElement("button");
  toggle.type = "button"; toggle.className = "linkish demo-toggle";
  $(".window-bar", stage).appendChild(toggle);
  const acks = new Map();
  let ackId = 0, auto = !reduced, gen = 0, touched = false, resumeTimer = null;
  // A long typed step (the typing test) takes longer than the usual 3 s to answer.
  const ask = (type, step) => new Promise((r) => { const id = ++ackId; acks.set(id, r); post({ type, id, step }); setTimeout(() => acks.has(id) && (acks.delete(id), r(null)), 3000 + (type === "demo-do" && step?.kind === "type" ? step.text.length * (step.delay ?? 42) * 1.5 : 0)); });
  const live = (g) => g === gen && auto;
  const until = async (cond, g, ms = 8000) => { const t = Date.now(); while (!cond()) { if (!live(g) || Date.now() - t > ms) return false; await sleep(80); } return true; };
  function place(x, y) { const r = stage.getBoundingClientRect(); cursor.style.transform = `translate(${x - r.left}px, ${y - r.top}px)`; cursor.classList.add("on"); }
  const tap = async () => { cursor.classList.remove("tap"); void cursor.offsetWidth; cursor.classList.add("tap"); await sleep(140); };
  async function moveToFrame(step, g) {
    let pt = await ask("demo-where", step);
    if (!pt || !live(g)) return false;
    const fr = cur.frame.getBoundingClientRect(), br = body.getBoundingClientRect();
    const y = fr.top + pt.y;
    if (y < br.top + 30 || y > br.bottom - 30) { body.scrollTo({ top: body.scrollTop + y - (br.top + br.height / 2), behavior: "smooth" }); await sleep(450); pt = await ask("demo-where", step); }
    if (!pt) return false;
    const f2 = cur.frame.getBoundingClientRect();
    place(f2.left + pt.x, f2.top + pt.y);
    await sleep(step.kind === "type" ? 300 : 620);
    return live(g);
  }
  async function moveTo(el, g) { const r = el.getBoundingClientRect(); place(r.left + r.width / 2, r.top + r.height / 2); await sleep(640); return live(g); }
  async function play(g) {
    while (live(g)) {
      if (!(await until(() => cur?.phase === "answer" && stageVis.on, g, 60000))) return;
      await sleep(900);
      const steps = SOLVE[cur.demo.type]?.(cur.prep) ?? [];
      for (const st of steps) {
        if (!(await moveToFrame(st, g))) return;
        if (st.kind !== "type" && st.kind !== "range") await tap();
        if (st.kind === "drag") {
          const end = await ask("demo-where", st.to), fr = cur.frame.getBoundingClientRect();
          const done = ask("demo-do", st);
          if (end) place(fr.left + end.x, fr.top + end.y);
          await done;
        } else await ask("demo-do", st);
        await sleep(st.pause ?? 380);
      }
      // Some cards submit themselves (the typing test on its last word); the rest need Check.
      if (cur.phase === "answer") {
        if (!(await until(() => !checkBtn.disabled || cur.phase !== "answer", g, 3000))) { if (live(g)) open((index + 1) % DEMOS.length); continue; }
        if (cur.phase === "answer") {
          if (!(await moveTo(checkBtn, g))) return;
          await tap(); post({ type: "collect" });
        }
      }
      if (!(await until(() => cur.phase === "result" && !ratings.hidden, g))) return;
      await sleep(2200);
      const r = RATE[cur.demo.type] ?? cur.result?.suggested ?? 3;
      const b = $(`[data-r="${cur.result?.verdict === "partial" ? 2 : r}"]`, ratings);
      if (!b || !(await moveTo(b, g))) return;
      await tap(); rate(Number(b.dataset.r));
      await until(() => cur.phase === "loading" || cur.phase === "answer", g, 4000);
    }
  }
  function setAuto(on) {
    auto = on; gen++;
    toggle.innerHTML = on ? `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg><span class="dt-label">Playing the deck</span>` : `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5v14l12-7z"/></svg><span class="dt-label">Play the deck</span>`;
    toggle.setAttribute("aria-label", on ? "Pause the deck" : "Play the deck");
    if (!on) { cursor.classList.remove("on"); if (!cur) open(index); }
    else { if (touched || cur?.phase !== "answer") open((index + 1) % DEMOS.length); touched = false; play(gen); }
  }
  // A real person takes over: stop the demo where it is and let them finish the card.
  const takeOver = (e) => { if (!e.isTrusted || e.target.closest(".demo-toggle")) return; touched = true; clearTimeout(resumeTimer); if (auto) setAuto(false); };
  stage.addEventListener("pointerdown", takeOver);
  addEventListener("blur", () => { if (document.activeElement === cur?.frame) { touched = true; if (auto) setAuto(false); } });
  stage.addEventListener("pointerenter", (e) => { if (e.isTrusted && e.pointerType === "mouse") clearTimeout(resumeTimer); });
  stage.addEventListener("pointerleave", (e) => { if (e.isTrusted && !auto && !reduced) { clearTimeout(resumeTimer); resumeTimer = setTimeout(() => setAuto(true), 9000); } });
  toggle.addEventListener("click", () => { clearTimeout(resumeTimer); setAuto(!auto); });
  tabs.addEventListener("click", (e) => { if (e.isTrusted) { touched = true; if (auto) setAuto(false); } }, true);
  setAuto(auto);
}

// ------------------------------------------- the self-grading numeric mini card
const mini = $("#mini");
if (mini) {
  const vis = visibility(mini);
  const qEl = $("[data-q]", mini), typed = $("[data-typed]", mini), vEl = $("[data-v]", mini);
  const sizes = [500, 1000, 1500, 4000, 9000, 12000], rates = [1, 2, 5, 10, 25, 100];
  const fmt = (x) => String(+x.toPrecision(3));
  let k = 0;
  (async function loop() {
    for (;;) {
      if (!vis.on) { await sleep(400); continue; }
      const L = sizes[(k * 5 + 2) % sizes.length], R = rates[(k * 7 + 3) % rates.length];
      k++;
      const ms = (8 * L) / (R * 1000);
      qEl.innerHTML = `A ${L.toLocaleString("en")}-byte packet on a ${R}&nbsp;Mbps link. Transmission delay?`;
      typed.textContent = "";
      vEl.innerHTML = "";
      await sleep(700);
      const ans = `${fmt(ms)} ms`;
      for (const ch of ans) { typed.textContent += ch; await sleep(reduced ? 0 : 90); }
      await sleep(450);
      vEl.innerHTML = `<span class="v" style="color:var(--good)">Correct</span><span style="color:var(--muted-foreground);font-size:.8rem">${tex(`\\tfrac{8 \\cdot ${L}\\,\\text{bits}}{${R}\\,\\text{Mbps}} = ${fmt(ms)}\\,\\text{ms}`)}</span>`;
      await sleep(2600);
    }
  })();
}

// ----------------------------------------------------------- the AI grading sample
const ai = $("#ai-demo");
if (ai) {
  fetch("assets/ai-sample.json").then((r) => r.json()).then((s) => {
    $("[data-prompt]", ai).innerHTML = md(s.prompt.replace(/\n\nWrite it the way[\s\S]*$/, ""));
    $("[data-answer]", ai).innerHTML = md(s.answer);
    $("[data-model]", ai).innerHTML = `A real grade, recorded from Etude: verdict by <code class="nowrap">${esc(s.model.split("/").pop())}</code> in ${s.ms} ms, feedback by a chat model. Grading instructions came from the card's rubric.`;
    whenVisible(ai, async () => {
      const verdictEl = $("[data-verdict]", ai), scoreEl = $("[data-score]", ai), meter = $("[data-meter]", ai), fb = $("[data-feedback]", ai);
      await sleep(300);
      verdictEl.textContent = VERDICT[s.verdict] ?? s.verdict;
      verdictEl.classList.add("on");
      scoreEl.textContent = `${Math.round(s.score * 100)}%`;
      meter.style.width = `${Math.round(s.score * 100)}%`;
      await sleep(700);
      // Type the feedback out, keeping math and bold as whole pieces.
      const parts = s.feedback.replace(/"([^"]+)"/g, "$1").split(/(\$[^$\n]+?\$|\*\*[^*]+\*\*)/).filter(Boolean);
      fb.classList.add("caret");
      for (const p of parts) {
        if (p.startsWith("$") || p.startsWith("**")) { fb.insertAdjacentHTML("beforeend", md(p)); await sleep(reduced ? 0 : 60); continue; }
        const node = document.createTextNode("");
        fb.appendChild(node);
        for (const ch of p) { node.data += ch; if (!reduced) await sleep(ch === " " ? 14 : 11); }
      }
      await sleep(1500);
      fb.classList.remove("caret");
    });
  });
}

// ------------------------------------------------------------------ the generator
const gen = $("#generators");
if (gen) {
  $("[data-gen-code]", gen).innerHTML = GENERATOR.html;
  const list = $("[data-variants]", gen);
  const vis = visibility(gen);
  let timer = null;
  // Each roll is a fresh seed, the way a review gets one; the newest variant sits on top.
  const roll = () => {
    const seed = (Math.random() * 2 ** 32) >>> 0;
    const out = runScript(GENERATOR.code, ["rng"], {}, seed);
    const el = document.createElement("li");
    el.className = "pre";
    el.innerHTML = `<div class="q">${md(out.prompt)}</div><div class="s">${seed}</div><div class="a">accepts ${tex(`f'(x) = ${out.answers[0]}`)} or any equivalent form</div>`;
    list.prepend(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove("pre")));
    while (list.children.length > 4) list.lastElementChild.remove();
  };
  const schedule = () => { clearInterval(timer); timer = setInterval(() => vis.on && !reduced && roll(), 3800); };
  for (let i = 0; i < 4; i++) roll();
  schedule();
  $("[data-roll]", gen).addEventListener("click", () => { roll(); schedule(); });
}

// ----------------------------------------------------------------- exam deadlines
const exam = $("#exam");
if (exam) {
  whenVisible(exam, async () => {
    const { fsrs, generatorParameters, createEmptyCard, Rating } = await loadFsrs();
    const f = fsrs(generatorParameters({ enable_fuzz: false, learning_steps: ["1m", "10m"], relearning_steps: ["10m"], request_retention: 0.9 }));
    const DAY = 864e5, H = 36e5;
    // Etude's rule (src/core/scheduler.ts capToDeadline), with the default 12-hour margin.
    const cap = (due, now, deadline) => {
      const latest = new Date(deadline - 12 * H);
      if (due <= latest) return due;
      const half = new Date(now.getTime() + (deadline - now.getTime()) / 2);
      return latest > now ? (half < latest ? half : latest) : half;
    };
    const t0 = Date.UTC(2026, 10, 2, 17); // day 0, 5 pm
    // One study session a day at 5 pm; the exam is at 9 am on day D. Learning steps finish in the session.
    function study(D, withDeadline, startDay) {
      const examAt = t0 + D * DAY - 8 * H;
      let now = new Date(t0 + startDay * DAY), card = createEmptyCard(now);
      const reviews = [];
      for (let g = 0; g < 80; g++) {
        card = f.next(card, now, Rating.Good).card;
        reviews.push({ t: now.getTime(), card: { ...card } });
        if (withDeadline) card.due = cap(card.due, now, examAt);
        let next = card.due.getTime();
        if (next - now.getTime() >= H) next = t0 + Math.ceil((next - t0) / DAY - 1e-9) * DAY;
        if (next >= examAt) break;
        now = new Date(next);
      }
      return { reviews, examAt, recall: f.get_retrievability(card, new Date(examAt), false) };
    }
    const slider = $("#days", exam), chart = $("[data-chart]", exam);
    const R = (card, t) => Number(f.get_retrievability(card, new Date(t), false));
    const pct = (r) => `${(Math.floor(Math.min(r, 0.999) * 1000) / 10).toFixed(1)}%`;
    // One chart, both schedules. It's drawn at the chart's real pixel width so the labels stay readable.
    function draw(D, off, on) {
      const W = Math.max(300, Math.round(chart.clientWidth || 800)), small = W < 560;
      const H = small ? 230 : 300, L = small ? 38 : 48, Rt = small ? 10 : 16, T = 22, B = 40;
      const span = D * DAY;
      // The y range follows the curves, so the dips are visible instead of a flat line near the top.
      let lo = 1;
      for (const run of [off, on]) for (let i = 0; i <= 120; i++) { const t = run.reviews[0].t + ((run.examAt - run.reviews[0].t) * i) / 120; lo = Math.min(lo, R(run.reviews.findLast((r) => r.t <= t).card, t)); }
      const ystep = lo > 0.85 ? 0.02 : lo > 0.7 ? 0.05 : 0.1, ymin = Math.max(0, Math.floor((lo - 0.01) / ystep) * ystep);
      const x = (t) => L + ((t - t0) / span) * (W - L - Rt);
      const y = (r) => T + (1 - (Math.max(ymin, r) - ymin) / (1 - ymin)) * (H - T - B);
      const curve = (run) => {
        let d = "";
        for (let i = 0; i <= 360; i++) {
          const t = run.reviews[0].t + ((run.examAt - run.reviews[0].t) * i) / 360;
          const last = run.reviews.findLast((r) => r.t <= t);
          d += `${d ? "L" : "M"}${x(t).toFixed(1)},${y(R(last.card, t)).toFixed(1)}`;
        }
        return d;
      };
      const dots = (run, cls) => {
        const days = new Map();
        for (const r of run.reviews) days.set(Math.round((r.t - t0) / DAY), r);
        return [...days.values()].map((r) => `<circle class="${cls}" cx="${x(r.t).toFixed(1)}" cy="${y(R(r.card, r.t + 1000)).toFixed(1)}" r="${cls === "d-on" ? 4 : 3.6}"/>`).join("");
      };
      let g = "";
      for (let r = ymin; r <= 1.0001; r += ystep) g += `<line class="grid" x1="${L}" x2="${W - Rt}" y1="${y(r)}" y2="${y(r)}"/><text x="${L - 8}" y="${y(r) + 4}" text-anchor="end">${Math.round(r * 100)}%</text>`;
      const step = D <= 14 ? 2 : D <= 30 ? 5 : 10;
      const ex = x(on.examAt);
      for (let d = 0; d < D; d += step) if (ex - x(t0 + d * DAY) > 34) g += `<text x="${x(t0 + d * DAY)}" y="${H - 8}" text-anchor="middle">${d === 0 ? "day 0" : d}</text>`;
      g += `<line class="examline" x1="${ex}" x2="${ex}" y1="${T}" y2="${H - B}"/><text class="serif" x="${ex}" y="${H - 8}" text-anchor="middle" style="fill:var(--foreground)">exam</text>`;
      // The recall the deadline buys back, shaded between the two curves' final values.
      g += `<path class="c-on" d="${curve(on)}"/><path class="c-off" d="${curve(off)}"/>` + dots(on, "d-on") + dots(off, "d-off");
      chart.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Predicted recall over time, with and without a deadline">${g}</svg>`;
    }
    let last = null;
    function render() {
      const D = Number(slider.value);
      slider.style.setProperty("--p", `${((D - Number(slider.min)) / (Number(slider.max) - Number(slider.min))) * 100}%`);
      $("[data-days]", exam).textContent = String(D);
      const off = study(D, false, 0), on = study(D, true, 0);
      last = [D, off, on];
      draw(D, off, on);
      const count = (run) => new Set(run.reviews.map((r) => Math.round((r.t - t0) / DAY))).size;
      const nextDay = Math.ceil((off.reviews.at(-1).card.due.getTime() - t0) / DAY);
      const lastOn = Math.max(...on.reviews.map((r) => Math.round((r.t - t0) / DAY)));
      $("[data-last-off]", exam).innerHTML = `${count(off)} reviews, then the next is due on day ${nextDay}${nextDay > D ? `, <span class="after">after the exam</span>` : ""}.`;
      $("[data-last-on]", exam).innerHTML = `${count(on)} reviews, the last on day ${lastOn}, so it's fresh on the day.`;
      // A deck: 40 cards learned over the first 60% of the time, all answered Good.
      let rOff = 0, rOn = 0;
      for (let i = 0; i < 40; i++) {
        const s = Math.floor((i * D * 0.6) / 40);
        rOff += study(D, false, s).recall;
        rOn += study(D, true, s).recall;
      }
      $("[data-recall-off]", exam).textContent = pct(rOff / 40);
      $("[data-recall-on]", exam).textContent = pct(rOn / 40);
    }
    new ResizeObserver(() => last && draw(...last)).observe(chart);
    slider.addEventListener("input", render);
    render();
  });
}

// --------------------------------------------------------------------- terminal
const term = $("#term");
if (term) {
  const out = $("[data-term]", term);
  const vis = visibility(term);
  const colorJson = (s) =>
    esc(s).replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)|([{}[\],])/g, (m, str, colon, lit, num, p) => {
      if (str) return colon ? `<span class="j-k">${str}</span>${colon}` : `<span class="j-s">${str}</span>`;
      if (lit) return `<span class="j-n">${lit}</span>`;
      if (num) return `<span class="j-n">${num}</span>`;
      if (p) return `<span class="j-p">${p}</span>`;
      return m;
    });
  fetch("assets/terminal.json").then((r) => r.json()).then(async ({ steps }) => {
    await new Promise((r) => whenVisible(term, r, "0px"));
    for (;;) {
      out.innerHTML = `<span class="dim"># an agent builds a deck from your notes and quizzes you</span>\n`;
      for (const s of steps) {
        while (!vis.on) await sleep(300);
        const line = document.createElement("span");
        line.className = "t-line";
        line.innerHTML = `<span class="ps">$ </span><span class="t-cmd"></span>`;
        out.appendChild(line);
        const cmd = $(".t-cmd", line);
        const body = out.parentElement;
        for (const ch of s.cmd) { cmd.textContent += ch; body.scrollTop = body.scrollHeight; await sleep(reduced ? 0 : 16); }
        await sleep(420);
        out.insertAdjacentHTML("beforeend", `\n${colorJson(s.out)}\n\n`);
        body.scrollTo({ top: body.scrollHeight, behavior: reduced ? "auto" : "smooth" });
        await sleep(1500);
      }
      await sleep(7000);
    }
  });
}

// -------------------------------------------------------------------- app shots
const CAPTIONS = {
  decks: "<b>Decks</b> in a tree, with what's new, learning and due today. Settings and exam deadlines inherit down the tree.",
  study: "<b>Study</b> one card at a time. Check with <kbd>Ctrl</kbd> <kbd>Enter</kbd>, rate with <kbd>1</kbd> to <kbd>4</kbd>, undo with <kbd>Ctrl</kbd> <kbd>Z</kbd>.",
  browse: "<b>Browse</b> with the search language, preview any card and edit its fields with live Markdown and math.",
  types: "<b>Card types</b> are edited in the app too, with a live preview of the card you're writing.",
  stats: "<b>Stats</b>: true retention, predicted recall, your streak, a review heatmap and the forecast up to a deadline.",
};
const shotTabs = $("[data-shot-tabs]");
if (shotTabs) {
  const cap = $("[data-shot-caption]");
  let auto = true, i = 0;
  const names = $$("[data-shot]", shotTabs).map((b) => b.dataset.shot);
  const imgs = $$("[data-shot-img]");
  const img = (name) => imgs.find((el) => el.dataset.shotImg === name);
  // Load a screenshot ahead of time, so the crossfade never fades into an empty frame.
  const warm = (name) => { const el = img(name); if (!el) return Promise.resolve(); el.loading = "eager"; return el.decode().catch(() => {}); };
  let showing = 0;
  const show = async (name) => {
    const t = ++showing;
    i = names.indexOf(name);
    $$("[data-shot]", shotTabs).forEach((b) => b.setAttribute("aria-selected", String(b.dataset.shot === name)));
    cap.innerHTML = CAPTIONS[name];
    await warm(name);
    if (t !== showing) return;
    imgs.forEach((el) => el.classList.toggle("on", el.dataset.shotImg === name));
    warm(names[(i + 1) % names.length]);
  };
  shotTabs.addEventListener("click", (e) => {
    const b = e.target.closest("[data-shot]");
    if (b) { auto = false; show(b.dataset.shot); }
  });
  show("decks");
  const vis = visibility(shotTabs.parentElement);
  setInterval(() => auto && vis.on && !reduced && show(names[(i + 1) % names.length]), 5200);
}

// ------------------------------------------------------------- card type files
const codeTabs = $("[data-code-tabs]");
if (codeTabs) {
  const code = $("[data-code]"), note = $("[data-code-note]"), tree = $("[data-tree]");
  tree.innerHTML =
    `<div><span class="dir">unit-circle/</span><span>the Unit circle card type</span></div>` +
    TYPE_FILES.map((f, i) => `<div class="ind" data-f="${i}">${esc(f.name)}<span>${f.lines} lines</span></div>`).join("");
  codeTabs.innerHTML = TYPE_FILES.map((f, i) => `<button role="tab" type="button" aria-selected="${i === 0}" data-f="${i}">${esc(f.name)}</button>`).join("");
  const show = (i) => {
    code.innerHTML = TYPE_FILES[i].html;
    note.textContent = TYPE_FILES[i].note;
    $$("[data-f]", codeTabs).forEach((b) => b.setAttribute("aria-selected", String(Number(b.dataset.f) === i)));
    $$("[data-f]", tree).forEach((b) => b.classList.toggle("on", Number(b.dataset.f) === i));
    code.parentElement.scrollTop = 0;
  };
  const pick = (e) => { const b = e.target.closest("[data-f]"); if (b) show(Number(b.dataset.f)); };
  codeTabs.addEventListener("click", pick);
  tree.addEventListener("click", pick);
  show(4);
}

// ---------------------------------------------------------------- the repertoire
// Every included type, live and for the visitor's own hands: no autoplay here. Script-graded cards
// are graded in the page by the type's own grade script; AI-graded ones show their reference.
const rep = $("[data-rep]");
if (rep && GALLERY?.length) {
  const list = $("[data-rep-list]", rep), card = $("[data-rep-card]", rep), body = $(".rep-body", card), loader = $(".rep-loader", card);
  const checkBtn = $("[data-rep-check]", rep), againBtn = $("[data-rep-variant]", rep), verdictEl = $(".rep-verdict", rep);
  const groupEl = $("[data-rep-group]", rep), nameEl = $("[data-rep-name]", rep), descEl = $("[data-rep-desc]", rep), graderEl = $("[data-rep-grader]", rep);
  const coarse = matchMedia("(pointer: coarse)").matches;
  const AGAIN = { variant: "New variant", shuffle: "Shuffle again", reset: "Start over" };
  const GRADER = {
    script: "Graded by the card's own script, right here in your browser.",
    hybrid: "Graded by running hidden tests in a sandbox; code with no tests goes to AI.",
    self: "You grade yourself: see the answer, then rate how well you knew it.",
    ai: "Graded by AI in the app. Here, Check shows the reference it compares against.",
  };
  const CHECK = { self: "Show answer", ai: "Show the reference" };

  // The programme: types grouped by what they ask of you, numbered in one run like a concert programme.
  let n = 0, html = "";
  for (const group of [...new Set(GALLERY.map((e) => e.group))]) {
    html += `<div class="rep-group"><p class="rep-group-h">${esc(group)}</p><ol>`;
    GALLERY.forEach((e, i) => {
      if (e.group !== group) return;
      html += `<li><button type="button" class="rep-item" data-i="${i}" data-type="${esc(e.type)}" aria-controls="rep-panel" aria-current="false" tabindex="-1"><span class="rep-n tabular">${++n}</span><span class="rep-l">${esc(e.label)}</span>${e.grader === "ai" ? `<span class="rep-dag" aria-label="graded by AI">†</span>` : ""}</button></li>`;
    });
    html += `</ol></div>`;
  }
  list.innerHTML = html + `<p class="rep-foot-note"><span aria-hidden="true">†</span> graded by AI in the app</p>`;
  const items = $$(".rep-item", list);

  let cur = null; // { entry, i, k, seed, prep, frame, phase }
  const variant = new Map(); // which item of an entry was shown last
  const swap = frameSwapper(body, loader);
  const post = (msg) => cur?.frame.contentWindow?.postMessage({ etude: 1, ...msg }, "*");

  function open(i, { fresh = false, focus = false } = {}) {
    const entry = GALLERY[i];
    let k = variant.get(i) ?? 0;
    if (fresh && entry.items.length > 1) k = (k + 1) % entry.items.length;
    variant.set(i, k);
    const item = entry.items[k];
    const seed = (Math.random() * 2 ** 32) >>> 0;
    items.forEach((b, j) => { b.setAttribute("aria-current", String(j === i)); b.tabIndex = j === i ? 0 : -1; });
    // Keep the chosen type in view in the phone's horizontal strip, without scrolling the page.
    const b = items[i];
    if (list.scrollWidth > list.clientWidth + 2) list.scrollTo({ left: b.offsetLeft - list.clientWidth / 2 + b.offsetWidth / 2, behavior: reduced ? "auto" : "smooth" });
    groupEl.textContent = entry.group;
    nameEl.textContent = entry.label;
    descEl.textContent = entry.desc;
    graderEl.textContent = GRADER[entry.grader] ?? "";
    verdictEl.innerHTML = "";
    checkBtn.hidden = false;
    checkBtn.disabled = true;
    checkBtn.firstChild.textContent = `${CHECK[entry.grader] ?? "Check"} `;
    againBtn.innerHTML = `${AGAIN[entry.again]} <span aria-hidden="true">↻</span>`;
    againBtn.classList.remove("btn-primary");
    againBtn.classList.add("btn-ghost");
    let prep;
    try { prep = prepare({ id: item.id, fields: item.fields, prepare: entry.prepare, private: entry.private }, seed, item.face ?? "main"); }
    catch (e) { verdictEl.textContent = `Couldn't prepare the card: ${e.message}`; return; }
    const old = cur?.frame;
    const frame = document.createElement("iframe");
    frame.title = `${entry.name} card`;
    frame.setAttribute("sandbox", SANDBOX);
    frame.className = "loading";
    frame.style.height = old ? old.style.height : "420px";
    frame.src = `frames/gallery/${entry.type}.html`;
    cur = { entry, i, k, item, seed, prep, frame, phase: "loading", ready: true, focus };
    swap.add(frame);
  }

  addEventListener("message", (e) => {
    if (!cur || e.source !== cur.frame.contentWindow) return;
    const msg = e.data;
    if (!msg || msg.etude !== 1) return;
    switch (msg.type) {
      case "loaded":
        // The visitor chose this card with a pointer: let it take the keyboard, as it would in the app.
        if (cur.focus && !coarse) post({ type: "rep-focus" });
        post({ type: "init", view: cur.prep.view, mode: "answer", answer: null, result: null, theme: theme() });
        break;
      case "mounted":
        cur.phase = "answer";
        swap.mounted(cur.frame);
        checkBtn.disabled = !cur.ready;
        break;
      case "size":
        if (typeof msg.height === "number") cur.frame.style.height = `${Math.max(140, Math.min(msg.height + 4, 2400))}px`;
        break;
      case "ready-state":
        cur.ready = !!msg.ready;
        if (cur.phase === "answer") checkBtn.disabled = !cur.ready;
        break;
      case "submit":
        onSubmit(msg.answer);
        break;
      case "key":
        if (msg.key === "Mod+Enter" && cur.phase === "answer") post({ type: "collect" });
        else if (msg.key === "Mod+Enter" && cur.phase === "result") again();
        break;
      case "error":
        verdictEl.textContent = `Card error: ${msg.message}`;
        break;
    }
  });

  function onSubmit(answer) {
    if (cur.phase !== "answer") return;
    cur.phase = "grading";
    checkBtn.disabled = true;
    const { entry, prep } = cur;
    let g = { score: null, verdict: "ungraded", grader: { kind: entry.grader } }, line;
    if (entry.grade) {
      const t0 = performance.now();
      try {
        const out = runScript(entry.grade, ["answer", "view", "key", "fields"], { answer, view: prep.view, key: prep.key, fields: prep.fields }) ?? {};
        const ms = Math.max(1, Math.round(performance.now() - t0));
        if (out.defer) line = `<span class="v">Not graded here</span><span class="m">· with no tests, the app hands this to AI</span>`;
        else if (entry.quiet && entry.metrics) {
          // A drill (Flippy Bit) hides its verdict in the app and shows what it measured instead.
          g = { score: out.score ?? null, verdict: verdictOf(out.score), details: out.details, grader: { kind: "script", ms } };
          line = `<span class="v">Run over</span><span class="m">${metricLine(entry.metrics, out.details)}</span>`;
        }
        else {
          const score = out.score == null ? null : Math.max(0, Math.min(1, Number(out.score)));
          g = { score, verdict: verdictOf(score), feedback: out.feedback, details: out.details, suggested: suggest(score), grader: { kind: "script", ms } };
          const pct = g.verdict === "partial" ? `<span class="m tabular">${Math.round(score * 100)}%</span>` : "";
          line = `<span class="v ${g.verdict}">${VERDICT[g.verdict] ?? "Graded"}</span>${pct}<span class="m">· by the card's script in ${ms} ms</span>`;
        }
      } catch (err) {
        line = `<span class="v incorrect">Grader error</span><span class="m">${esc(err.message)}</span>`;
      }
    } else if (entry.grader === "ai") line = `<span class="v">Graded by AI in the app</span><span class="m">· the reference is below</span>`;
    else line = `<span class="v">How well did you know it?</span><span class="m">· in the app you'd rate it Again, Hard, Good or Easy</span>`;
    cur.phase = "result";
    post({ type: "result", result: { grade: g, key: prep.key, answer } });
    verdictEl.innerHTML = line;
    verdictEl.classList.remove("pop"); void verdictEl.offsetWidth; verdictEl.classList.add("pop");
    checkBtn.hidden = true;
    againBtn.classList.replace("btn-ghost", "btn-primary");
  }
  const again = () => open(cur.i, { fresh: true, focus: true });

  checkBtn.addEventListener("click", () => cur?.phase === "answer" && post({ type: "collect" }));
  againBtn.addEventListener("click", () => cur && again());
  rep.addEventListener("keydown", (e) => {
    if (!cur || !(e.ctrlKey || e.metaKey) || e.key !== "Enter") return;
    e.preventDefault();
    if (cur.phase === "answer") post({ type: "collect" });
    else if (cur.phase === "result") again();
  });

  // Pick a type with a click, or move through the programme with the arrow keys (one tab stop).
  list.addEventListener("click", (e) => {
    const b = e.target.closest("[data-i]");
    if (b) open(Number(b.dataset.i), { focus: e.detail > 0 });
  });
  let keyTimer = null;
  list.addEventListener("keydown", (e) => {
    const at = items.indexOf(document.activeElement);
    if (at < 0 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const row = getComputedStyle(list).flexDirection === "row" || list.scrollWidth > list.clientWidth + 2;
    const next = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    let to = next ? Math.max(0, Math.min(items.length - 1, at + next)) : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : -1;
    if (to < 0) return;
    if (!row && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return;
    e.preventDefault();
    items[to].focus({ preventScroll: true });
    items[to].scrollIntoView({ block: "nearest", inline: "nearest" });
    clearTimeout(keyTimer);
    keyTimer = setTimeout(() => open(to), 160);
  });

  // For site/tools/repertoire.mjs: the prepared card, as the server would hold it.
  window.__rep = () => cur && { type: cur.entry.type, view: cur.prep.view, key: cur.prep.key, fields: cur.prep.fields, phase: cur.phase };
  whenVisible(rep, () => open(0), "0px 0px 40% 0px");
}

// --------------------------------------------------------------- tempo: schedulers
// One card over six weeks under four schedulers. FSRS runs through ts-fsrs; drill, Leitner and
// the docs' every-Monday example are the real schedule.js scripts, called with the same
// (card, attempt, options, ctx) the engine gives them.
{
  const box = $("[data-tempo]");
  if (box) {
    const chart = $("[data-tempo-chart]", box), missBox = $("[data-tempo-miss]", box), missNote = $("[data-tempo-miss-note]", box);
    const DAY = 864e5, SPAN = 42;
    // Day 0 is a Monday, so the weeks on the chart are real weeks; everyone studies at 7 pm.
    const day0 = new Date(2026, 10, 2);
    const dayStart = (n) => new Date(day0.getFullYear(), day0.getMonth(), day0.getDate() + n);
    const at = (n) => new Date(dayStart(n).getTime() + 19 * 36e5);
    const dayOf = (iso) => Math.round((new Date(iso).setHours(0, 0, 0, 0) - day0.getTime()) / DAY);
    function script(body, options, miss) {
      const out = [];
      let card = { state: null, reps: 0, due: null, lastReview: null, created: at(0).toISOString() }, d = 0;
      const history = [];
      for (let k = 0; d < SPAN && k < 200; k++) {
        const now = at(d), bad = miss && out.length === 2;
        const attempt = { rating: bad ? 1 : 3, score: bad ? 0 : 1, verdict: bad ? "incorrect" : "correct", details: {}, ms: 8000, at: now.toISOString() };
        const ctx = { now: now.toISOString(), day: Array.from({ length: 400 }, (_, i) => dayStart(d + i).toISOString()), doneToday: out.filter((o) => o.d === d).length, history: history.slice(-50) };
        const r = runScript(body, ["card", "attempt", "options", "ctx"], { card, attempt, options, ctx });
        out.push({ d, bad, state: r.state });
        history.push({ at: now.toISOString(), rating: attempt.rating, score: attempt.score });
        card = { ...card, state: r.state, reps: card.reps + 1, due: r.due, lastReview: now.toISOString() };
        d = Math.max(d + (dayOf(r.due) > d ? 0 : 1), dayOf(r.due));
      }
      out.next = d;
      return out;
    }
    async function fsrsRow(miss) {
      const { fsrs, generatorParameters, createEmptyCard, Rating } = await loadFsrs();
      const f = fsrs(generatorParameters({ enable_fuzz: false, learning_steps: ["1m", "10m"], relearning_steps: ["10m"], request_retention: 0.9 }));
      let now = at(0), card = createEmptyCard(now);
      const out = [];
      while (out.length < 60) {
        const d = Math.round((new Date(now).setHours(0, 0, 0, 0) - day0.getTime()) / DAY);
        if (d >= SPAN) break;
        const days = new Set(out.map((o) => o.d));
        const bad = miss && days.size === 2 && !days.has(d);
        card = f.next(card, now, bad ? Rating.Again : Rating.Good).card;
        if (!out.some((o) => o.d === d)) out.push({ d, bad, state: null });
        const o = out[out.length - 1];
        o.state = { ivl: Math.max(0, Math.round((new Date(card.due).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / DAY)) };
        // Learning steps finish in the same sitting.
        now = card.due - now < 36e5 ? card.due : at(Math.round((new Date(card.due).setHours(0, 0, 0, 0) - day0.getTime()) / DAY));
      }
      out.next = Math.round((new Date(card.due).setHours(0, 0, 0, 0) - day0.getTime()) / DAY);
      return out;
    }
    const ROWS = [
      { id: "fsrs", name: "FSRS", note: "right before you'd forget it", run: fsrsRow, tag: (o) => (o.state?.ivl ? `+${o.state.ivl}d` : null) },
      { id: "drill", name: "Drill", note: "every day, nothing to rate", run: (m) => script(SCHEDULERS.drill, { perDay: 1, everyDays: 1 }, m) },
      { id: "leitner", name: "Leitner", note: "up a box if right, box 1 if wrong", run: (m) => script(SCHEDULERS.leitner, { boxes: "1, 2, 4, 8, 16, 32" }, m), tag: (o) => o.state?.box },
      { id: "monday", name: "Your own", note: "a few lines of JS: Mondays", run: (m) => script(SCHEDULERS.monday, { weeks: 1 }, m) },
    ];
    async function draw() {
      const miss = missBox.checked;
      missNote.hidden = !miss;
      const rows = [];
      for (const r of ROWS) rows.push({ ...r, pts: await r.run(miss) });
      const W = Math.max(300, Math.round(chart.clientWidth || 900)), small = W < 640;
      const L = small ? 8 : 230, R = small ? 8 : 64, rowH = small ? 74 : 62, top = 8, H = top + rows.length * rowH + 30;
      const x = (d) => L + ((W - L - R) * (d + 0.5)) / SPAN;
      let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="When the card comes back under each scheduler">`;
      // weeks
      const rowY = (i) => top + i * rowH + (small ? 46 : rowH / 2);
      for (let w = 0; w <= 6; w++) {
        const gx = L + ((W - L - R) * w * 7) / SPAN;
        // On a phone the row names sit above the dots, so the week lines only cross the dot rows.
        if (small) rows.forEach((_, i) => (s += `<line class="grid" x1="${gx}" x2="${gx}" y1="${rowY(i) - 9}" y2="${rowY(i) + 9}"/>`));
        else s += `<line class="grid" x1="${gx}" x2="${gx}" y1="${top}" y2="${H - 26}"/>`;
        if (w < 6) s += `<text x="${gx + 4}" y="${H - 8}">${small ? `w${w + 1}` : `week ${w + 1}`}</text>`;
      }
      rows.forEach((r, i) => {
        const y = rowY(i);
        if (small) s += `<text class="serif" x="${L}" y="${y - 24}">${r.name} <tspan class="dim">· ${esc(r.note)}</tspan></text>`;
        else s += `<text class="serif" x="0" y="${y - 2}">${r.name}</text><text class="dim small" x="0" y="${y + 15}">${esc(r.note)}</text>`;
        s += `<line class="axis" x1="${L}" x2="${W - R}" y1="${y}" y2="${y}"/>`;
        const pts = r.pts.filter((p) => p.d < SPAN);
        for (const p of pts) {
          s += `<circle class="${p.bad ? "miss" : i === 1 ? "run" : "rev"}" cx="${x(p.d).toFixed(1)}" cy="${y}" r="${small ? 2.7 : 4.6}"/>`;
          const t = r.tag?.(p);
          if (t && !small) s += `<text class="tag" x="${x(p.d).toFixed(1)}" y="${y - 10}" text-anchor="middle">${t}</text>`;
        }
        // A long gap at the end is the point, not missing data: say when the card comes back.
        const last = pts[pts.length - 1]?.d ?? 0;
        if (r.pts.next >= SPAN && SPAN - last > 6) s += `<text class="next" x="${W - R - 4}" y="${y + (small ? 19 : -9)}" text-anchor="end">next: day ${r.pts.next} →</text>`;
        if (!small) s += `<text class="count" x="${W - R + 14}" y="${y + 5}">${pts.length}×</text>`;
      });
      chart.innerHTML = s + "</svg>";
      window.__tempo = rows.map((r) => ({ id: r.id, days: r.pts.map((p) => p.d) }));
    }
    missBox.addEventListener("change", draw);
    let w = 0;
    new ResizeObserver(() => { const n = chart.clientWidth; if (Math.abs(n - w) > 4) { w = n; draw(); } }).observe(chart);
    whenVisible(box, draw, "0px 0px 30% 0px");
  }
}

// ------------------------------------------------------------- suite: new decks
// The new Market decks, live. Same frames and scripts as the repertoire, one deck per tab.
{
  const box = $("[data-suite]");
  const entries = Object.fromEntries((GALLERY ?? []).filter((e) => ["country-map", "element", "flippy"].includes(e.type)).map((e) => [e.type, e]));
  if (box && Object.keys(entries).length) {
    const tabs = $$("[data-suite-type]", box), body = $(".suite-body", box), loader = $(".suite-loader", box);
    const checkBtn = $("[data-suite-check]", box), nextBtn = $("[data-suite-next]", box), verdictEl = $(".suite-verdict", box), noteEl = $("[data-suite-note]", box);
    const coarse = matchMedia("(pointer: coarse)").matches;
    const NOTES = {
      "country-map": "Natural Earth borders, drawn by the card itself. It takes English, Portuguese, Spanish and French names, and forgives typos.",
      element: "Data from PubChem. Every answer ends on the element's place in the coloured table.",
      flippy: "Keys 1 to 8 flip the bits, or tap them. It's a drill: no rating, every run is kept, and Stats charts invaders per run. After Q42's Flippy Bit.",
    };
    // The heading follows the deck you pick.
    const head = box.closest("section")?.querySelector(".head h2");
    const HEADS = {
      "country-map": "Learning the map? Name the country that's lit&nbsp;up.",
      element: "Taking chemistry? Find iron on a blank&nbsp;table.",
      flippy: "Learning binary? Shoot the invaders&nbsp;down.",
    };
    const setHead = (type) => {
      if (!head || !HEADS[type] || head.dataset.type === type) return;
      head.dataset.type = type;
      head.classList.remove("swap"); void head.offsetWidth;
      head.innerHTML = HEADS[type];
      head.classList.add("swap");
    };
    const swap = frameSwapper(body, loader);
    const k = {};
    let cur = null;
    const post = (msg) => cur?.frame.contentWindow?.postMessage({ etude: 1, ...msg }, "*");
    function open(type, { next = false, focus = false } = {}) {
      const entry = entries[type];
      k[type] = next ? ((k[type] ?? 0) + 1) % entry.items.length : (k[type] ?? 0);
      const item = entry.items[k[type]];
      tabs.forEach((b) => b.setAttribute("aria-selected", String(b.dataset.suiteType === type)));
      setHead(type);
      noteEl.textContent = NOTES[type] ?? "";
      verdictEl.innerHTML = "";
      checkBtn.hidden = !!entry.auto;
      checkBtn.disabled = true;
      nextBtn.innerHTML = `${entry.auto ? "Play again" : "Another card"} <span aria-hidden="true">↻</span>`;
      nextBtn.classList.replace("btn-primary", "btn-ghost");
      const seed = (Math.random() * 2 ** 32) >>> 0;
      let prep;
      try { prep = prepare({ id: item.id, fields: item.fields, prepare: entry.prepare, private: entry.private }, seed, item.face ?? "main"); }
      catch (e) { verdictEl.textContent = `Couldn't prepare the card: ${e.message}`; return; }
      const old = cur?.frame;
      const frame = document.createElement("iframe");
      frame.title = `${entry.name} card`;
      frame.setAttribute("sandbox", SANDBOX);
      frame.className = "loading";
      frame.style.height = old ? old.style.height : "480px";
      frame.src = `frames/gallery/${type}.html`;
      cur = { type, entry, item, prep, frame, phase: "loading", ready: true, focus };
      swap.add(frame);
    }
    addEventListener("message", (e) => {
      if (!cur || e.source !== cur.frame.contentWindow) return;
      const msg = e.data;
      if (!msg || msg.etude !== 1) return;
      if (msg.type === "loaded") {
        if (cur.focus && !coarse) post({ type: "rep-focus" });
        post({ type: "init", view: cur.prep.view, mode: "answer", answer: null, result: null, theme: theme() });
      } else if (msg.type === "mounted") { cur.phase = "answer"; swap.mounted(cur.frame); checkBtn.disabled = !cur.ready; }
      else if (msg.type === "size" && typeof msg.height === "number") cur.frame.style.height = `${Math.max(160, Math.min(msg.height + 4, 2400))}px`;
      else if (msg.type === "ready-state") { cur.ready = !!msg.ready; if (cur.phase === "answer") checkBtn.disabled = !cur.ready; }
      else if (msg.type === "submit") onSubmit(msg.answer);
      else if (msg.type === "key" && msg.key === "Mod+Enter") cur.phase === "answer" ? post({ type: "collect" }) : cur.phase === "result" && open(cur.type, { next: !cur.entry.auto, focus: true });
      else if (msg.type === "error") verdictEl.textContent = `Card error: ${msg.message}`;
    });
    function onSubmit(answer) {
      if (cur.phase !== "answer") return;
      cur.phase = "result";
      const { entry, prep } = cur;
      let g, line;
      const t0 = performance.now();
      try {
        const out = runScript(entry.grade, ["answer", "view", "key", "fields"], { answer, view: prep.view, key: prep.key, fields: prep.fields }) ?? {};
        const ms = Math.max(1, Math.round(performance.now() - t0));
        const score = out.score == null ? null : Math.max(0, Math.min(1, Number(out.score)));
        g = { score, verdict: verdictOf(score), feedback: out.feedback, details: out.details, suggested: suggest(score), grader: { kind: "script", ms } };
        if (entry.quiet && entry.metrics) {
          // A drill shows what it measured, as the app does.
          line = `<span class="v">Run over</span><span class="m">${metricLine(entry.metrics, out.details)}</span>`;
        } else {
          const pct = g.verdict === "partial" ? `<span class="m tabular">${Math.round(score * 100)}%</span>` : "";
          line = `<span class="v ${g.verdict}">${VERDICT[g.verdict] ?? "Graded"}</span>${pct}<span class="m">· by the card's script in ${ms} ms</span>`;
        }
      } catch (err) {
        g = { score: null, verdict: "ungraded", grader: { kind: "script" } };
        line = `<span class="v incorrect">Grader error</span><span class="m">${esc(err.message)}</span>`;
      }
      post({ type: "result", result: { grade: g, key: prep.key, answer } });
      verdictEl.innerHTML = line;
      verdictEl.classList.remove("pop"); void verdictEl.offsetWidth; verdictEl.classList.add("pop");
      checkBtn.hidden = true;
      nextBtn.classList.replace("btn-ghost", "btn-primary");
      cur.grade = g;
    }
    checkBtn.addEventListener("click", () => cur?.phase === "answer" && post({ type: "collect" }));
    nextBtn.addEventListener("click", () => cur && open(cur.type, { next: !cur.entry.auto || cur.phase !== "result" ? true : false, focus: true }));
    box.addEventListener("click", (e) => { const b = e.target.closest("[data-suite-type]"); if (b && b.dataset.suiteType !== cur?.type) open(b.dataset.suiteType, { focus: e.detail > 0 }); });
    window.__suiteCount = (t) => entries[t]?.items.length;
    window.__suite = () => cur && { type: cur.type, item: cur.item.id, face: cur.item.face ?? "main", view: cur.prep.view, key: cur.prep.key, phase: cur.phase, grade: cur.grade ?? null };
    whenVisible(box, () => open("country-map"), "0px 0px 40% 0px");
  }
}

// ------------------------------------------------------- lifting the hero off the film
// The hero and the film are two cards in a stack, the hero on top. The film waits underneath it,
// pinned under the nav. Once the hero's bottom reaches the bottom of the screen, scrolling lifts
// the hero off: it becomes a card, turns counter-clockwise and flies away up and to the left,
// uncovering the film. Then the film scrolls on. It follows the scroll position, so it runs
// backwards when you scroll back. Phones just scroll: there the hero is two screens tall.
{
  const deal = $(".deal"), hero = $(".deal > .hero"), film = $(".deal > .film");
  // sticky can't move into its parent's padding, so the pinned stretch is an empty block after the film
  const room = deal && document.createElement("div");
  if (room) { room.className = "deal-room"; room.setAttribute("aria-hidden", "true"); deal.append(room); }
  const wide = matchMedia("(min-width: 700px)");
  if (deal && hero && film && !reduced) {
    const ease = (t) => t * t;
    const clamp = (x) => Math.max(0, Math.min(1, x));
    let ticking = false, start = 0, T = 0;
    const layout = () => {
      if (!wide.matches) {
        deal.classList.remove("on");
        film.style.marginTop = room.style.height = film.style.top = "";
        return false;
      }
      deal.classList.add("on");
      const vh = innerHeight, H = hero.offsetHeight, nav = $("#nav")?.offsetHeight ?? 64;
      start = Math.max(0, deal.offsetTop + H - vh);               // the hero's bottom reaches the screen's bottom
      T = vh * 0.85;                                               // how far you scroll while it flies off
      const F = film.offsetHeight;
      film.style.top = `${nav + Math.max(0, (vh - nav - F) / 2)}px`;  // centred in the screen below the nav
      film.style.marginTop = `${-H}px`;                            // the film starts right under the hero
      room.style.height = `${T + vh * 0.2 + Math.max(0, (vh - nav - F) / 2)}px`;  // pinned while the hero leaves, plus a short beat
      return true;
    };
    const frame = () => {
      ticking = false;
      if (!layout()) { hero.style.transform = ""; hero.classList.remove("lifting"); return; }
      const raw = clamp((scrollY - start) / T), p = ease(raw);
      window.__deal = { start, T };
      hero.style.setProperty("--lift", clamp(raw * 5).toFixed(3));
      if (raw === 0) { hero.style.transform = ""; hero.classList.remove("lifting"); return; }
      hero.classList.add("lifting");
      const vw = innerWidth, vh = innerHeight;
      const tx = -p * vw * 0.95, ty = -p * vh * 0.75, rot = -28 * ease(clamp(raw * 1.4)), sc = 1 - 0.12 * clamp(raw * 2);
      hero.style.transform = `translate3d(${tx.toFixed(1)}px, ${ty.toFixed(1)}px, 0) rotate(${rot.toFixed(2)}deg) scale(${sc.toFixed(3)})`;
    };
    const kick = () => { if (!ticking) { ticking = true; requestAnimationFrame(frame); } };
    addEventListener("scroll", kick, { passive: true });
    addEventListener("resize", kick);
    frame();
    // the Film link goes to the moment the film is uncovered
    document.addEventListener("click", (e) => {
      const a = e.target.closest('a[href="#film"]');
      if (!a || !deal.classList.contains("on")) return;
      e.preventDefault();
      scrollTo({ top: start + T, behavior: "smooth" });
      history.replaceState(null, "", "#film");
    });
  }
}

// ------------------------------------------------------------- the film
{
  const v = $("#film-video"), wrap = v?.closest(".film-frame"), play = $(".film-play");
  if (v && play) {
    play.addEventListener("click", () => { v.preload = "auto"; v.controls = true; v.play().catch(() => {}); });
    v.addEventListener("play", () => { v.controls = true; wrap.classList.add("playing"); });
    v.addEventListener("ended", () => wrap.classList.remove("playing"));
    // A film playing off screen keeps talking: pause it when it scrolls away.
    new IntersectionObserver((es) => es.forEach((e) => !e.isIntersecting && !v.paused && v.pause()), { threshold: 0.15 }).observe(v);
  }
}

// ----------------------------------------------------------------- stats
{
  const box = $("[data-plates]");
  if (box) {
    const btns = $$("[data-plate]", box), panes = $$("[data-plate-pane]", box);
    const list = $(".plate-list", box), view = $("[data-plate-view]", box);
    let auto = true, i = 0, hold = 0;
    // The panes share one grid cell, so the tallest sets the height; on wide screens it's at least the
    // tab list's, so switching tabs never moves the page.
    const fit = () => {
      const wide = matchMedia("(min-width: 1000px)").matches;
      view.style.setProperty("--plate-h", wide ? `${Math.ceil(list.offsetHeight)}px` : "0px");
    };
    new ResizeObserver(fit).observe(list);
    const show = (name) => {
      i = btns.findIndex((b) => b.dataset.plate === name);
      btns.forEach((b) => b.setAttribute("aria-selected", String(b.dataset.plate === name)));
      panes.forEach((p) => p.classList.toggle("on", p.dataset.platePane === name));
      const b = btns[i];
      if (list.scrollWidth > list.clientWidth + 2) list.scrollTo({ left: b.offsetLeft - 16, behavior: reduced ? "auto" : "smooth" });
    };
    box.addEventListener("click", (e) => { const b = e.target.closest("[data-plate]"); if (b) { auto = false; show(b.dataset.plate); } });
    // someone using a panel shouldn't have it switch under them
    view.addEventListener("pointerdown", () => (auto = false));
    view.addEventListener("pointermove", () => (hold = Date.now()));
    const vis = visibility(box);
    setInterval(() => auto && vis.on && !reduced && Date.now() - hold > 6000 && show(btns[(i + 1) % btns.length].dataset.plate), 4800);
  }
}

// ---------------------------------------------------------------- market
// The section is filled from a snapshot of the catalogue shipped with the site, then refreshed
// from the live index if it answers, so new entries show up without rebuilding the site.
{
  const box = $("[data-market]");
  if (box) {
    const grid = $("[data-market-grid]", box), count = $("[data-market-count]", box), tabs = $$("[data-kind]", box);
    const RAW = "https://raw.githubusercontent.com/Zibhelina/etude-market/main";
    let entries = [], kind = "deck";
    const v = (t, k, d) => t?.vars?.[k] ?? d;
    const themeTile = (t) => {
      const s = [["--t-bg", v(t, "--background", "#111")], ["--t-side", v(t, "--sidebar", v(t, "--background"))], ["--t-card", v(t, "--card", "#222")], ["--t-fg", v(t, "--foreground", "#eee")],
        ["--t-muted", v(t, "--muted-foreground", "#999")], ["--t-hl", v(t, "--highlight", v(t, "--primary", "#f6a"))], ["--t-border", v(t, "--border", "#ffffff22")]]
        .map(([k, val]) => `${k}:${val}`).join(";");
      const rate = ["--again", "--hard", "--good", "--easy"].map((k) => `<i style="background:${v(t, k, "#888")}"></i>`).join("");
      const chips = ["--highlight", "--chart-2", "--chart-3", "--chart-4"].map((k) => `<i style="background:${v(t, k, v(t, "--highlight", "#f6a"))}"></i>`).join("");
      return `<div class="mk-theme" style="${esc(s)}" aria-hidden="true"><div class="rail"><i></i><i></i><i></i><i></i></div><div class="pane"><div class="t1"><b>ε</b>tude</div><div class="t2">Mate in <b>one</b></div><div class="chips">${chips}</div><div class="rates">${rate}</div></div></div>`;
    };
    const tile = (e, n) => `<article class="mk" style="--i:${n}">${e.kind === "theme" ? themeTile(e.theme) : e.cover ? `<div class="mk-cover"><img src="${esc(e.cover)}" alt="" loading="lazy"></div>` : ""}<div class="mk-body"><h3 class="mk-name">${esc(e.name)}</h3><p class="mk-desc">${esc(e.description)}</p>${e.tags?.length ? `<div class="mk-tags">${e.tags.slice(0, 3).map((t) => `<span>${esc(t)}</span>`).join("")}</div>` : ""}</div></article>`;
    const render = () => {
      const shown = entries.filter((e) => e.kind === kind);
      grid.innerHTML = shown.map(tile).join("");
      const k = { type: ["card type", "card types"], deck: ["deck", "decks"], theme: ["theme", "themes"] };
      const c = (x) => entries.filter((e) => e.kind === x).length;
      count.textContent = `${c("deck")} ${k.deck[+(c("deck") !== 1)]}, ${c("type")} ${k.type[+(c("type") !== 1)]} and ${c("theme")} ${k.theme[+(c("theme") !== 1)]} so far.`;
      tabs.forEach((b) => b.setAttribute("aria-selected", String(b.dataset.kind === kind)));
    };
    box.addEventListener("click", (e) => { const b = e.target.closest("[data-kind]"); if (b) { kind = b.dataset.kind; render(); } });
    whenVisible(box, async () => {
      try { entries = (await (await fetch("assets/market/market.json")).json()).entries; render(); } catch {}
      // live index: only adopt entries without a local cover through the raw URL
      try {
        const live = await (await fetch(`${RAW}/index.json`, { cache: "no-cache" })).json();
        const known = new Map(entries.map((e) => [`${e.kind}:${e.id}`, e]));
        const next = live.entries.map((e) => known.get(`${e.kind}:${e.id}`) ?? { id: e.id, kind: e.kind, name: e.name, description: e.description, tags: e.tags ?? [], theme: e.kind === "theme" ? e.summary?.theme : undefined, cover: e.cover ? `${RAW}/${e.cover}` : undefined });
        if (next.length && next.length !== entries.length) { entries = next; render(); }
      } catch {}
    }, "0px 0px 30% 0px");
  }
}
