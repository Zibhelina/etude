// Other people's cursors on a shared page, like Google Docs: a 2 px caret in their color with their name above it
// (it shrinks to a dot after 3 s without moving and comes back when they move), and their selection as a light band.
// Carets sit in an overlay over the page, so they glide 120 ms to a new spot instead of jumping on each poll;
// selections are ordinary decorations. Positions come from the other device: used as they are when the two copies of
// the page agree, clamped to this one, and kept inside the block they named when the copies differ a little.
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { inkOn, presenceLabel, presenceStore, reportPresence } from "@/lib/presence";
import type { SharePerson } from "@/lib/share";
import { cssZoom } from "@/lib/pane-zoom";

/** The index path of the block holding `pos` (the textblock and every block around it). */
export function blockPath(doc: PMNode, pos: number): number[] {
  const $p = doc.resolve(Math.max(0, Math.min(doc.content.size, pos)));
  const out: number[] = [];
  for (let d = 0; d < $p.depth; d++) out.push($p.index(d));
  return out.length ? out : [$p.index(0)];
}

/** The content range of the block at `path`, or null when this copy has no such block. */
export function blockRange(doc: PMNode, path: number[]): { from: number; to: number } | null {
  let node = doc;
  let base = 0;
  let start = -1;
  for (const i of path) {
    if (node.isTextblock || i < 0 || i >= node.childCount) return null;
    let off = base;
    for (let k = 0; k < i; k++) off += node.child(k).nodeSize;
    node = node.child(i);
    start = off;
    base = off + 1;
  }
  if (start < 0 || node.isLeaf) return null;
  return { from: base, to: start + node.nodeSize - 1 };
}

const sameBlock = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Where someone's selection lands in this copy of the page. */
export function placeIn(doc: PMNode, p: Pick<SharePerson, "sel" | "block">): { anchor: number; head: number } | null {
  const sel = p.sel;
  if (!sel || !("head" in sel)) return null;
  const size = doc.content.size;
  const clamp = (n: number, lo = 0, hi = size) => Math.max(lo, Math.min(hi, n));
  let head = clamp(sel.head);
  let anchor = clamp(sel.anchor);
  if (p.block?.length && !sameBlock(blockPath(doc, head), p.block)) {
    // The copies differ (someone typed above): keep the caret inside the block they're in, near the same offset.
    const r = blockRange(doc, p.block);
    if (r) {
      const moved = clamp(head, r.from, r.to);
      anchor = clamp(anchor + (moved - head));
      head = moved;
    }
  }
  return { anchor, head };
}

type Mine = { people: SharePerson[] };
const key = new PluginKey<Mine>("notePresence");
const IDLE_MS = 3000;

/** The selection bands, as inline decorations in each person's color. */
function bands(state: EditorState, people: SharePerson[]): DecorationSet {
  const decos: Decoration[] = [];
  for (const p of people) {
    const at = placeIn(state.doc, p);
    if (!at || at.anchor === at.head) continue;
    const from = Math.min(at.anchor, at.head), to = Math.max(at.anchor, at.head);
    decos.push(Decoration.inline(from, to, { class: "note-presence-sel", style: `--who: ${p.color}` }));
  }
  return DecorationSet.create(state.doc, decos);
}

/** The carets: one element per device in an overlay over the page, moved by transform. */
class Carets {
  private host: HTMLElement;
  private layer: HTMLElement;
  private els = new Map<string, { el: HTMLElement; label: HTMLElement; key: string; idle: ReturnType<typeof setTimeout> | null }>();
  private view: EditorView;
  private people: SharePerson[] = [];
  private ro: ResizeObserver | null = null;
  constructor(view: EditorView) {
    this.view = view;
    this.host = view.dom.parentElement ?? view.dom;
    this.host.classList.add("note-presence-host");
    this.layer = document.createElement("div");
    this.layer.className = "note-presence-layer";
    this.layer.setAttribute("aria-hidden", "true");
    this.host.appendChild(this.layer);
    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(() => this.place());
      this.ro.observe(view.dom);
    }
  }
  set(people: SharePerson[]) {
    this.people = people.filter((p) => p.here && p.sel && "head" in p.sel);
    const seen = new Set<string>();
    for (const p of this.people) {
      seen.add(p.device);
      let e = this.els.get(p.device);
      if (!e) {
        const el = document.createElement("div");
        el.className = "note-presence-caret is-new";
        const label = document.createElement("span");
        label.className = "note-presence-label";
        el.appendChild(label);
        this.layer.appendChild(el);
        e = { el, label, key: "", idle: null };
        this.els.set(p.device, e);
        // The first placement shouldn't glide in from the corner.
        requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove("is-new")));
      }
      e.el.style.setProperty("--who", p.color);
      e.el.style.setProperty("--who-ink", inkOn(p.color));
      e.label.textContent = presenceLabel(p);
      e.el.dataset.name = presenceLabel(p);
      // Moved (or typing): the name shows again, then shrinks to a dot after 3 s of stillness.
      const k = JSON.stringify([p.sel, p.block, p.typing]);
      if (k !== e.key) {
        e.key = k;
        e.el.classList.remove("is-idle");
        if (e.idle) clearTimeout(e.idle);
        const el = e.el;
        e.idle = setTimeout(() => el.classList.add("is-idle"), IDLE_MS);
      }
    }
    for (const [d, e] of this.els)
      if (!seen.has(d)) {
        if (e.idle) clearTimeout(e.idle);
        e.el.remove();
        this.els.delete(d);
      }
    this.place();
  }
  place() {
    const doc = this.view.state.doc;
    const box = this.host.getBoundingClientRect();
    for (const p of this.people) {
      const e = this.els.get(p.device);
      const at = placeIn(doc, p);
      if (!e || !at) continue;
      let c: { left: number; top: number; bottom: number };
      try {
        c = this.view.coordsAtPos(at.head, at.head === at.anchor ? 0 : at.head > at.anchor ? -1 : 1);
      } catch {
        continue;
      }
      // Coordinates come zoomed when the pane has its own zoom; the cursor's translate is inside that zoom.
      const z = cssZoom(this.host);
      const x = (c.left - box.left) / z + this.host.scrollLeft;
      const y = (c.top - box.top) / z + this.host.scrollTop;
      e.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      e.el.style.height = `${Math.max(14, Math.round((c.bottom - c.top) / z))}px`;
    }
  }
  destroy() {
    this.ro?.disconnect();
    for (const e of this.els.values()) if (e.idle) clearTimeout(e.idle);
    this.layer.remove();
    this.host.classList.remove("note-presence-host");
  }
}

/** Typing counts for this long after the last change. */
const TYPING_MS = 2000;

export const NotePresence = Extension.create<{ page: () => { id: string } | null }>({
  name: "notePresence",
  addOptions() {
    return { page: () => null };
  },
  addProseMirrorPlugins() {
    const opts = this.options;
    let typedAt = 0;
    const report = (view: EditorView, from?: { anchor: number; head: number }) => {
      const page = opts.page();
      if (!page) return;
      const sel = from ?? { anchor: view.state.selection.anchor, head: view.state.selection.head };
      reportPresence({ note: page.id, sel, block: blockPath(view.state.doc, sel.head), typing: Date.now() - typedAt < TYPING_MS });
    };
    return [
      new Plugin<Mine>({
        key,
        state: {
          init: () => ({ people: presenceStore.get() }),
          apply: (tr, v) => tr.getMeta(key) ?? v,
        },
        props: {
          decorations: (state) => bands(state, key.getState(state)?.people.filter((p) => p.here) ?? []),
        },
        view: (view) => {
          const carets = new Carets(view);
          carets.set(presenceStore.get());
          const off = presenceStore.subscribe((people) => {
            if (view.isDestroyed) return;
            view.dispatch(view.state.tr.setMeta(key, { people }).setMeta("addToHistory", false));
            carets.set(people);
          });
          // A view-only page has no editable selection: read where the reader clicked from the DOM's.
          const onDomSel = () => {
            if (view.editable) return;
            const s = document.getSelection();
            if (!s?.anchorNode || !view.dom.contains(s.anchorNode) || !s.focusNode) return;
            try {
              report(view, { anchor: view.posAtDOM(s.anchorNode, s.anchorOffset), head: view.posAtDOM(s.focusNode, s.focusOffset) });
            } catch {}
          };
          document.addEventListener("selectionchange", onDomSel);
          const onResize = () => carets.place();
          window.addEventListener("resize", onResize);
          return {
            update: (v, prev) => {
              if (!v.state.doc.eq(prev.doc)) carets.place();
              else if (v.state.selection.eq(prev.selection)) return;
              // Only this person's own moves and typing are theirs to report: a remote change landing isn't.
              if (v.hasFocus() && v.editable) report(v);
            },
            destroy: () => {
              off();
              document.removeEventListener("selectionchange", onDomSel);
              window.removeEventListener("resize", onResize);
              carets.destroy();
            },
          };
        },
        appendTransaction: (trs) => {
          if (trs.some((t) => t.docChanged && !t.getMeta("etude-external") && t.getMeta("addToHistory") !== false)) typedAt = Date.now();
          return null;
        },
      }),
    ];
  },
});
