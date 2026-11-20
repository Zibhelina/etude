// Whether a focused field shows above the on-screen keyboard (native-shell.ts scrolls it into view when not).

/** Room kept between a focused field and the top of the keyboard (or of the screen). */
const FIELD_GAP = 16;

/**
 * Whether `el` shows whole in the part of the page on screen (above the on-screen keyboard) with a little
 * room around it, and nothing fixed sits over it (a bar along the bottom of the page).
 */
export function fieldInView(el: Element, win: Window = window): boolean {
  const vv = win.visualViewport;
  const top = vv?.offsetTop ?? 0;
  const bottom = top + (vv?.height ?? win.innerHeight);
  const r = el.getBoundingClientRect();
  if (r.top < top + FIELD_GAP || r.bottom > bottom - FIELD_GAP) return false;
  const hit = win.document.elementFromPoint(r.left + Math.min(r.width / 2, 24), (r.top + r.bottom) / 2);
  return !hit || hit === el || el.contains(hit) || hit.contains(el);
}
