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

/** No `style` (it can cover the app with a fake screen), no `id`/`name` (they can clobber globals). */
export const ALLOWED_ATTR = ["href", "src", "alt", "title", "class", "colspan", "rowspan", "align", "start", "type", "checked", "disabled", "open", "width", "height", "lang", "dir"];

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
