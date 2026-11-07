// Notes split view: the open pages as up to four panes, each with its own tabs. A layout is a tree:
// a pane, or a split of two layouts side by side ("row") or one over the other ("col").
// Everything here is pure, so the screen and the tests share it.

export type PaneNode = { k: "pane"; id: string; tabs: string[]; active: string | null };
export type SplitNode = { k: "split"; dir: "row" | "col"; a: LayoutNode; b: LayoutNode; r: number };
export type LayoutNode = PaneNode | SplitNode;
export type Layout = { root: LayoutNode; focus: string };
export type Side = "left" | "right" | "top" | "bottom";
/** Where a dragged tab lands: in a pane's tabs (before a tab, or at the end), or at a pane's edge as a new pane. */
export type TabDrop = { pane: string; before: string | null } | { pane: string; side: Side };
export type Rect = { x: number; y: number; w: number; h: number };

export const MAX_PANES = 4;

let seq = 0;
export const newPaneId = () => `p${Date.now().toString(36)}${(seq++).toString(36)}`;

export function single(tabs: string[], active: string | null = null): Layout {
  const id = newPaneId();
  const t = [...new Set(tabs)];
  return { root: { k: "pane", id, tabs: t, active: active && t.includes(active) ? active : (t[0] ?? null) }, focus: id };
}

export function panes(n: LayoutNode): PaneNode[] {
  return n.k === "pane" ? [n] : [...panes(n.a), ...panes(n.b)];
}
export const count = (n: LayoutNode) => panes(n).length;
export const findPane = (n: LayoutNode, id: string) => panes(n).find((p) => p.id === id);
export const focusedPane = (l: Layout) => findPane(l.root, l.focus) ?? panes(l.root)[0];

function mapPane(n: LayoutNode, id: string, f: (p: PaneNode) => PaneNode): LayoutNode {
  if (n.k === "pane") return n.id === id ? f(n) : n;
  const a = mapPane(n.a, id, f);
  const b = mapPane(n.b, id, f);
  return a === n.a && b === n.b ? n : { ...n, a, b };
}

/** The tree without that pane; its sibling takes the space. Null when it was the only one. */
function removePane(n: LayoutNode, id: string): LayoutNode | null {
  if (n.k === "pane") return n.id === id ? null : n;
  const a = removePane(n.a, id);
  const b = removePane(n.b, id);
  if (!a) return b;
  if (!b) return a;
  return a === n.a && b === n.b ? n : { ...n, a, b };
}

function splitPane(n: LayoutNode, target: string, side: Side, fresh: PaneNode): LayoutNode {
  if (n.k === "pane") {
    if (n.id !== target) return n;
    const dir = side === "left" || side === "right" ? "row" : "col";
    const first = side === "left" || side === "top";
    return { k: "split", dir, a: first ? fresh : n, b: first ? n : fresh, r: 0.5 };
  }
  const a = splitPane(n.a, target, side, fresh);
  const b = splitPane(n.b, target, side, fresh);
  return a === n.a && b === n.b ? n : { ...n, a, b };
}

/** The pane next to this one in the tree (the first pane of its sibling), for focus after it closes. */
function neighbour(n: LayoutNode, id: string): string | null {
  if (n.k === "pane") return null;
  if (n.a.k === "pane" && n.a.id === id) return panes(n.b)[0].id;
  if (n.b.k === "pane" && n.b.id === id) return panes(n.a)[panes(n.a).length - 1].id;
  return neighbour(n.a, id) ?? neighbour(n.b, id);
}

/** A split's share for its first side, by the split's path from the root ("", "a", "ab", …). */
export function setRatio(n: LayoutNode, path: string, r: number): LayoutNode {
  if (n.k === "pane") return n;
  if (!path) return { ...n, r: Math.min(0.95, Math.max(0.05, r)) };
  const [h, rest] = [path[0], path.slice(1)];
  return h === "a" ? { ...n, a: setRatio(n.a, rest, r) } : { ...n, b: setRatio(n.b, rest, r) };
}

/** Where each pane sits, as fractions of the whole area, plus the bars between them. */
export function rects(n: LayoutNode, box: Rect = { x: 0, y: 0, w: 1, h: 1 }, path = ""): { panes: (Rect & { id: string })[]; bars: (Rect & { path: string; dir: "row" | "col"; r: number })[] } {
  if (n.k === "pane") return { panes: [{ id: n.id, ...box }], bars: [] };
  const { x, y, w, h } = box;
  const A: Rect = n.dir === "row" ? { x, y, w: w * n.r, h } : { x, y, w, h: h * n.r };
  const B: Rect = n.dir === "row" ? { x: x + w * n.r, y, w: w * (1 - n.r), h } : { x, y: y + h * n.r, w, h: h * (1 - n.r) };
  const ra = rects(n.a, A, path + "a");
  const rb = rects(n.b, B, path + "b");
  return { panes: [...ra.panes, ...rb.panes], bars: [{ path, dir: n.dir, r: n.r, ...box }, ...ra.bars, ...rb.bars] };
}

function withTab(p: PaneNode, note: string, mode: "replace" | "new" | "background"): PaneNode {
  if (p.tabs.includes(note)) return mode === "background" ? p : { ...p, active: note };
  const at = p.active ? p.tabs.indexOf(p.active) : -1;
  const tabs = [...p.tabs];
  if (mode === "replace" && at >= 0) tabs[at] = note;
  else tabs.splice(at < 0 ? tabs.length : at + 1, 0, note);
  return { ...p, tabs, active: mode === "background" && p.active ? p.active : note };
}

/** Opening a page in a pane: replace its current tab (a plain click), or a new tab next to it. */
export function openIn(l: Layout, pane: string, note: string, mode: "replace" | "new" | "background" = "replace"): Layout {
  if (!findPane(l.root, pane)) return l;
  return { ...l, root: mapPane(l.root, pane, (p) => withTab(p, note, mode)) };
}

export function activate(l: Layout, pane: string, note: string): Layout {
  const p = findPane(l.root, pane);
  if (!p || !p.tabs.includes(note)) return l;
  if (p.active === note && l.focus === pane) return l;
  return { root: mapPane(l.root, pane, (q) => ({ ...q, active: note })), focus: pane };
}

export function focus(l: Layout, pane: string): Layout {
  return l.focus === pane || !findPane(l.root, pane) ? l : { ...l, focus: pane };
}

/** A page in a new pane at the side of this one. Null when there are already four. */
export function openSplit(l: Layout, pane: string, note: string, side: Side): Layout | null {
  if (count(l.root) >= MAX_PANES || !findPane(l.root, pane)) return null;
  const fresh: PaneNode = { k: "pane", id: newPaneId(), tabs: [note], active: note };
  return { root: splitPane(l.root, pane, side, fresh), focus: fresh.id };
}

function dropTab(p: PaneNode, note: string): PaneNode {
  const at = p.tabs.indexOf(note);
  if (at < 0) return p;
  const tabs = p.tabs.filter((t) => t !== note);
  return { ...p, tabs, active: p.active === note ? (tabs[Math.min(at, tabs.length - 1)] ?? null) : p.active };
}

/** Closing a tab. A pane whose last tab closes goes away, unless it's the only one. */
export function closeTab(l: Layout, pane: string, note: string): Layout {
  const p = findPane(l.root, pane);
  if (!p || !p.tabs.includes(note)) return l;
  const left = dropTab(p, note);
  if (!left.tabs.length && count(l.root) > 1) {
    const next = neighbour(l.root, pane);
    const root = removePane(l.root, pane)!;
    return { root, focus: l.focus === pane ? (next ?? panes(root)[0].id) : l.focus };
  }
  return { ...l, root: mapPane(l.root, pane, () => left) };
}

/** Whether dropping a tab at a pane's edge would make a new pane (and stay within four). */
export function canSplitTo(l: Layout, from: string, note: string, to: string): boolean {
  const src = findPane(l.root, from);
  if (!src || !src.tabs.includes(note) || !findPane(l.root, to)) return false;
  if (from === to) return src.tabs.length > 1 && count(l.root) < MAX_PANES;
  // The pane it leaves goes away when that was its only tab, so the count stays the same.
  return count(l.root) < MAX_PANES || src.tabs.length === 1;
}

/** Moving a dragged tab. Null means nothing changes. */
export function moveTab(l: Layout, from: string, note: string, to: TabDrop): Layout | null {
  const src = findPane(l.root, from);
  const dst = findPane(l.root, to.pane);
  if (!src || !dst || !src.tabs.includes(note)) return null;
  if ("side" in to) {
    if (!canSplitTo(l, from, note, to.pane)) return null;
    let root: LayoutNode = l.root;
    const rest = dropTab(src, note);
    root = !rest.tabs.length && from !== to.pane ? removePane(root, from)! : mapPane(root, from, () => rest);
    const fresh: PaneNode = { k: "pane", id: newPaneId(), tabs: [note], active: note };
    return { root: splitPane(root, to.pane, to.side, fresh), focus: fresh.id };
  }
  const place = (tabs: string[]) => {
    const t = tabs.filter((x) => x !== note);
    const at = to.before && to.before !== note ? t.indexOf(to.before) : -1;
    t.splice(at < 0 ? t.length : at, 0, note);
    return t;
  };
  if (from === to.pane) {
    const tabs = place(src.tabs);
    if (tabs.join("\n") === src.tabs.join("\n") && src.active === note) return l.focus === from ? null : focus(l, from);
    return { root: mapPane(l.root, from, (p) => ({ ...p, tabs, active: note })), focus: from };
  }
  const rest = dropTab(src, note);
  let root: LayoutNode = mapPane(l.root, to.pane, (p) => ({ ...p, tabs: place(p.tabs), active: note }));
  root = rest.tabs.length ? mapPane(root, from, () => rest) : removePane(root, from)!;
  return { root, focus: to.pane };
}

/** Pages that were archived or deleted leave their tabs; panes left empty close. */
export function prune(l: Layout, exists: (id: string) => boolean): Layout {
  let root = l.root;
  for (const p of panes(l.root)) {
    if (p.tabs.every(exists) && (p.active === null || exists(p.active))) continue;
    const tabs = p.tabs.filter(exists);
    const at = p.active ? p.tabs.indexOf(p.active) : -1;
    const active = p.active && exists(p.active) ? p.active : (tabs[Math.min(Math.max(at, 0), tabs.length - 1)] ?? null);
    root = mapPane(root, p.id, () => ({ ...p, tabs, active }));
  }
  for (const p of panes(root)) if (!p.tabs.length && count(root) > 1) root = removePane(root, p.id)!;
  const f = findPane(root, l.focus) ? l.focus : panes(root)[0].id;
  return root === l.root && f === l.focus ? l : { root, focus: f };
}

/** A layout read back from storage, or null if it isn't one. */
export function normalizeLayout(raw: unknown): Layout | null {
  const seen = new Set<string>();
  const node = (v: any, depth: number): LayoutNode | null => {
    if (!v || typeof v !== "object" || depth > 6) return null;
    if (v.k === "pane") {
      if (typeof v.id !== "string" || seen.has(v.id) || !Array.isArray(v.tabs)) return null;
      seen.add(v.id);
      const tabs: string[] = [...new Set<string>(v.tabs.filter((t: unknown): t is string => typeof t === "string"))];
      const active = typeof v.active === "string" && tabs.includes(v.active) ? v.active : (tabs[0] ?? null);
      return { k: "pane", id: v.id, tabs, active };
    }
    if (v.k === "split") {
      const a = node(v.a, depth + 1);
      const b = node(v.b, depth + 1);
      if (!a || !b || (v.dir !== "row" && v.dir !== "col")) return null;
      const r = typeof v.r === "number" && v.r > 0.05 && v.r < 0.95 ? v.r : 0.5;
      return { k: "split", dir: v.dir, a, b, r };
    }
    return null;
  };
  const root = node((raw as any)?.root, 0);
  if (!root || count(root) > MAX_PANES) return null;
  const f = typeof (raw as any).focus === "string" && findPane(root, (raw as any).focus) ? (raw as any).focus : panes(root)[0].id;
  return { root, focus: f };
}
