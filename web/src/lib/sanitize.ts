// HTML sanitizing for app-side Markdown (deck descriptions, AI feedback, agent replies). That text can come
// from a shared pack, a Market deck, an Anki package or a model, so it's untrusted: only an allowlist of
// formatting tags and attributes survives, with no event handlers, scripts, styles, frames, forms or
// script URLs. Card bodies don't come through here; they render inside their own sandboxed frame.
import type { Config, DOMPurify } from "dompurify";

/** Tags Markdown produces, plus a few harmless ones people write by hand. */
export const ALLOWED_TAGS = [
  "a", "abbr", "b", "blockquote", "br", "code", "dd", "del", "details", "div", "dl", "dt", "em", "h1", "h2", "h3",
  "h4", "h5", "h6", "hr", "i", "img", "input", "kbd", "li", "mark", "ol", "p", "pre", "s", "small", "span", "strong",
  "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
];

/** No `id`/`name` (they can clobber globals). `style` survives only as typography, filtered by STYLE_PROPS below,
 *  because positioning or sizing could cover the app with a fake screen. */
export const ALLOWED_ATTR = ["href", "src", "alt", "title", "class", "colspan", "rowspan", "align", "start", "type", "checked", "disabled", "open", "width", "height", "lang", "dir", "style"];

/** CSS properties a `style` attribute may keep: how text looks, never where or how big a box is. */
const STYLE_PROPS = new Set([
  "color", "background-color", "font-family", "font-size", "font-weight", "font-style", "font-variant", "text-decoration",
  "text-decoration-line", "text-decoration-color", "text-decoration-style", "text-decoration-thickness", "text-underline-offset",
  "text-transform", "letter-spacing", "line-height", "opacity",
]);

/** Font sizes up to 4em (or 64px, 4rem, 400%); letter spacing within half an em either way. */
function styleValueOk(prop: string, value: string): boolean {
  if (/url\(|expression|\\|@|<|>|var\(/i.test(value)) return false;
  if (prop === "font-size") {
    const m = /^(\d*\.?\d+)(em|rem|px|%)$/.exec(value.trim());
    if (!m) return /^(?:smaller|larger|x?x-small|small|medium|large|x?x-large)$/.test(value.trim());
    const n = Number(m[1]);
    return m[2] === "px" ? n <= 64 : m[2] === "%" ? n <= 400 : n <= 4;
  }
  if (prop === "letter-spacing") {
    const m = /^(-?\d*\.?\d+)(em|px)$/.exec(value.trim());
    return value.trim() === "normal" || (!!m && Math.abs(Number(m[1])) <= (m[2] === "px" ? 8 : 0.5));
  }
  if (prop === "opacity") return Number(value) >= 0.3 && Number(value) <= 1;
  return true;
}

/** Rebuilds a span's style keeping only the typographic declarations above; other elements lose it. */
function filterStyle(el: Element) {
  const style = (el as HTMLElement).style;
  if (!style || el.tagName !== "SPAN") return el.removeAttribute("style");
  const kept: string[] = [];
  for (let i = 0; i < style.length; i++) {
    const prop = style.item(i);
    const value = style.getPropertyValue(prop);
    if (STYLE_PROPS.has(prop) && value && styleValueOk(prop, value)) kept.push(`${prop}: ${value}`);
  }
  if (kept.length) el.setAttribute("style", kept.join("; "));
  else el.removeAttribute("style");
}

/** http(s), mailto, in-page anchors and same-origin paths such as /media/... and /deck?name=... */
const SAFE_URL = /^(?:https?:|mailto:|#|\/(?!\/)|\.{0,2}\/|[^:/?#]*(?:[/?#]|$))/i;

const CONFIG: Config = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  ALLOWED_URI_REGEXP: SAFE_URL,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  // Unknown or dropped elements lose their markup but keep their text.
  KEEP_CONTENT: true,
  RETURN_TRUSTED_TYPE: false,
};

const configured = new WeakSet<object>();

/** Adds the hooks once per DOMPurify instance. */
function setup(purify: DOMPurify) {
  if (configured.has(purify)) return;
  configured.add(purify);
  purify.addHook("afterSanitizeAttributes", (node) => {
    const el = node as Element;
    if (el.hasAttribute?.("style")) filterStyle(el);
    // GFM task lists render `<input type="checkbox" disabled>`; nothing else may be an input.
    if (el.tagName === "INPUT") {
      if ((el.getAttribute("type") ?? "").toLowerCase() !== "checkbox") {
        el.remove();
        return;
      }
      el.setAttribute("disabled", "");
    }
    // Images may be same-origin media, https, or an inline raster image.
    if (el.tagName === "IMG") {
      const src = el.getAttribute("src") ?? "";
      if (src && !/^(?:https?:|\/(?!\/)|data:image\/(?:png|jpe?g|gif|webp|avif);)/i.test(src)) el.removeAttribute("src");
    }
    // Links that leave the app open in a new tab and don't hand it a window.opener.
    if (el.tagName === "A") {
      const href = el.getAttribute("href") ?? "";
      if (/^(?:https?:|mailto:)/i.test(href)) {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      }
    }
  });
}

/** Sanitizes HTML with the given DOMPurify instance (the browser's, or a jsdom-backed one in tests). */
export function sanitizeHtml(purify: DOMPurify, html: string): string {
  setup(purify);
  return purify.sanitize(html, { ...CONFIG, ADD_ATTR: ["target", "rel"] }) as string;
}
