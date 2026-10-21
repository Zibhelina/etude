// Card runtime. Loaded inside every card's sandboxed frame; gives the type's script the `etude` API.
// The frame has an opaque origin: it can only talk to the app through postMessage.
import { marked } from "./vendor/marked.js";
import katex from "./vendor/katex.js";

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
function md(text, { inline = false } = {}) {
  const stash = [];
  const src = String(text ?? "").replace(MATH, (m) => {
    let display = false;
    let body = m;
    if (m.startsWith("$$")) (display = true), (body = m.slice(2, -2));
    else if (m.startsWith("\\[")) (display = true), (body = m.slice(2, -2));
    else if (m.startsWith("\\(")) body = m.slice(2, -2);
    else body = m.slice(1, -1);
    stash.push(renderMath(body.trim(), display));
    return `\u0000${stash.length - 1}\u0000`;
  });
  const html = inline ? marked.parseInline(src, { gfm: true }) : marked.parse(src, { gfm: true, breaks: false });
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

function createApi(init) {
  let getter = null;
  let resultHandlers = [];
  let submitted = false;
  let ready = true;
  const api = {
    view: init.view ?? {},
    mode: init.mode ?? "answer", // "answer" | "result" | "preview"
    answer: init.answer ?? null,
    result: init.result ?? null,
    root: document.getElementById("card"),
    md,
    mdInline: (s) => md(s, { inline: true }),
    escape: escapeHtml,
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

// ---------- boot ----------

function applyTheme(theme) {
  if (!theme) return;
  const css = Object.entries(theme.vars ?? {})
    .map(([k, v]) => `${k}: ${v};`)
    .join(" ");
  document.getElementById("etude-theme").textContent = `:root { ${css} color-scheme: ${theme.scheme ?? "dark"}; }`;
}

function observeSize() {
  const report = () => send("size", { height: Math.ceil(document.body.getBoundingClientRect().height) });
  new ResizeObserver(report).observe(document.body);
  report();
}

function forwardKeys() {
  window.addEventListener("keydown", (e) => {
    const typing = e.target instanceof HTMLElement && (e.target.matches("input, textarea, select, [contenteditable]") || e.target.isContentEditable);
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      send("key", { key: "Mod+Enter" });
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && document.body.dataset.mode === "result") {
      e.preventDefault();
      send("key", { key: "Undo" });
      return;
    }
    if (e.key === "Escape") {
      send("key", { key: "Escape" });
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    const result = document.body.dataset.mode === "result";
    const keys = result ? ["1", "2", "3", "4", " ", "Enter", "u"] : [" ", "Enter"];
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

export function boot(main, templateHtml) {
  let api = null;
  let blocks = [];
  const fillResultSlots = (data) => {
    for (const slot of api.root.querySelectorAll("[data-result-slot]")) {
      const i = Number(slot.dataset.resultSlot);
      slot.outerHTML = expand(blocks[i] ?? "", data);
    }
  };
  window.addEventListener("message", async (e) => {
    if (e.source !== parent) return;
    const msg = e.data;
    if (!msg || msg.etude !== 1) return;
    if (msg.type === "init") {
      applyTheme(msg.theme);
      document.body.dataset.mode = msg.mode ?? "answer";
      const split = splitResultBlocks(templateHtml);
      blocks = split.blocks;
      api = createApi(msg);
      api.root.innerHTML = expand(split.html, api.view);
      const showResult = api._result;
      api._result = (result) => {
        if (result?.preview) document.body.dataset.preview = "1";
        fillResultSlots({ ...api.view, ...(result?.key ?? {}), grade: result?.grade });
        showResult(result);
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
      send("mounted");
      if (msg.mode !== "result") (api.root.querySelector("[autofocus]") ?? api.root.querySelector("input, textarea"))?.focus?.();
    } else if (msg.type === "collect") api?._collect();
    else if (msg.type === "result") api?._result(msg.result);
    else if (msg.type === "theme") applyTheme(msg.theme);
    else if (msg.type === "focus") (api?.root.querySelector("[autofocus], input, textarea, button") ?? document.body).focus?.();
  });
  forwardKeys();
  send("loaded");
}

export { md, escapeHtml, expand };
