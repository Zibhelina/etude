// What Ask Etude can know about the screen. Every message carries a short view (the route, what each page says
// is open, the text the user selected); when the model asks, the app reads the text visible right now or takes a
// picture of the window. Only Etude's own window: the chat itself, card answers and other apps never go in.
import { useEffect } from "react";

/** Never read or pictured: the chat, Minimi's balloons, and anything a page marks private. */
const IGNORE = "[data-agent-panel], [data-minimi-chat], [data-agent-ignore], [data-sonner-toaster]";
const BLOCK = new Set(["P", "DIV", "LI", "TR", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "SECTION", "ARTICLE", "HEADER", "FOOTER", "NAV", "ASIDE", "FIGURE", "FIGCAPTION", "DT", "DD", "TABLE", "UL", "OL", "LABEL", "BUTTON", "SUMMARY", "DETAILS", "MAIN", "FORM", "TD", "TH"]);
const MAX_TEXT = 12_000;
const SHOT_WIDTH = 1600;

// ------------------------------------------------------------------ what pages say is open

const published = new Map<string, string[]>();

/** A page saying what it has open, in a few plain lines ("Tabs: …", "Card on screen: …"). Gone when it unmounts. */
export function useScreenLines(key: string, lines: string[] | null) {
  const text = lines ? JSON.stringify(lines) : "";
  useEffect(() => {
    if (!text) return;
    published.set(key, JSON.parse(text));
    return () => void published.delete(key);
  }, [key, text]);
}

// ------------------------------------------------------------------ the selection

let lastSelection = "";
const inIgnored = (n: Node | null) => !!(n && (n.nodeType === 1 ? (n as Element) : n.parentElement)?.closest(IGNORE));

if (typeof document !== "undefined") {
  // Clicking into the chat's box moves the selection there, so the last one made on the page is what counts.
  document.addEventListener("selectionchange", () => {
    const s = document.getSelection();
    if (!s || inIgnored(s.anchorNode) || inIgnored(document.activeElement)) return;
    lastSelection = s.isCollapsed ? "" : s.toString();
  });
}

/** The view sent with every message. */
export function currentView(): { lines: string[]; selection?: string } {
  const lines = [...published.values()].flat();
  const dialog = [...document.querySelectorAll<HTMLElement>("[role=dialog], [role=alertdialog]")].find((d) => !d.closest(IGNORE) && d.checkVisibility?.());
  if (dialog) {
    const title = dialog.querySelector("h1, h2, h3, [data-slot=dialog-title]")?.textContent?.trim();
    lines.push(`A dialog is open${title ? `: "${title}"` : ""}`);
  }
  return { lines, ...(lastSelection.trim() ? { selection: lastSelection.trim() } : {}) };
}

// ------------------------------------------------------------------ reading the screen

function onScreen(r: DOMRect, vw: number, vh: number) {
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
}

/** The nearest block-level ancestor, so text in one paragraph stays on one line. */
function blockOf(el: Element): Element {
  for (let e: Element | null = el; e; e = e.parentElement) if (BLOCK.has(e.tagName) || getComputedStyle(e).display.match(/block|flex|grid|table|list-item/)) return e;
  return el;
}

/** The text visible in the window right now, in reading order, with headings and a note for what can't be read. */
export function readScreen(): string {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const out: string[] = [];
  let line = "";
  let lastBlock: Element | null = null;
  let size = 0;
  const flush = () => {
    const t = line.replace(/\s+/g, " ").trim();
    if (t && out[out.length - 1] !== t) {
      out.push(t);
      size += t.length;
    }
    line = "";
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (n.nodeType === 1) {
        const el = n as Element;
        if (el.matches(IGNORE) || el.matches("script, style, noscript, template, svg")) return NodeFilter.FILTER_REJECT;
        if (el.getAttribute("aria-hidden") === "true" && !el.closest(".ProseMirror")) return NodeFilter.FILTER_REJECT;
        if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const range = document.createRange();
  const seen = new Set<Element>();
  for (let n = walker.nextNode(); n && size < MAX_TEXT; n = walker.nextNode()) {
    if (n.nodeType === 1) {
      const el = n as HTMLElement;
      const r = el.getBoundingClientRect();
      if (!onScreen(r, vw, vh)) continue;
      if (el.tagName === "IFRAME") {
        flush();
        out.push(`[embedded frame${el.title ? `: ${el.title}` : ""}, its inside can't be read; a card's text is in the page lines]`);
      } else if (el.tagName === "CANVAS" && r.width > 160 && r.height > 120) {
        // Excalidraw and PDF pages stack several canvases: one line for each of them.
        const owner = el.closest(".excalidraw, .note-pdf-note, [data-pdf]") ?? el;
        if (seen.has(owner)) continue;
        seen.add(owner);
        flush();
        out.push(owner.matches(".excalidraw") ? "[a drawing canvas; take a screenshot to see it]" : owner === el ? "[a drawn picture or chart; take a screenshot to see it]" : "[PDF pages; their text is below when it has any, take a screenshot to see them]");
      } else if (el.tagName === "IMG" && r.width > 48) {
        const alt = (el as HTMLImageElement).alt.trim();
        if (alt) {
          flush();
          out.push(`[image: ${alt}]`);
        }
      } else if ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") && !(el as HTMLInputElement).type?.match(/password|hidden|checkbox|radio|file/)) {
        const v = (el as HTMLInputElement).value.trim();
        const ph = (el as HTMLInputElement).placeholder;
        if (v || ph) {
          flush();
          out.push(v ? `[field${ph ? ` "${ph}"` : ""}: ${v.slice(0, 300)}]` : `[empty field "${ph}"]`);
        }
      } else if ((el as HTMLInputElement).type === "checkbox" && el.tagName === "INPUT") line += (el as HTMLInputElement).checked ? " [x] " : " [ ] ";
      continue;
    }
    const text = n.textContent ?? "";
    if (!text.trim()) continue;
    range.selectNodeContents(n);
    if (![...range.getClientRects()].some((r) => onScreen(r, vw, vh))) continue;
    const parent = n.parentElement!;
    const block = blockOf(parent);
    if (block !== lastBlock) {
      flush();
      lastBlock = block;
      const h = block.closest("h1, h2, h3, h4, [role=heading]");
      if (h) line = `${"#".repeat(Math.min(4, Number(h.tagName.slice(1)) || 2))} `;
    }
    line += text;
  }
  flush();
  const scroller = document.scrollingElement;
  const where = scroller && scroller.scrollHeight > vh * 1.2 ? ` The window is scrolled ${Math.round((scroller.scrollTop / Math.max(1, scroller.scrollHeight - vh)) * 100)}% down.` : "";
  const text = out.join("\n");
  return `Visible in the Etude window (${vw}×${vh}).${where}\n\n${size >= MAX_TEXT ? text.slice(0, MAX_TEXT) + "\n… (more on screen, cut)" : text}`;
}

// ------------------------------------------------------------------ a picture of the window

/** The window as a JPEG data URL, without the chat panel. At most 1600 px wide. */
export async function screenshot(): Promise<{ image: string; width: number; height: number }> {
  const { snapdom } = await import("@zumer/snapdom");
  const bg = getComputedStyle(document.body).backgroundColor;
  const shot = await snapdom(document.body, {
    clip: "viewport",
    exclude: IGNORE,
    excludeMode: "hide",
    backgroundColor: bg && bg !== "rgba(0, 0, 0, 0)" ? bg : getComputedStyle(document.documentElement).backgroundColor || "#0f0f0f",
    dpr: 1,
    embedFonts: "auto",
  });
  const canvas = await shot.toCanvas();
  const scale = Math.min(1, SHOT_WIDTH / canvas.width);
  let c = canvas;
  if (scale < 1) {
    c = document.createElement("canvas");
    c.width = Math.round(canvas.width * scale);
    c.height = Math.round(canvas.height * scale);
    c.getContext("2d")!.drawImage(canvas, 0, 0, c.width, c.height);
  }
  return { image: c.toDataURL("image/jpeg", 0.8), width: c.width, height: c.height };
}

/** Answers the model's look: the visible text, or the picture. */
export async function look(mode: "text" | "image"): Promise<{ text?: string; image?: string; width?: number; height?: number; error?: string }> {
  try {
    if (mode === "text") return { text: readScreen() };
    return await screenshot();
  } catch (e) {
    return { error: (e as Error).message || String(e) };
  }
}
