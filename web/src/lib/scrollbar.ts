// The Etude 3 scrollbar: hidden at rest, it fades in while an element scrolls and out ~0.7 s after it stops.
// Only --sbA is animated, inline on the element that scrolled, so no component's own transitions change.
const reduced = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;

type Bar = { on?: boolean; value?: number; raf?: number; timer?: ReturnType<typeof setTimeout> };
const bars = new WeakMap<Element, Bar>();

function fade(el: HTMLElement, bar: Bar, to: number, ms: number) {
  if (bar.raf) cancelAnimationFrame(bar.raf);
  const from = bar.value ?? 0;
  if (reduced?.matches || ms <= 0) {
    bar.value = to;
    el.style.setProperty("--sbA", String(to));
    return;
  }
  const t0 = performance.now();
  const step = (t: number) => {
    const k = Math.min(1, (t - t0) / ms);
    bar.value = from + (to - from) * (1 - (1 - k) * (1 - k));
    el.style.setProperty("--sbA", bar.value.toFixed(3));
    if (k < 1) bar.raf = requestAnimationFrame(step);
  };
  bar.raf = requestAnimationFrame(step);
}

export function startScrollbars() {
  document.addEventListener(
    "scroll",
    (e) => {
      const el = (e.target instanceof HTMLElement ? e.target : document.documentElement) as HTMLElement;
      let bar = bars.get(el);
      if (!bar) bars.set(el, (bar = {}));
      if (!bar.on) {
        bar.on = true;
        fade(el, bar, 1, 120);
      }
      clearTimeout(bar.timer);
      bar.timer = setTimeout(() => {
        bar!.on = false;
        fade(el, bar!, 0, 600);
      }, 700);
    },
    { capture: true, passive: true },
  );
}
