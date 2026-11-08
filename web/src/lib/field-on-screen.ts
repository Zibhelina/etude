// Keeps the field you type in on screen. A card frame is as tall as its card, so it's the page (or a box)
// around the frame that scrolls: the frame says where its focused field is (runtime.js, watchFields) and
// this scrolls so the field sits as low as it fully shows, above the on-screen keyboard and the bars fixed
// over the page (the study strip, a sticky header, the phone tab bar), with as much of the card above it
// as fits.
import { useCallback, useEffect, useRef, type RefObject } from "react";

/** A box in a window's client coordinates. */
export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}
/** A stretch of the screen from top to bottom. */
export interface Span {
  top: number;
  bottom: number;
}

/** Space kept between the field and the edge it rests on. */
const GAP = 12;

/**
 * How far to scroll (down when positive) for `field` to rest on the bottom of `span`, whole. A field already
 * in view only goes lower while the card's top is out of view, so a card that fits stays where it is. A
 * field taller than the span shows its top.
 */
export function scrollFor(field: Span, card: Span, span: Span): number {
  const top = span.top + GAP;
  const bottom = span.bottom - GAP;
  if (field.bottom - field.top > bottom - top) return field.top - top;
  const d = field.bottom - bottom;
  return d >= 0 ? d : Math.max(d, Math.min(0, card.top - top));
}

/** The part of the layout viewport on screen (the visual viewport: above the on-screen keyboard). */
function screenSpan(win: Window): Span {
  const vv = win.visualViewport;
  return vv ? { top: vv.offsetTop, bottom: vv.offsetTop + vv.height } : { top: 0, bottom: win.innerHeight };
}

/** The bar fixed (or stuck) over the page at a point, unless what's there is the field's frame or holds it. */
function barAt(doc: Document, x: number, y: number, frame: Element): Element | null {
  for (let el = doc.elementFromPoint(x, y); el && el !== doc.body && el !== doc.documentElement; el = el.parentElement) {
    if (el.contains(frame)) return null;
    const p = getComputedStyle(el).position;
    if (p === "fixed" || p === "sticky") return el;
  }
  return null;
}

/** How far a bar's fade (a gradient its ::before or ::after draws past its edge) reaches above and below it. */
function fadeOf(el: Element): { above: number; below: number } {
  const h = el.getBoundingClientRect().height;
  let above = 0;
  let below = 0;
  for (const pseudo of ["::before", "::after"]) {
    const cs = getComputedStyle(el, pseudo);
    if (cs.content === "none" || cs.content === "normal" || cs.position !== "absolute") continue;
    const top = parseFloat(cs.top);
    const height = parseFloat(cs.height);
    if (!Number.isFinite(top) || !Number.isFinite(height)) continue;
    above = Math.max(above, -top);
    below = Math.max(below, top + height - h);
  }
  return { above, below };
}

/** Narrows `span` to what the bars along its edges leave uncovered, looking at the columns `xs`. */
function clearOfBars(doc: Document, span: Span, xs: number[], frame: Element): Span {
  const s = { ...span };
  const bars = (y: number) =>
    xs
      .map((x) => barAt(doc, x, y, frame))
      .filter((b): b is Element => !!b && b.getBoundingClientRect().height < (s.bottom - s.top) / 2);
  // A bar can sit on another (the Ask tab on the study strip), so look again past each one.
  for (let i = 0; i < 3; i++) {
    const below = bars(s.bottom - 1);
    if (!below.length) break;
    s.bottom = Math.min(...below.map((b) => b.getBoundingClientRect().top - fadeOf(b).above));
  }
  for (let i = 0; i < 3; i++) {
    const above = bars(s.top + 1);
    if (!above.length) break;
    s.top = Math.max(...above.map((b) => b.getBoundingClientRect().bottom + fadeOf(b).below));
  }
  return s;
}

/** The boxes that scroll `el`, innermost first, ending with the page unless a fixed box (a dialog) holds it. */
function scrollers(el: Element): Element[] {
  const doc = el.ownerDocument;
  const out: Element[] = [];
  for (let p = el.parentElement; p && p !== doc.body && p !== doc.documentElement; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (/auto|scroll|overlay/.test(cs.overflowY) && p.scrollHeight > p.clientHeight) out.push(p);
    if (cs.position === "fixed") return out;
  }
  out.push(doc.scrollingElement ?? doc.documentElement);
  return out;
}

type Where = () => { field: Box; card: Box };

const inside = (b: Box, host: Element): Box => {
  const r = host.getBoundingClientRect();
  const x = r.left + host.clientLeft;
  const y = r.top + host.clientTop;
  return { top: b.top + y, bottom: b.bottom + y, left: b.left + x, right: b.right + x };
};

/** Scrolls `box` (in `el`'s document) so the field rests where it should within it. */
function placeIn(box: Element, el: Element, where: Where) {
  const doc = el.ownerDocument;
  const win = doc.defaultView!;
  let span = screenSpan(win);
  if (box !== doc.scrollingElement) {
    const r = box.getBoundingClientRect();
    const top = r.top + box.clientTop;
    span = { top: Math.max(span.top, top), bottom: Math.min(span.bottom, top + box.clientHeight) };
  }
  const { field, card } = where();
  const xs = [field.left + 8, (field.left + field.right) / 2, field.right - 8].map((x) => Math.min(Math.max(x, 1), win.innerWidth - 1));
  const d = Math.round(scrollFor(field, card, clearOfBars(doc, span, xs, el)));
  if (d) box.scrollBy({ top: d, behavior: "instant" });
}

/**
 * Brings `field` (a box in `frame`'s own coordinates) on screen: through the boxes that scroll the frame,
 * then the page, then a page holding this one in a frame of its own (a note showing a card) while the focus
 * is in there.
 */
export function revealField(frame: HTMLIFrameElement, field: Box) {
  let el: Element = frame;
  let where: Where = () => ({ card: frame.getBoundingClientRect(), field: inside(field, frame) });
  for (;;) {
    for (const box of scrollers(el)) placeIn(box, el, where);
    const host = el.ownerDocument.defaultView?.frameElement;
    if (!host || host.ownerDocument.activeElement !== host) return;
    const inner = where;
    where = () => {
      const w = inner();
      return { card: inside(w.card, host), field: inside(w.field, host) };
    };
    el = host;
  }
}

/** The outermost window of the app's own (a note page around an embedded card), whose viewport has the keyboard. */
function appWindow(): Window {
  let win: Window = window;
  while (win.frameElement?.ownerDocument.defaultView) win = win.frameElement.ownerDocument.defaultView;
  return win;
}

const screenSize = (win: Window) => ({ width: win.visualViewport?.width ?? win.innerWidth, height: win.visualViewport?.height ?? win.innerHeight });

/** What a frame says about its focused field: where it is, or nothing when no field has the focus. */
export interface FieldMessage {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  reveal?: boolean;
}

/**
 * Keeps the focused field of the card in `frame` on screen; hand the returned function each "field" message.
 * The field is placed when it gets the focus, again while the frame and the screen settle (the frame growing
 * to its card, the on-screen keyboard opening), and when the keyboard comes back or the screen turns. A small
 * resize later (a phone's address bar) leaves the page where the reader scrolled it.
 */
export function useFieldOnScreen(frame: RefObject<HTMLIFrameElement | null>, frameKey: string) {
  const at = useRef<Box | null>(null);
  const settleUntil = useRef(0);
  const place = useCallback(() => {
    const el = frame.current;
    if (el && at.current && el.ownerDocument.activeElement === el) revealField(el, at.current);
  }, [frame]);

  useEffect(() => {
    at.current = null;
    const win = appWindow();
    const target = win.visualViewport ?? win;
    let last = screenSize(win);
    const onResize = () => {
      const now = screenSize(win);
      const keyboard = last.height - now.height > 100 || now.width !== last.width;
      last = now;
      if (keyboard || performance.now() < settleUntil.current) place();
    };
    target.addEventListener("resize", onResize);
    const grown = new ResizeObserver(() => performance.now() < settleUntil.current && place());
    if (frame.current) grown.observe(frame.current);
    return () => {
      target.removeEventListener("resize", onResize);
      grown.disconnect();
    };
  }, [frame, frameKey, place]);

  return useCallback(
    (msg: FieldMessage) => {
      const { top, bottom, left, right } = msg;
      at.current = typeof top === "number" && typeof bottom === "number" ? { top, bottom, left: left ?? 0, right: right ?? 0 } : null;
      if (!msg.reveal || !at.current) return;
      settleUntil.current = performance.now() + 1000;
      place();
    },
    [place],
  );
}
