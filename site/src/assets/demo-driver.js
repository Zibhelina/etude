// Runs inside each landing-page card frame. The page's demo asks where things are and taps them,
// with real pointer events, so the card's own code handles the answer exactly as it would a person's.
(() => {
  for (const k of ["setPointerCapture", "releasePointerCapture"]) {
    const f = Element.prototype[k];
    Element.prototype[k] = function (id) { try { f.call(this, id); } catch {} };
  }
  // A card focusing its input must never scroll the landing page to it.
  const focus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (o) { return focus.call(this, { ...(o ?? {}), preventScroll: true }); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function point(s) {
    if (s.svg) {
      const svg = document.querySelector(s.sel);
      if (!svg) return null;
      const p = svg.createSVGPoint();
      p.x = s.svg[0]; p.y = s.svg[1];
      const q = p.matrixTransform(svg.getScreenCTM());
      return { x: q.x, y: q.y };
    }
    const el = document.querySelector(s.sel);
    if (!el) return null;
    const r = el.getBoundingClientRect(), [fx, fy] = s.at ?? [0.5, 0.5];
    return { x: r.left + r.width * fx, y: r.top + r.height * fy };
  }
  function fire(type, x, y, target) {
    const t = target ?? document.elementFromPoint(x, y);
    if (!t) return null;
    const o = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, pointerId: 7, pointerType: "mouse", isPrimary: true, button: 0, buttons: /up|click/.test(type) ? 0 : 1, view: window };
    t.dispatchEvent(type.startsWith("pointer") ? new PointerEvent(type, o) : new MouseEvent(type, o));
    return t;
  }
  async function run(s) {
    if (s.kind === "type") {
      const el = document.querySelector(s.into ?? s.sel);
      el.focus();
      // A real InputEvent, so cards that count keystrokes (the typing test) see each one.
      for (const ch of s.text) {
        el.value += ch;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
        await sleep(s.delay ? s.delay * (0.6 + Math.random() * 0.8) : 42);
      }
      return;
    }
    if (s.kind === "range") {
      const el = document.querySelector(s.sel), a = Number(el.value), b = s.value;
      for (let i = 1; i <= 16; i++) { el.value = String(Math.round(a + ((b - a) * i) / 16)); el.dispatchEvent(new Event("input", { bubbles: true })); await sleep(26); }
      return;
    }
    if (s.kind === "drag") {
      const a = point(s), b = point(s.to);
      if (!a || !b) return;
      const t = fire("pointerdown", a.x, a.y);
      for (let i = 1; i <= 24; i++) {
        const k = i / 24, e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        fire("pointermove", a.x + (b.x - a.x) * e, a.y + (b.y - a.y) * e, t);
        await sleep(24);
      }
      fire("pointerup", b.x, b.y, t);
      return;
    }
    const p = point(s);
    if (!p) return;
    const t = fire("pointerdown", p.x, p.y);
    fire("mousedown", p.x, p.y, t);
    await sleep(60);
    fire("pointerup", p.x, p.y, t);
    fire("mouseup", p.x, p.y, t);
    fire("click", p.x, p.y, t);
  }
  addEventListener("message", async (e) => {
    const m = e.data;
    if (e.source !== parent || !m || m.etude !== 1) return;
    if (m.type === "demo-where") parent.postMessage({ etude: 1, type: "demo-ack", id: m.id, point: point(m.step) }, "*");
    else if (m.type === "demo-do") { await run(m.step); parent.postMessage({ etude: 1, type: "demo-ack", id: m.id }, "*"); }
  });
})();
