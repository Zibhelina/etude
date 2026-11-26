// Builds the HTML document a card renders in. The document is served from its own route and
// loaded into an iframe with `sandbox="allow-scripts"` (no same-origin), so a card's code can't
// read the app, its cookies or the API. It talks to the app only through postMessage.
import type { CardTypeDef, Template } from "../core/model.ts";
import { netConnectOrigins } from "../core/plugins.ts";

/** What a card needs to find its type's assets: the type id and each asset's content hash. */
export interface FrameAssets {
  type: string;
  files: { name: string; hash: string }[];
}

const esc = (s: string) => s.replace(/<\/(script|style)/gi, "<\\/$1");

/**
 * The frame's Content-Security-Policy: a card's code may load the runtime, KaTeX, its type's assets
 * and collection media from the Etude server, and data:/blob: URLs it makes itself, and nothing
 * else. That keeps a Market card type from sending what the user studies or types to another host.
 */
export function frameCsp(base: string): string {
  let origin: string;
  try {
    origin = new URL(base).origin;
  } catch {
    // A relative base (the static website's prebuilt frames) is served from the page's own origin.
    origin = "'self'";
  }
  const self = origin === "null" ? "'none'" : origin;
  return [
    "default-src 'none'",
    `script-src ${self} 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:`,
    `style-src ${self} 'unsafe-inline'`,
    `img-src ${self} data: blob:`,
    `media-src ${self} data: blob:`,
    `font-src ${self} data:`,
    `connect-src ${self} data: blob:`,
    `worker-src ${self} blob:`,
    "frame-src 'none'",
    "form-action 'none'",
    `base-uri ${self}`,
  ].join("; ");
}

export function cardFrame(def: CardTypeDef, base: string, assets?: FrameAssets): string {
  const js = def.template.js ?? "";
  const assetMap = { type: assets?.type ?? def.id, files: Object.fromEntries((assets?.files ?? []).map((f) => [f.name, f.hash])) };
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${frameCsp(base)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base href="${base}">
<link rel="stylesheet" href="${base}runtime/vendor/katex.css">
<link rel="stylesheet" href="${base}runtime/card.css">
<link rel="stylesheet" href="${base}runtime/code.css">
<style id="etude-theme"></style>
<style>${esc(def.template.css ?? "")}</style>
</head>
<body data-mode="answer">
<div id="card"></div>
<script type="module">
import { boot } from "${base}runtime/runtime.js";
const template = ${JSON.stringify(def.template.html).replace(/</g, "\\u003c")};
boot(async (etude) => {
  const std = {
    normalize: (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/\\s+/g, " ").trim(),
  };
${esc(js)}
}, template, ${JSON.stringify(assetMap).replace(/</g, "\\u003c")});
</script>
</body>
</html>`;
}

/**
 * Sandboxed frame for a custom Deck Home (`home.html` / `home.css` / `home.js`).
 * Same opaque origin and strict Content-Security-Policy as a card frame: receives the deck's
 * subdecks, cards and progress over postMessage, and asks the app to open a subdeck, card or queue.
 */
export function deckHomeFrame(tpl: Template, base: string, assets?: FrameAssets): string {
  const js = tpl.js ?? "";
  const assetMap = { type: assets?.type ?? "", files: Object.fromEntries((assets?.files ?? []).map((f) => [f.name, f.hash])) };
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${frameCsp(base)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base href="${base}">
<link rel="stylesheet" href="${base}runtime/vendor/katex.css">
<link rel="stylesheet" href="${base}runtime/card.css">
<link rel="stylesheet" href="${base}runtime/code.css">
<style id="etude-theme"></style>
<style>${esc(tpl.css ?? "")}</style>
</head>
<body data-mode="home">
<div id="home"></div>
<script type="module">
import { bootHome } from "${base}runtime/runtime.js";
const template = ${JSON.stringify(tpl.html).replace(/</g, "\\u003c")};
bootHome(async (etude) => {
  const std = {
    normalize: (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/\\s+/g, " ").trim(),
  };
${esc(js)}
}, template, ${JSON.stringify(assetMap).replace(/</g, "\\u003c")});
</script>
</body>
</html>`;
}

// ------------------------------------------------------------------ plugin frames

/**
 * Strict Content-Security-Policy for plugin controller and view iframes.
 * No external scripts, no eval, no sub-frames, and outbound `connect-src` is `'none'`
 * unless the user explicitly granted `net:<host>` permissions.
 */
export function pluginCsp(granted: string[]): string {
  const origins = netConnectOrigins(granted);
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "media-src data: blob:",
    "font-src data:",
    `connect-src ${origins.length ? origins.join(" ") : "'none'"}`,
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

function pluginBridgeScript(pluginId: string, mode: "controller" | "view", view: string | null): string {
  const meta = JSON.stringify({ pluginId, mode, view }).replace(/</g, "\\u003c");
  return `(() => {
  const META = ${meta};
  let seq = 0;
  const pending = new Map();
  const cmdHandlers = new Map();
  const msgHandlers = [];
  const actionHandlers = [];
  const reviewHandlers = [];

  function call(op, args) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      window.parent.postMessage({ etudePlugin: META.pluginId, kind: "call", id, op, args: args ?? [] }, "*");
    });
  }

  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (!d || d.etudePlugin !== META.pluginId) return;
    if (d.kind === "reply" && pending.has(d.id)) {
      const p = pending.get(d.id);
      pending.delete(d.id);
      if (d.ok) p.resolve(d.value);
      else p.reject(new Error(d.error || "plugin call failed"));
      return;
    }
    if (d.kind === "theme" && d.vars && typeof d.vars === "object") {
      for (const [k, v] of Object.entries(d.vars)) {
        if (typeof k === "string" && k.startsWith("--") && typeof v === "string") {
          document.documentElement.style.setProperty(k, v);
        }
      }
      if (typeof d.colorScheme === "string" && /^(light|dark|light dark|dark light)$/.test(d.colorScheme)) {
        document.documentElement.style.colorScheme = d.colorScheme;
      }
      return;
    }
    if (d.kind === "runCommand" && cmdHandlers.has(d.commandId)) {
      Promise.resolve(cmdHandlers.get(d.commandId)()).catch((err) => {
        window.parent.postMessage({ etudePlugin: META.pluginId, kind: "error", message: String(err?.message || err) }, "*");
      });
      return;
    }
    if (d.kind === "message") {
      for (const fn of msgHandlers) try { fn(d.payload); } catch {}
      return;
    }
    if (d.kind === "action") {
      for (const fn of actionHandlers) try { fn(d.actionId); } catch {}
      return;
    }
    if (d.kind === "review") {
      for (const fn of reviewHandlers) try { fn(d.review); } catch {}
    }
  });

  window.etude = Object.freeze({
    pluginId: META.pluginId,
    mode: META.mode,
    view: META.view,
    commands: Object.freeze({
      register(cmd) {
        if (!cmd || typeof cmd.id !== "string" || typeof cmd.run !== "function") throw new Error("command requires id and run()");
        cmdHandlers.set(cmd.id, cmd.run);
        return call("commands.register", [{ id: cmd.id, label: String(cmd.label || cmd.id), shortcut: cmd.shortcut ? String(cmd.shortcut) : undefined, contextMenu: !!cmd.contextMenu }]);
      },
    }),
    floating: Object.freeze({
      open: (opts) => call("floating.open", [opts ?? {}]),
      close: () => call("floating.close", []),
      isOpen: () => call("floating.isOpen", []),
      resize: (opts) => call("floating.resize", [opts ?? {}]),
      post: (payload) => call("floating.post", [payload]),
    }),
    storage: Object.freeze({
      get: (key) => call("storage.get", [String(key)]),
      set: (key, value) => call("storage.set", [String(key), value]),
      getAll: () => call("storage.getAll", []),
      appendEvent: (kind, payload) => call("storage.appendEvent", [String(kind), payload]),
      listEvents: (opts) => call("storage.listEvents", [opts ?? {}]),
    }),
    notify: (opts) => call("notify", [opts ?? {}]),
    read: Object.freeze({
      decks: () => call("read.decks", []),
      cards: (opts) => call("read.cards", [opts ?? {}]),
      reviews: (opts) => call("read.reviews", [opts ?? {}]),
      notes: (opts) => call("read.notes", [opts ?? {}]),
    }),
    write: Object.freeze({
      createCard: (opts) => call("write.createCard", [opts ?? {}]),
      createNote: (opts) => call("write.createNote", [opts ?? {}]),
    }),
    onMessage: (fn) => { if (typeof fn === "function") msgHandlers.push(fn); },
    onAction: (fn) => { if (typeof fn === "function") actionHandlers.push(fn); },
    onReview: (fn) => { if (typeof fn === "function") reviewHandlers.push(fn); },
  });

  window.parent.postMessage({ etudePlugin: META.pluginId, kind: "ready", mode: META.mode, view: META.view }, "*");
})();`;
}

/** Sandboxed hidden controller iframe for a plugin's `main.js`. */
export function pluginControllerFrame(pluginId: string, mainJs: string, granted: string[]): string {
  const bridge = pluginBridgeScript(pluginId, "controller", null);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${pluginCsp(granted)}">
</head>
<body>
<script>${esc(bridge)}</script>
<script>
(async () => {
  try {
    const etude = window.etude;
${esc(mainJs)}
  } catch (err) {
    window.parent.postMessage({ etudePlugin: ${JSON.stringify(pluginId)}, kind: "error", message: String(err && err.message || err) }, "*");
  }
})();
</script>
</body>
</html>`;
}

/** Sandboxed UI view iframe for one of a plugin's HTML views (floating panel, sidebar, tab). */
export function pluginViewFrame(pluginId: string, viewId: string, viewHtml: string, granted: string[]): string {
  const bridge = pluginBridgeScript(pluginId, "view", viewId);
  // Strip any author-supplied CSP or <base> tag so the host's CSP always wins.
  const cleaned = viewHtml
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, "")
    .replace(/<base\b[^>]*>/gi, "");
  const headInject = `<meta http-equiv="Content-Security-Policy" content="${pluginCsp(granted)}">\n<script>${esc(bridge)}</script>\n`;
  const headMatch = /<head\b[^>]*>/i.exec(cleaned);
  const scriptMatch = /<script\b/i.exec(cleaned);
  if (headMatch && (!scriptMatch || headMatch.index < scriptMatch.index)) {
    return cleaned.slice(0, headMatch.index + headMatch[0].length) + "\n" + headInject + cleaned.slice(headMatch.index + headMatch[0].length);
  }
  return `<!doctype html><html><head><meta charset="utf-8">${headInject}</head><body>${cleaned}</body></html>`;
}

// ------------------------------------------------------------------ course frames

/**
 * Content-Security-Policy for sandboxed course iframes.
 * Courses are self-contained HTML/CSS/JS (plain HTML or built with Etude Course Kit):
 * they can use inline scripts/styles, embedded data/blob images, media and fonts,
 * and communicate with Etude only via the postMessage bridge.
 */
export function courseCsp(baseOrigin?: string): string {
  const self = baseOrigin && baseOrigin !== "null" ? ` ${baseOrigin}` : "";
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: data:",
    "style-src 'unsafe-inline' https:",
    `img-src data: blob: https:${self}`,
    `media-src data: blob: https:${self}`,
    "font-src data: https:",
    "connect-src 'none'",
    "worker-src blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

function courseBridgeScript(courseId: string): string {
  const idJson = JSON.stringify(courseId).replace(/</g, "\\u003c");
  return `(() => {
  const COURSE_ID = ${idJson};
  const themeHandlers = [];
  const stateHandlers = [];
  let lastTheme = null;
  let lastState = null;

  function applyTheme(vars, scheme) {
    let el = document.getElementById("etude-host-theme");
    if (!el) {
      el = document.createElement("style");
      el.id = "etude-host-theme";
      (document.head || document.documentElement).prepend(el);
    }
    const decls = [];
    if (vars && typeof vars === "object") {
      for (const [k, v] of Object.entries(vars)) {
        if (typeof k === "string" && k.startsWith("--") && typeof v === "string") {
          decls.push(k + ":" + v);
        }
      }
    }
    const resolved = scheme === "light" ? "light" : "dark";
    el.textContent = ":root{color-scheme:" + resolved + ";" + decls.join(";") + "}";
    document.documentElement.dataset.etudeHost = "1";
    document.documentElement.dataset.etudeScheme = resolved;
    lastTheme = { scheme: resolved, vars: vars || {} };
    window.dispatchEvent(new CustomEvent("etude:theme", { detail: lastTheme }));
    for (const fn of themeHandlers) try { fn(lastTheme); } catch {}
  }

  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (!d || d.etudeCourse !== COURSE_ID) return;
    if (d.kind === "theme") {
      applyTheme(d.vars, d.colorScheme);
      return;
    }
    if (d.kind === "state") {
      lastState = d.state && typeof d.state === "object" ? d.state : {};
      for (const fn of stateHandlers) try { fn(lastState); } catch {}
    }
  });

  window.etudeCourse = Object.freeze({
    id: COURSE_ID,
    onTheme(fn) {
      if (typeof fn !== "function") return;
      themeHandlers.push(fn);
      if (lastTheme) try { fn(lastTheme); } catch {}
    },
    onState(fn) {
      if (typeof fn !== "function") return;
      stateHandlers.push(fn);
      if (lastState) try { fn(lastState); } catch {}
    },
    getState() { return lastState; },
    saveState(state, summary) {
      window.parent.postMessage({ etudeCourse: COURSE_ID, kind: "save", state: state ?? {}, summary: summary ?? null }, "*");
    },
    reportProgress(summary) {
      window.parent.postMessage({ etudeCourse: COURSE_ID, kind: "progress", summary: summary ?? null }, "*");
    },
  });

  window.parent.postMessage({ etudeCourse: COURSE_ID, kind: "ready" }, "*");
})();`;
}

/** Sandboxed iframe document for an installed Course. Injects host CSP, live theme style slot and progress bridge. */
export function courseFrame(courseId: string, courseHtml: string, baseOrigin?: string): string {
  const bridge = courseBridgeScript(courseId);
  const cleaned = courseHtml
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, "")
    .replace(/<base\b[^>]*>/gi, "");
  const headInject = `<meta http-equiv="Content-Security-Policy" content="${courseCsp(baseOrigin)}">\n<style id="etude-host-theme"></style>\n<script>${esc(bridge)}</script>\n`;
  const headMatch = /<head\b[^>]*>/i.exec(cleaned);
  const scriptMatch = /<script\b/i.exec(cleaned);
  if (headMatch && (!scriptMatch || headMatch.index < scriptMatch.index)) {
    return cleaned.slice(0, headMatch.index + headMatch[0].length) + "\n" + headInject + cleaned.slice(headMatch.index + headMatch[0].length);
  }
  return `<!doctype html><html><head><meta charset="utf-8">${headInject}</head><body>${cleaned}</body></html>`;
}
