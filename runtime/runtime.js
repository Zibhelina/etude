// Card runtime. Loaded inside every card's sandboxed frame; gives the type's script the `etude` API.
// The frame has an opaque origin: it can only talk to the app through postMessage.
import { marked } from "./vendor/marked.js";
import katex from "./vendor/katex.js";
import math from "./mathexpr.js";
import { cardAudio } from "./audio.js";

// Sound: etude.play(), and in Chromium every <audio> routed through Web Audio (see audio.js for why).
const audio = cardAudio(window);

// Editors and syntax highlighting live in a separate kit, loaded the first time a card needs them.
let kitPromise = null;
const kit = () => (kitPromise ??= import(new URL("./kit/kit.js", import.meta.url).href));

const parent = window.parent;
const send = (type, data = {}) => parent.postMessage({ etude: 1, type, ...data }, "*");

// ---------- markdown with math ----------

const MATH = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(?<![\\$\w])\$(?!\s)(?:\\.|[^$\n\\])+?(?<!\s)\$(?!\d))/g;

function renderMath(src, display) {
  try {
    return katex.renderToString(src, { displayMode: display, throwOnError: false, strict: "ignore", output: "html" });
  } catch {
    return escapeHtml(src);
  }
}

/** Markdown to HTML. Math is cut out before markdown runs so underscores and stars inside it survive. */
// Code spans and fenced blocks keep their dollar signs: they are set aside before math is found.
const CODE = /(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(\n\2[ \t]*(?=\n|$)|$)|(?<!`)(`+)(?!`)[^\n]*?(?<!`)\4(?!`)/g;

function md(text, { inline = false } = {}) {
  const stash = [];
  const code = [];
  const guarded = String(text ?? "").replace(CODE, (m) => `\u0001${code.push(m) - 1}\u0001`);
  const src = guarded.replace(MATH, (m) => {
    let display = false;
    let body = m;
    if (m.startsWith("$$")) (display = true), (body = m.slice(2, -2));
    else if (m.startsWith("\\[")) (display = true), (body = m.slice(2, -2));
    else if (m.startsWith("\\(")) body = m.slice(2, -2);
    else body = m.slice(1, -1);
    stash.push(renderMath(body.trim(), display));
    return `\u0000${stash.length - 1}\u0000`;
  });
  const restored = src.replace(/\u0001(\d+)\u0001/g, (_, i) => code[Number(i)]);
  const html = inline ? marked.parseInline(restored, { gfm: true }) : marked.parse(restored, { gfm: true, breaks: false });
  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** `{{md:field}}` renders markdown, `{{field}}` inserts escaped text, `{{#field}}…{{/field}}` keeps a block only when the field is set. */
function expand(template, data) {
  const get = (path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), data);
  return String(template ?? "")
    .replace(/\{\{#([\w.]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, k, body) => {
      const v = get(k);
      return v == null || v === "" || v === false || (Array.isArray(v) && !v.length) ? "" : body;
    })
    .replace(/\{\{md:([\w.]+)\}\}/g, (_, k) => md(get(k)))
    .replace(/\{\{mdi:([\w.]+)\}\}/g, (_, k) => md(get(k), { inline: true }))
    .replace(/\{\{([\w.]+)\}\}/g, (_, k) => escapeHtml(get(k)));
}

// ---------- the API a card script receives ----------

function createApi(init, assets = { type: "", files: {} }) {
  let getter = null;
  const assetNames = Object.keys(assets.files ?? {}).sort();
  let resultHandlers = [];
  let screenHandlers = [];
  let submitted = false;
  let ready = true;
  const api = {
    view: init.view ?? {},
    mode: init.mode ?? "answer", // "answer" | "result" | "preview"
    answer: init.answer ?? null,
    result: init.result ?? null,
    root: document.getElementById("card"),
    /** Names of the files the card type ships with. */
    assets: assetNames,
    /** Absolute URL of one of the type's asset files, for `fetch()`, `<img src>` and the like. */
    asset(name) {
      const hash = assets.files?.[name];
      if (hash === undefined) throw new Error(`unknown asset "${name}" (this type has ${assetNames.length ? assetNames.map((n) => `"${n}"`).join(", ") : "no assets"})`);
      return new URL(`type-assets/${encodeURIComponent(assets.type)}/${encodeURIComponent(name)}?h=${hash}`, document.baseURI).href;
    },
    md,
    mdInline: (s) => md(s, { inline: true }),
    /** LaTeX to HTML. */
    tex: (src, display = false) => renderMath(String(src ?? ""), display),
    escape: escapeHtml,
    /** Math answers: parse, print as LaTeX, check equivalence (same as `std.math` in server scripts). */
    math,
    /** Syntax-highlighted HTML for any language CodeMirror knows. */
    async highlight(code, language) {
      return (await kit()).highlight(String(code ?? ""), String(language ?? ""));
    },
    /** Display name of a language id ("py" → "Python"). */
    async languageName(language) {
      return (await kit()).languageName(String(language ?? ""));
    },
    /** A code editor in `el`: `{ value, language, placeholder, readOnly, minLines, onChange }`. */
    async codeEditor(el, opts = {}) {
      return (await kit()).createCodeEditor(el, opts);
    },
    /** A markdown editor with live preview (math, code, formatting) in `el`, like Obsidian's. */
    async markdownEditor(el, opts = {}) {
      return (await kit()).createMarkdownEditor(el, { katex, ...opts });
    },
    /** Plays a sound (a URL, e.g. from `etude.asset()`), stopping the one played before: `{ stop(), finished }`. */
    play: (url) => audio.play(url),
    /** Tell the app how to read the current answer when the learner presses Submit. */
    getAnswer(fn) {
      getter = fn;
    },
    /** Submit now, optionally with an explicit answer. */
    submit(value) {
      if (submitted || api.mode !== "answer") return;
      const answer = value !== undefined ? value : getter ? getter() : null;
      submitted = true;
      send("submit", { answer });
    },
    /** Enable or disable the app's Submit button (e.g. until every blank is filled). */
    setReady(value) {
      ready = !!value;
      send("ready-state", { ready });
    },
    /** Called with `{ grade, key, answer }` once the answer has been graded. */
    onResult(fn) {
      resultHandlers.push(fn);
      if (api.result) fn(api.result);
    },
    /** What this card type saved for itself with `setPref` (a chosen character, a sound switch), shared by all its cards. */
    prefs: { ...(init.prefs ?? {}) },
    /** Saves a preference for this card type: a short key (letters, digits, `_ . -`) and a JSON value; `null` removes it. */
    setPref(key, value) {
      if (typeof key !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(key)) throw new Error("a preference key is 1 to 64 letters, digits, '_', '.' or '-'");
      const v = value === undefined ? null : JSON.parse(JSON.stringify(value));
      if (v === null) delete api.prefs[key];
      else api.prefs[key] = v;
      send("set-pref", { key, value: v });
    },
    /** How much of the screen the card can fill: `{ height }` in CSS pixels, or `{ height: null }` when the page scrolls. */
    screen: { height: init.screen?.height ?? null },
    /** Called with `etude.screen` whenever it changes (focus mode on or off, the window resized). */
    onScreen(fn) {
      screenHandlers.push(fn);
    },
    _screen(height) {
      api.screen = { height: typeof height === "number" && height > 0 ? Math.round(height) : null };
      setScreenVar(api.screen.height);
      for (const fn of screenHandlers) fn(api.screen);
    },
    /** Set to false and the app won't animate this card from its answer to its result (see morph() below). */
    morph: true,
    /** Shortcut helpers. */
    $(sel) {
      return api.root.querySelector(sel);
    },
    $$(sel) {
      return [...api.root.querySelectorAll(sel)];
    },
    html(strings, ...values) {
      return strings.reduce((out, s, i) => out + s + (i < values.length ? escapeHtml(values[i]) : ""), "");
    },
  };
  api._collect = () => {
    if (ready) api.submit();
  };
  api._result = (result) => {
    api.mode = "result";
    api.result = result;
    document.body.dataset.mode = "result";
    for (const fn of resultHandlers) fn(result);
  };
  return api;
}

// ---------- code blocks ----------

/** Highlights fenced code blocks (`pre > code.language-*`) wherever they appear in the card, now or later. */
function watchCodeBlocks(root) {
  let queued = false;
  const run = () => {
    queued = false;
    if (!root.querySelector("pre > code[class*='language-']:not([data-hl])")) return;
    kit().then((k) => k.highlightBlocks(root)).catch(() => {});
  };
  const schedule = () => {
    if (!queued) (queued = true), queueMicrotask(run);
  };
  new MutationObserver(schedule).observe(root, { childList: true, subtree: true });
  schedule();
}

// ---------- the answer → result morph ----------
// When a graded card turns into its result, every piece that stays glides from where it was to where
// it is now, new pieces fade up one after another, and pieces that went away fade out where they were.
// It reads only the card's DOM, so any type gets it. A type can opt out with `etude.morph = false`, or mark
// parts: `data-morph="atom"` moves an element as one piece (scaled), `data-morph="unit"` moves it as one
// piece without scaling (a map sheet that changes height), `data-morph="skip"` leaves a subtree alone.

const MORPH_ATOM = "img, canvas, svg, input, textarea, select, video, audio, .katex, kbd, .cm-editor, [data-morph='atom'], [data-morph='unit']";
const MORPH_KEEP = ["font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "color", "text-align", "text-transform", "white-space", "background-color", "border", "border-radius", "padding", "box-shadow", "opacity", "display", "align-items", "justify-content", "gap", "text-decoration"];
const MORPH_EASE = "cubic-bezier(.2,.8,.2,1)";
const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const motionReduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Every visible leaf of the card (a text block or an atom), with where it is and how it looks. A block that
 *  holds atoms (a sentence with blanks in it) isn't a leaf: its atoms and inline pieces are, so they can move
 *  and appear on their own. */
function morphLeaves(root) {
  const out = [];
  const seen = {};
  const inline = (x) => /^inline/.test(getComputedStyle(x).display) && !x.matches(MORPH_ATOM);
  const walk = (el, top) => {
    if (out.length > 500 || el.matches("script, style, template, [data-morph='skip']")) return;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return;
    const cs = getComputedStyle(el);
    const atom = el.matches(MORPH_ATOM);
    const text = !atom && (!top || !/^inline/.test(cs.display)) && el.textContent.trim() && [...el.children].every(inline) && !el.querySelector(MORPH_ATOM);
    if (atom || text) {
      let key = el.tagName + "|" + (el.tagName === "IMG" ? el.src.slice(-60) : el.id || squash(el.textContent).slice(0, 90));
      seen[key] = (seen[key] ?? 0) + 1;
      key += "#" + seen[key];
      const keep = {};
      for (const p of MORPH_KEEP) keep[p] = cs.getPropertyValue(p);
      out.push({ el, key, r: { left: r.left, top: r.top, width: r.width, height: r.height }, fs: parseFloat(cs.fontSize) || 16, cs: keep, field: el.matches("input, textarea, select"), unit: el.matches("[data-morph='unit']"), text: squash(el.textContent) });
      return;
    }
    for (const c of el.children) walk(c, false);
  };
  for (const c of root.children) walk(c, true);
  return out;
}

/** The leaves in a form that can be posted to another frame (Watch hands a card over to its answered copy). */
const serializeLeaves = (leaves) => leaves.map(({ el, ...o }) => ({ ...o, html: o.field ? "" : el.outerHTML.slice(0, 20000) }));

/** Animates from `before` (leaves taken before the change) to what the card shows now. Returns whether something left. */
function morph(before, root) {
  if (!before?.length || motionReduced()) return null;
  const old = new Map(before.map((o) => [o.key, o]));
  const now = morphLeaves(root);
  const used = new Set();
  const nowKeys = new Set(now.map((o) => o.key));
  const nowText = squash(root.textContent);
  const gone = (o) => !nowKeys.has(o.key) && !o.field && !(o.text && nowText.includes(o.text));
  const leaving = before.some(gone);
  // New pieces wait for leaving ones to clear (170 ms), then rise in reading order, 70 ms apart.
  const base = leaving ? 170 : 70;
  const sr = root.getBoundingClientRect();
  let n = 0;
  now.sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left).forEach((o) => {
    const p = old.get(o.key);
    if (p) {
      used.add(o.key);
      const dx = p.r.left - o.r.left;
      const dy = p.r.top - o.r.top;
      const sx = p.r.width / (o.r.width || 1);
      const sy = p.r.height / (o.r.height || 1);
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.02 && Math.abs(sy - 1) < 0.02) return;
      if (o.unit) {
        o.el.animate([{ translate: `${dx}px ${dy}px` }, { translate: "0 0" }], { duration: 460, easing: MORPH_EASE });
        return;
      }
      const atom = o.el.matches(MORPH_ATOM);
      const fr = p.fs / (parseFloat(getComputedStyle(o.el).fontSize) || 16);
      const sc = atom ? (Math.abs(sx - 1) > 0.04 || Math.abs(sy - 1) > 0.04 ? `${sx} ${sy}` : "1") : Math.abs(fr - 1) > 0.03 ? String(fr) : "1";
      const origin = o.el.style.transformOrigin;
      o.el.style.transformOrigin = "0 0";
      const a = o.el.animate([{ translate: `${dx}px ${dy}px`, scale: sc }, { translate: "0 0", scale: "1" }], { duration: 460, easing: MORPH_EASE });
      const restore = () => { o.el.style.transformOrigin = origin; };
      a.finished.then(restore, restore);
    } else {
      if (o.r.top + o.r.height < sr.top - 40 || o.r.top > sr.top + sr.height + 40) return;
      const delay = base + Math.min(n++, 8) * 70;
      o.el.animate([{ opacity: 0, translate: "0 8px" }, { opacity: 1, translate: "0 0" }], { duration: 420, delay, easing: MORPH_EASE, fill: "backwards" });
    }
  });
  // What went away fades out where it was, as a styled copy (fields and text still on the card get none).
  const host = document.body;
  if (getComputedStyle(host).position === "static") host.style.position = "relative";
  const hr = host.getBoundingClientRect();
  for (const o of before) {
    if (used.has(o.key) || !gone(o)) continue;
    let g;
    if (o.el) g = o.el.cloneNode(true);
    else {
      const t = document.createElement("template");
      t.innerHTML = o.html ?? "";
      g = t.content.firstElementChild;
    }
    if (!g) continue;
    for (const x of [g, ...g.querySelectorAll("[id], [autofocus], [data-autofocus]")]) {
      x.removeAttribute("id");
      x.removeAttribute("autofocus");
      x.removeAttribute("data-autofocus");
    }
    for (const k in o.cs) g.style.setProperty(k, o.cs[k]);
    Object.assign(g.style, { position: "absolute", left: `${o.r.left - hr.left}px`, top: `${o.r.top - hr.top}px`, width: `${o.r.width}px`, height: `${o.r.height}px`, margin: "0", pointerEvents: "none", zIndex: "25", boxSizing: "border-box", transform: "none", animation: "none", transition: "none" });
    g.setAttribute("aria-hidden", "true");
    g.dataset.morphGhost = "";
    host.appendChild(g);
    g.animate([{ opacity: Number(o.cs.opacity) || 1 }, { opacity: 0 }], { duration: 150, easing: "ease-in", fill: "forwards" }).onfinish = () => g.remove();
  }
  return { leaving };
}

// ---------- boot ----------

function applyTheme(theme) {
  if (!theme) return;
  const css = Object.entries(theme.vars ?? {})
    .map(([k, v]) => `${k}: ${v};`)
    .join(" ");
  document.getElementById("etude-theme").textContent = `:root { ${css} color-scheme: ${theme.scheme ?? "dark"}; }`;
}

// --etude-screen-height: the screen height the card can fill, or unset when the page scrolls.
function setScreenVar(height) {
  if (height) document.documentElement.style.setProperty("--etude-screen-height", `${height}px`);
  else document.documentElement.style.removeProperty("--etude-screen-height");
}

function observeSize() {
  const report = () => send("size", { height: Math.ceil(document.body.getBoundingClientRect().height) });
  new ResizeObserver(report).observe(document.body);
  report();
}

function focusCard(root) {
  if (!root) return;
  for (const selector of ["[autofocus], [data-autofocus]", "input, textarea, [contenteditable]", "button"]) {
    for (const el of root.querySelectorAll(selector)) {
      if (el.matches(":disabled, [readonly]") || el.closest("[inert]") || !el.getClientRects().length || getComputedStyle(el).visibility !== "visible") continue;
      if (el.hasAttribute("contenteditable") && !el.isContentEditable) continue;
      if (!selector.startsWith("[autofocus]") && el instanceof HTMLInputElement && !["text", "number", "search", "tel", "url", "email", "password"].includes(el.type)) continue;
      el.focus();
      if (document.activeElement === el) return;
    }
  }
}

function isEmptyField(el) {
  if (el.isContentEditable) return !el.textContent;
  return "value" in el && !el.value;
}

function forwardKeys() {
  window.addEventListener("keydown", (e) => {
    const typing = e.target instanceof HTMLElement && (e.target.matches("input, textarea, select, [contenteditable]") || e.target.isContentEditable);
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      send("key", { key: "Mod+Enter" });
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z" && (document.body.dataset.mode === "result" || !typing)) {
      if (document.body.dataset.mode === "result") {
        e.preventDefault();
        if (!e.repeat) send("key", { key: "Undo" });
      } else if (!e.repeat) {
        setTimeout(() => {
          if (!e.defaultPrevented) send("key", { key: "Undo" });
        }, 0);
      }
      return;
    }
    if (e.key === "Escape") {
      // Escape in a field or editor only leaves the field, so a long answer isn't lost by accident.
      if (typing) {
        e.target.blur();
        return;
      }
      // A popup inside the card may use Escape; forward it only when nothing did.
      setTimeout(() => {
        if (!e.defaultPrevented) send("key", { key: "Escape" });
      }, 0);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Arrows move between cards on pages that browse (Watch); a card that uses them (a map, a board) calls preventDefault.
    // In a field they only leave it while it's empty, so a half-typed answer keeps its caret keys.
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && (!typing || isEmptyField(e.target))) {
      setTimeout(() => {
        if (!e.defaultPrevented) send("key", { key: e.key });
      }, 0);
      return;
    }
    if (typing) return;
    const result = document.body.dataset.mode === "result";
    if (e.repeat && ["u", "U", "=", "-", "@", "!"].includes(e.key)) return;
    const keys = result ? ["1", "2", "3", "4", " ", "Enter", "u", "U", "=", "-", "@", "!"] : [" ", "Enter", "u", "U", "=", "-", "@", "!"];
    if (!keys.includes(e.key)) return;
    // Let the card's own handlers run first; forward only keys the card didn't use.
    setTimeout(() => {
      if (!e.defaultPrevented) send("key", { key: e.key });
    }, 0);
  });
}

/** Splits `<template data-on="result">` blocks out of the source so they render only once the key is known. */
function splitResultBlocks(src) {
  const blocks = [];
  const html = src.replace(/<template\s+data-on=["']result["']\s*>([\s\S]*?)<\/template>/g, (_, body) => {
    blocks.push(body);
    return `<div data-result-slot="${blocks.length - 1}"></div>`;
  });
  return { html, blocks };
}

export function boot(main, templateHtml, assets) {
  document.documentElement.lang ||= "en";
  audio.install();
  let api = null;
  let blocks = [];
  const fillResultSlots = (data) => {
    for (const slot of api.root.querySelectorAll("[data-result-slot]")) {
      const i = Number(slot.dataset.resultSlot);
      slot.outerHTML = expand(blocks[i] ?? "", data);
    }
  };
  // Media can follow the collection when syncing, so a card may open before its files arrive. While files are on
  // their way (the app says so), a collection image that isn't here yet shows a card saying so instead of a broken
  // image, and the images and sounds that failed ask again when files arrive.
  let mediaPending = false;
  const AWAITING = "data-etude-awaiting";
  const ownMedia = (u) => {
    try {
      const media = new URL("media/", document.baseURI), h = new URL(u, document.baseURI);
      return h.origin === media.origin && h.pathname.startsWith(media.pathname);
    } catch {
      return false;
    }
  };
  // The collection URL an image failed to load. The serverless build keeps it in data-etude-src (frame-shim.js).
  const missedUrl = (img) => {
    const url = img.getAttribute("data-etude-src") ?? img.getAttribute("src");
    return url && !/^(data|blob):/.test(url) && ownMedia(url) ? url : null;
  };
  const onItsWay = (img) => {
    const w = Number(img.getAttribute("width")) || (img.clientWidth > 48 ? img.clientWidth : 240);
    const h = Number(img.getAttribute("height")) || (img.clientHeight > 48 ? img.clientHeight : Math.round(w * 0.625));
    const ink = getComputedStyle(img.parentElement ?? document.body).color || "rgb(128, 128, 128)";
    const small = Math.min(w, h), size = Math.max(10, Math.min(15, Math.round(small / 7))), icon = Math.max(12, Math.min(28, Math.round(small / 4)));
    const title = "Image on its way", sub = "Still syncing";
    const words = h >= icon + size * 3.4 && title.length * size * 0.56 <= w - 16;
    const top = words ? (h - (icon + size * 3)) / 2 : (h - icon) / 2;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      `<rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="8" fill="${ink}" fill-opacity=".06" stroke="${ink}" stroke-opacity=".3" stroke-dasharray="5 4"/>` +
      `<g transform="translate(${(w - icon) / 2} ${top}) scale(${icon / 24})" fill="none" stroke="${ink}" stroke-opacity=".7" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">` +
      `<path d="M12 3v11M7.5 9.5 12 14l4.5-4.5M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/></g>` +
      (words
        ? `<g font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" text-anchor="middle" fill="${ink}">` +
          `<text x="${w / 2}" y="${top + icon + size * 1.6}" font-size="${size}" font-weight="600" fill-opacity=".85">${title}</text>` +
          `<text x="${w / 2}" y="${top + icon + size * 2.9}" font-size="${Math.round(size * 0.85)}" fill-opacity=".55">${sub}</text></g>`
        : "") +
      `</svg>`;
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  };
  const awaitImage = (img, url) => {
    img.removeAttribute("data-etude-src");
    img.setAttribute(AWAITING, url);
    img.src = onItsWay(img);
  };
  addEventListener("error", (e) => {
    const img = e.target;
    if (!mediaPending || !(img instanceof HTMLImageElement) || img.hasAttribute(AWAITING)) return;
    const url = missedUrl(img);
    if (url) awaitImage(img, url);
  }, true);
  const again = (url) => {
    const u = new URL(url, document.baseURI);
    u.searchParams.set("etude-retry", String(Date.now()));
    return u.href;
  };
  const retryMedia = () => {
    for (const img of document.querySelectorAll(`img[${AWAITING}]`)) {
      const url = img.getAttribute(AWAITING);
      img.removeAttribute(AWAITING);
      img.src = again(url);
    }
    for (const img of document.querySelectorAll("img[src]")) {
      if (!img.complete || img.naturalWidth > 0 || !ownMedia(img.src)) continue;
      img.src = again(img.src);
    }
    for (const el of document.querySelectorAll("audio, video")) {
      if (!el.error && el.networkState !== HTMLMediaElement.NETWORK_NO_SOURCE) continue;
      const src = el.currentSrc || el.getAttribute("src") || el.querySelector("source[src]")?.getAttribute("src");
      if (src && ownMedia(src)) el.load();
    }
  };
  const setMediaPending = (pending) => {
    mediaPending = pending;
    // Files stopped coming: each waiting image tries once more, and one still missing shows as missing.
    if (!pending) return retryMedia();
    for (const img of document.querySelectorAll("img")) {
      if (img.hasAttribute(AWAITING)) continue;
      const url = missedUrl(img);
      if (url && (img.hasAttribute("data-etude-src") || (img.complete && img.naturalWidth === 0))) awaitImage(img, url);
    }
  };
  window.addEventListener("message", async (e) => {
    if (e.source !== parent) return;
    const msg = e.data;
    if (!msg || msg.etude !== 1) return;
    if (msg.type === "init") {
      mediaPending = !!msg.mediaPending;
      applyTheme(msg.theme);
      document.body.dataset.mode = msg.mode ?? "answer";
      const split = splitResultBlocks(templateHtml);
      blocks = split.blocks;
      api = createApi(msg, assets);
      setScreenVar(api.screen.height);
      // Parse inertly: an `autofocus` attribute inserted into this cross-origin frame makes Chrome log
      // an error and does nothing. focusCard() honours it as data-autofocus instead.
      const tpl = document.createElement("template");
      tpl.innerHTML = expand(split.html, api.view);
      for (const el of tpl.content.querySelectorAll("[autofocus]")) {
        el.removeAttribute("autofocus");
        el.setAttribute("data-autofocus", "");
      }
      api.root.replaceChildren(tpl.content);
      watchCodeBlocks(api.root);
      const showResult = api._result;
      api._result = (result, opts = {}) => {
        // Leaves before the result goes on, so the change can be animated (see morph()).
        const before = opts.morph !== false && api.morph !== false && !motionReduced() ? morphLeaves(api.root) : null;
        if (result?.preview) document.body.dataset.preview = "1";
        fillResultSlots({ ...api.view, ...(result?.key ?? {}), grade: result?.grade });
        showResult(result);
        if (before && api.morph !== false) {
          const m = morph(before, api.root);
          if (m) send("morph", { leaving: m.leaving });
        }
      };
      if (msg.result?.preview) document.body.dataset.preview = "1";
      if (msg.result) fillResultSlots({ ...api.view, ...(msg.result.key ?? {}), grade: msg.result.grade });
      try {
        await main(api);
      } catch (err) {
        api.root.insertAdjacentHTML("beforeend", `<pre class="e-error">${escapeHtml(err?.stack ?? err)}</pre>`);
        send("error", { message: String(err?.message ?? err) });
      }
      observeSize();
      // Handed over from another frame showing the same card (Watch filling in an example answer):
      // animate from where that frame's pieces were.
      if (Array.isArray(msg.morphFrom) && api.morph !== false) morph(msg.morphFrom, api.root);
      send("mounted");
      // A preview (a gallery thumbnail, the inspector's card) never takes the focus: it would scroll the page to itself.
      if (msg.mode !== "result" && msg.mode !== "preview" && msg.focus !== false) focusCard(api.root);
    } else if (msg.type === "collect") api?._collect();
    else if (msg.type === "result") api?._result(msg.result, { morph: msg.morph });
    else if (msg.type === "snapshot") send("snapshot", { req: msg.req, leaves: api && api.morph !== false && !motionReduced() ? serializeLeaves(morphLeaves(api.root)) : null });
    else if (msg.type === "theme") applyTheme(msg.theme);
    else if (msg.type === "screen") api?._screen(msg.height);
    else if (msg.type === "focus") focusCard(api?.root);
    else if (msg.type === "media") retryMedia();
    else if (msg.type === "media-state") setMediaPending(!!msg.pending);
  });
  forwardKeys();
  send("loaded");
}

export { md, escapeHtml, expand };
