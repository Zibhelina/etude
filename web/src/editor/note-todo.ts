// Ticking a to-do in a Notebook page: the box pops (fill, ring, a few sparks), the text nudges and a line crosses it,
// and a pop plays. A ticked parent ticks its sub-items one after another with rising notes, the last sub-item ticks
// its parent, unticking one unticks the parents above it, and a list that's all done gets a little victory lap.
// Parents show how many sub-items are done. Ctrl/⌘+Enter ticks the to-do the cursor is in.
// Only the user's own changes animate: outside edits (another app writing the page) and undo/redo don't.
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { cascade, depth, isUnder, tickFlips, todos, type Todos } from "./todo-logic";
import { playSound, primeSounds } from "@/lib/sounds";

const EXTERNAL = "etude-external";
const CASCADE = "etude-todo-cascade";
const key = new PluginKey<{ animate: boolean; direct: number[] }>("todoPop");
const fromHistory = (tr: Transaction) => tr.getMeta("history$") != null;

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const EOUT = "cubic-bezier(.2,.75,.25,1)";
const SPRING = "cubic-bezier(.3,1.6,.5,1)";
const STAGGER = 85;

const cache = new WeakMap<object, Todos>();
const todosOf = (doc: EditorState["doc"]) => {
  let t = cache.get(doc);
  if (!t) cache.set(doc, (t = todos(doc)));
  return t;
};

function counts(state: EditorState): DecorationSet {
  const { items } = todosOf(state.doc);
  const decos: Decoration[] = [];
  for (const it of items) {
    if (!it.kids.length) continue;
    const node = state.doc.nodeAt(it.pos);
    const first = node?.firstChild;
    if (!first || !first.isTextblock) continue;
    const done = it.kids.filter((k) => items[k].checked).length;
    const all = done === it.kids.length;
    const at = it.pos + 1 + first.nodeSize - 1;
    decos.push(
      Decoration.widget(
        at,
        () => {
          const s = document.createElement("span");
          s.className = "todo-count" + (all ? " all" : "");
          s.contentEditable = "false";
          s.textContent = `${done}/${it.kids.length}`;
          return s;
        },
        { side: 1, key: `tc-${it.pos}-${done}-${it.kids.length}`, ignoreSelection: true },
      ),
    );
  }
  return DecorationSet.create(state.doc, decos);
}

// ---- motion ----

function overlay(cls: string, x: number, y: number, w: number, h: number): HTMLElement {
  const e = document.createElement("span");
  e.className = "todo-fx " + cls;
  Object.assign(e.style, { left: `${x - w / 2}px`, top: `${y - h / 2}px`, width: `${w}px`, height: `${h}px` });
  document.body.appendChild(e);
  return e;
}

const parts = (li: HTMLElement) => {
  const box = li.querySelector<HTMLInputElement>(":scope > label > input");
  const texts = [...li.querySelectorAll<HTMLElement>(":scope > div > p")];
  return { box, texts };
};

/** A color as the browser resolves it near `el` (theme variables, color-mix). The probe goes just outside the editor:
 *  anything added inside it makes ProseMirror re-read and redraw that part of the page, cutting the animations short. */
function resolve(color: string, el: HTMLElement): string {
  const probe = document.createElement("span");
  probe.style.color = color;
  probe.style.display = "none";
  (el.closest(".ProseMirror")?.parentElement ?? document.body).appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  return c;
}

/** A line crossing the text, drawn over it (left to right), or taken off it (right to left). Returns how long it takes. */
function strike(p: HTMLElement, delay: number, out: boolean): number {
  const r = document.createRange();
  r.selectNodeContents(p);
  const count = p.querySelector(":scope > .todo-count");
  if (count) r.setEndBefore(count);
  const rects = [...r.getClientRects()].filter((q) => q.width > 1);
  const color = resolve("color-mix(in oklab, var(--muted-foreground) 70%, transparent)", p);
  let d = delay;
  for (const q of rects) {
    const line = overlay("todo-strike", q.left + q.width / 2, q.top + q.height * 0.56, q.width + 2, 1.5);
    line.style.background = color;
    line.style.transformOrigin = out ? "right center" : "left center";
    const dur = out ? 200 : Math.max(160, Math.min(380, q.width * 0.9));
    const a = line.animate([{ transform: `scaleX(${out ? 1 : 0})` }, { transform: `scaleX(${out ? 0 : 1})` }], { duration: dur, delay: out ? 0 : d, easing: "cubic-bezier(.4,0,.2,1)", fill: "both" });
    a.onfinish = () => {
      if (out) return line.remove();
      line.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: "forwards" }).onfinish = () => line.remove();
    };
    a.oncancel = () => line.remove();
    if (!out) d += dur * 0.8;
  }
  return d - delay + (out ? 0 : 60);
}

export function playCheck(li: HTMLElement, delay: number) {
  const { box, texts } = parts(li);
  if (!box) return;
  const opt = (duration: number, extra: KeyframeAnimationOptions = {}) => ({ duration, delay, fill: "backwards" as FillMode, ...extra });
  box.animate([{ transform: "scale(1)" }, { transform: "scale(.75)", offset: 0.3 }, { transform: "scale(1.18)", offset: 0.65 }, { transform: "scale(1)" }], opt(420, { easing: "ease-out" }));
  box.animate([{ borderColor: resolve("color-mix(in oklab, var(--muted-foreground) 70%, transparent)", li) }, { borderColor: resolve("var(--primary)", li) }], opt(120));
  box.animate([{ transform: "scale(0)" }, { transform: "scale(1)" }], opt(300, { easing: SPRING, pseudoElement: "::before" }));
  box.animate([{ transform: "translateY(-1px) rotate(-45deg) scale(0)", opacity: 0 }, { transform: "translateY(-1px) rotate(-45deg) scale(1)", opacity: 1 }], opt(220, { delay: delay + 110, easing: SPRING, pseudoElement: "::after" }));
  window.setTimeout(() => {
    if (!box.isConnected) return;
    const r = box.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const ring = overlay("todo-ring", x, y, r.width, r.height);
    ring.animate([{ transform: "scale(1)", opacity: 0.7 }, { transform: "scale(2.4)", opacity: 0 }], { duration: 520, easing: "ease-out" }).onfinish = () => ring.remove();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.random() * 0.4, dist = 20 + Math.random() * 9, from = r.width / 2 + 1;
      const s = overlay(`todo-spark s${i % 3}`, x, y, 5, 5);
      const at = (d: number) => `translate(${Math.cos(a) * d}px,${Math.sin(a) * d}px)`;
      s.animate([{ transform: `${at(from)} scale(1.2)`, opacity: 1 }, { transform: `${at(dist)} scale(0)`, opacity: 0.9 }], { duration: 520 + Math.random() * 120, easing: EOUT }).onfinish = () => s.remove();
    }
  }, delay);
  const ink = resolve("var(--foreground)", li);
  for (const p of texts) {
    p.animate([{ transform: "translateX(0)" }, { transform: "translateX(3px)" }, { transform: "translateX(0)" }], { duration: 320, delay, easing: "ease-out" });
    // The text keeps its unticked look until the drawn line has crossed it, then the real line fades in under it.
    const hold = 130 + strike(p, delay + 130, false);
    p.animate([{ color: ink, textDecorationColor: "transparent" }, { color: ink, textDecorationColor: "transparent", offset: hold / (hold + 220) }, {}], { duration: hold + 220, delay, fill: "backwards" });
  }
}

export function playUncheck(li: HTMLElement) {
  const { box, texts } = parts(li);
  if (!box) return;
  box.animate([{ transform: "scale(1)" }, { transform: "scale(.9)" }, { transform: "scale(1)" }], { duration: 200 });
  box.animate([{ transform: "scale(1)" }, { transform: "scale(0)" }], { duration: 180, easing: "ease-in", pseudoElement: "::before" });
  box.animate([{ transform: "translateY(-1px) rotate(-45deg) scale(1)", opacity: 1 }, { transform: "translateY(-1px) rotate(-45deg) scale(0)", opacity: 0 }], { duration: 140, easing: "ease-in", pseudoElement: "::after" });
  for (const p of texts) strike(p, 0, true);
}

function victoryLap(view: EditorView, t: Todos, root: number, delay: number) {
  playSound("done", { delay });
  if (reduced()) return;
  t.roots[root].forEach((i, n) => {
    const li = view.nodeDOM(t.items[i].pos) as HTMLElement | null;
    const box = li?.querySelector<HTMLElement>(":scope > label > input");
    box?.animate([{ transform: "scale(1)" }, { transform: "scale(1.28)" }, { transform: "scale(1)" }], { duration: 300, delay: delay + n * 55, easing: "ease-out" });
  });
}

function animate(view: EditorView, prev: EditorState, direct: number[]) {
  const a = todosOf(prev.doc), b = todosOf(view.state.doc);
  const changed = tickFlips(prev.doc, view.state.doc, a.items, b.items);
  if (!changed?.length) return;
  const items = b.items;
  const isDirect = new Set(direct);
  const ticks: { i: number; delay: number; step: number }[] = [];
  let step = 0, last = 0;
  // The ones you clicked, then what they pulled down with them, then the parents that filled up (deepest first).
  for (const i of changed) if (isDirect.has(i)) ticks.push({ i, delay: 0, step: 0 });
  const below = changed.filter((i) => !isDirect.has(i) && direct.some((d) => isUnder(items, i, d)));
  below.forEach((i, n) => ticks.push({ i, delay: (last = (n + 1) * STAGGER), step: (step = n + 1) }));
  const above = changed.filter((i) => !isDirect.has(i) && !below.includes(i)).sort((x, y) => depth(items, y) - depth(items, x));
  above.forEach((i, n) => ticks.push({ i, delay: (last = last + (n ? 200 : 280)), step: (step = step + 1) }));
  const still = reduced();
  for (const t of ticks) {
    const li = view.nodeDOM(items[t.i].pos) as HTMLElement | null;
    if (items[t.i].checked) {
      playSound("tick", { delay: t.delay, step: t.step });
      if (li && !still) playCheck(li, t.delay);
    } else {
      if (isDirect.has(t.i)) playSound("tick", { step: -5, gain: 0.45 });
      if (li && !still) playUncheck(li);
    }
  }
  b.roots.forEach((list, r) => {
    const done = list.length > 0 && list.every((i) => items[i].checked);
    const wasDone = list.every((i) => a.items[i].checked);
    if (done && !wasDone) victoryLap(view, b, r, last + 420);
  });
}

export const TodoPop = Extension.create({
  name: "todoPop",
  addKeyboardShortcuts() {
    return {
      "Mod-Enter": () => {
        const { state } = this.editor;
        const $from = state.selection.$from;
        for (let d = $from.depth; d > 0; d--) {
          const node = $from.node(d);
          if (node.type.name !== "taskItem") continue;
          const pos = $from.before(d);
          return this.editor.commands.command(({ tr }) => {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: !node.attrs.checked });
            return true;
          });
        }
        return false;
      },
    };
  },
  addProseMirrorPlugins() {
    primeSounds();
    return [
      new Plugin({
        key,
        state: {
          init: () => ({ animate: false, direct: [] as number[] }),
          apply(tr, prev) {
            if (tr.getMeta(CASCADE)) return prev;
            if (!tr.docChanged) return prev.animate ? { animate: false, direct: [] } : prev;
            if (tr.getMeta(EXTERNAL) || fromHistory(tr)) return { animate: false, direct: [] };
            return { animate: true, direct: tickFlips(tr.before, tr.doc, todosOf(tr.before).items, todosOf(tr.doc).items) ?? [] };
          },
        },
        appendTransaction(trs, oldState, newState) {
          if (!trs.some((t) => t.docChanged) || trs.some((t) => t.getMeta(EXTERNAL) || t.getMeta(CASCADE) || fromHistory(t))) return null;
          const t = todosOf(newState.doc);
          const direct = tickFlips(oldState.doc, newState.doc, todosOf(oldState.doc).items, t.items);
          if (!direct?.length) return null;
          const more = cascade(t.items, direct);
          if (!more.size) return null;
          const tr = newState.tr;
          for (const [i, v] of more) {
            const node = tr.doc.nodeAt(t.items[i].pos);
            if (node) tr.setNodeMarkup(t.items[i].pos, undefined, { ...node.attrs, checked: v });
          }
          return tr.setMeta(CASCADE, true);
        },
        view: () => ({
          update(view, prev) {
            if (prev.doc === view.state.doc) return;
            const s = key.getState(view.state);
            if (!s?.animate || !s.direct.length) return;
            animate(view, prev, s.direct);
          },
        }),
        props: {
          decorations: (state) => counts(state),
        },
      }),
    ];
  },
});
