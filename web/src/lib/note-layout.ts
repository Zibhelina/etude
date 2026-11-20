// Notes split view: the open pages as up to four panes, each with its own tabs. A layout is a tree:
// a pane, or a split of two layouts side by side ("row") or one over the other ("col").
// Everything here is pure, so the screen and the tests share it.

/** A named, coloured run of tabs in a pane, like a browser's tab group. Folded, its tabs hide behind its label. */
export type TabGroup = { id: string; name: string; color: GroupColor; tabs: string[]; collapsed?: boolean };
export const GROUP_COLORS = ["gray", "blue", "red", "yellow", "green", "pink", "purple", "orange"] as const;
/** One of the named colours (they follow the theme), or any colour of your own as "#rrggbb". */
export type GroupColor = (typeof GROUP_COLORS)[number] | `#${string}`;
export const isGroupColor = (c: unknown): c is GroupColor => typeof c === "string" && ((GROUP_COLORS as readonly string[]).includes(c) || /^#[0-9a-f]{6}$/i.test(c));
/** A group's colour as CSS: a named one is the Notebook's own colour of that name. */
export const groupTint = (c: GroupColor) => (c.startsWith("#") ? c : `var(--nc-${c})`);
/** `pinned`: tabs kept small (just their icon), which a click on a page never replaces. Both are saved with the layout. */
/** `icons`: a pinned tab's own icon (an emoji, an illustration or a picture, as a page's icon is written), to tell the small tabs apart. */
/** `zoom`: how big this pane's contents show (1 or left out: as the app), apart from the rest of the window. */
export type PaneNode = { k: "pane"; id: string; tabs: string[]; active: string | null; pinned?: string[]; groups?: TabGroup[]; icons?: Record<string, string>; zoom?: number };
export type SplitNode = { k: "split"; dir: "row" | "col"; a: LayoutNode; b: LayoutNode; r: number };
export type LayoutNode = PaneNode | SplitNode;
export type Layout = { root: LayoutNode; focus: string };
export type Side = "left" | "right" | "top" | "bottom";
/** Where a dragged tab lands: in a pane's tabs (before a tab, or at the end), or at a pane's edge as a new pane. */
/** `group` says which group it lands in (null: none) when the pointer was on a group's label or one of its tabs; left out, a drop between a group's tabs joins it. */
export type TabDrop = { pane: string; before: string | null; group?: string | null } | { pane: string; side: Side };
export type Rect = { x: number; y: number; w: number; h: number };

export const MAX_PANES = 4;

let seq = 0;
export const newPaneId = () => `p${Date.now().toString(36)}${(seq++).toString(36)}`;

export function single(tabs: string[], active: string | null = null): Layout {
  const id = newPaneId();
  const t = [...new Set(tabs)];
  return { root: { k: "pane", id, tabs: t, active: active && t.includes(active) ? active : (t[0] ?? null) }, focus: id };
}

export const newGroupId = () => `g${Date.now().toString(36)}${(seq++).toString(36)}`;
export const isPinned = (p: PaneNode | undefined, tab: string) => !!p?.pinned?.includes(tab);
export const groupOf = (p: PaneNode | undefined, tab: string) => p?.groups?.find((g) => g.tabs.includes(tab));
/** The tabs a pane shows: all of them but the ones folded away in a group. */
export const visibleTabs = (p: PaneNode) => p.tabs.filter((t) => !groupOf(p, t)?.collapsed);

/**
 * A pane with its pins and groups in order: each group's tabs side by side (where its first one sits), nothing
 * pinned and grouped at once, no group left empty, and the front tab never folded away.
 */
export function tidyPane(p: PaneNode): PaneNode {
  if (!p.pinned?.length && !p.groups?.length) {
    if (p.pinned === undefined && p.groups === undefined && p.icons === undefined) return p;
    const { pinned: _p, groups: _g, icons: _i, ...rest } = p;
    return rest;
  }
  const has = new Set(p.tabs);
  const pinned = [...new Set(p.pinned ?? [])].filter((t) => has.has(t));
  const pin = new Set(pinned);
  const taken = new Set<string>();
  const groups: TabGroup[] = [];
  for (const g of p.groups ?? []) {
    const tabs = p.tabs.filter((t) => g.tabs.includes(t) && !pin.has(t) && !taken.has(t));
    if (!tabs.length) continue;
    for (const t of tabs) taken.add(t);
    groups.push({ id: g.id, name: g.name, color: isGroupColor(g.color) ? g.color : "gray", tabs, ...(g.collapsed && !tabs.includes(p.active ?? "") ? { collapsed: true } : {}) });
  }
  const by = new Map(groups.flatMap((g) => g.tabs.map((t) => [t, g] as const)));
  // Pinned tabs stay wherever they were put, anywhere along the strip.
  const out: string[] = [];
  const placed = new Set<string>();
  for (const t of p.tabs) {
    const g = by.get(t);
    if (!g) out.push(t);
    else if (!placed.has(g.id)) {
      placed.add(g.id);
      out.push(...g.tabs);
    }
  }
  // Only pinned tabs carry an icon of their own.
  const icons = Object.fromEntries(Object.entries(p.icons ?? {}).filter(([t, v]) => pin.has(t) && typeof v === "string" && v));
  const { pinned: _p, groups: _g, icons: _i, ...rest } = p;
  return { ...rest, tabs: out, ...(pinned.length ? { pinned: out.filter((t) => pin.has(t)) } : {}), ...(groups.length ? { groups } : {}), ...(Object.keys(icons).length ? { icons } : {}) };
}

const same = (a: PaneNode, b: PaneNode) => a === b || JSON.stringify(a) === JSON.stringify(b);
function tidy(l: Layout): Layout {
  let root = l.root;
  for (const p of panes(l.root)) {
    const t = tidyPane(p);
    if (!same(t, p)) root = mapPane(root, p.id, () => t);
  }
  return root === l.root ? l : { ...l, root };
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
  // A pinned tab keeps its page: what would replace it opens after it (and after the pins right beside it).
  const replace = mode === "replace" && at >= 0 && !isPinned(p, p.active!);
  let after = at;
  while (after >= 0 && isPinned(p, tabs[after]) && isPinned(p, tabs[after + 1] ?? "")) after++;
  if (replace) tabs[at] = note;
  else tabs.splice(at < 0 ? tabs.length : after + 1, 0, note);
  // The page that takes a grouped tab's place stays in its group; so does a tab opened from one.
  const g = at >= 0 && (replace || mode !== "replace") ? groupOf(p, p.active!) : undefined;
  const groups = g ? p.groups!.map((x) => (x.id !== g.id ? x : { ...x, tabs: replace ? x.tabs.map((t) => (t === p.active ? note : t)) : [...x.tabs, note] })) : p.groups;
  return { ...p, tabs, ...(groups ? { groups } : {}), active: mode === "background" && p.active ? p.active : note };
}

/** Opening a page in a pane: replace its current tab (a plain click), or a new tab next to it. */
export function openIn(l: Layout, pane: string, note: string, mode: "replace" | "new" | "background" = "replace"): Layout {
  if (!findPane(l.root, pane)) return l;
  return tidy({ ...l, root: mapPane(l.root, pane, (p) => withTab(p, note, mode)) });
}

export function activate(l: Layout, pane: string, note: string): Layout {
  const p = findPane(l.root, pane);
  if (!p || !p.tabs.includes(note)) return l;
  if (p.active === note && l.focus === pane) return l;
  return tidy({ root: mapPane(l.root, pane, (q) => ({ ...q, active: note })), focus: pane });
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
  if (p.active !== note) return { ...p, tabs };
  // The next tab in view takes the front: the one after it, else the one before, skipping folded groups.
  const open = (t: string) => !groupOf(p, t)?.collapsed;
  const next = p.tabs.slice(at + 1).find(open) ?? p.tabs.slice(0, at).reverse().find(open) ?? tabs[Math.min(at, tabs.length - 1)] ?? null;
  return { ...p, tabs, active: next };
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
  return tidy({ ...l, root: mapPane(l.root, pane, () => left) });
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
  if ("side" in to) {
    const split = moveTabRaw(l, from, note, to);
    if (!split) return null;
    // A pinned tab split off into a pane of its own stays pinned, with its icon.
    const was = findPane(l.root, from);
    const icon = was?.icons?.[note];
    return tidy(isPinned(was, note) ? { ...split, root: mapPane(split.root, split.focus, (p) => ({ ...p, pinned: [note], ...(icon ? { icons: { [note]: icon } } : {}) })) } : split);
  }
  const src = findPane(l.root, from);
  const dst = findPane(l.root, to.pane);
  if (!src || !dst || !src.tabs.includes(note)) return null;
  // Dropped on a group's label or among its tabs, it joins the group; anywhere else it leaves the one it was in.
  // A drop that moves nothing can still change its group.
  const joins = joinOf(dst, note, to);
  const moved = moveTabRaw(l, from, note, to) ?? l;
  // A pinned tab dragged to another pane's tabs is pinned there too, with its icon, unless it lands in a group.
  const pin = from !== to.pane && !joins && isPinned(src, note) ? { icon: src.icons?.[note] } : null;
  const next = tidy({
    ...moved,
    root: mapPane(moved.root, to.pane, (p) => {
      // Dropped among the pins it takes that place; anywhere else it goes after them.
      const q = pin ? { ...p, pinned: [...(p.pinned ?? []), note], ...(pin.icon ? { icons: { ...(p.icons ?? {}), [note]: pin.icon } } : {}) } : p;
      return joined(q, note, joins, dst.active);
    }),
  });
  const before = findPane(l.root, to.pane)!;
  const after = findPane(next.root, to.pane)!;
  return from === to.pane && next.focus === l.focus && same(before, after) ? null : next;
}

/** The group a tab dropped among a pane's tabs lands in: the one the drop names, else the one whose tabs it fell between. */
function joinOf(dst: PaneNode | undefined, note: string, to: { before: string | null; group?: string | null }): string | null {
  if (to.group !== undefined) return to.group && dst?.groups?.some((g) => g.id === to.group) ? to.group : null;
  const into = to.before && to.before !== note ? groupOf(dst, to.before) : undefined;
  return into && into.tabs[0] !== to.before ? into.id : null;
}
/** The pane with the tab in that group and no other. It keeps the place it was dropped at when that's among the
 *  group's tabs or right before the first; dropped on the label or anywhere else, it goes after the group's last. */
function joined(p: PaneNode, note: string, group: string | null, was?: string | null): PaneNode {
  const g = group ? p.groups?.find((x) => x.id === group) : undefined;
  const groups = (p.groups ?? []).map((x) => ({ ...x, tabs: x === g ? [...x.tabs.filter((t) => t !== note), note] : x.tabs.filter((t) => t !== note) }));
  if (!g) return tidyPane({ ...p, groups });
  const at = p.tabs.indexOf(note);
  const where = g.tabs.filter((t) => t !== note).map((t) => p.tabs.indexOf(t));
  const among = where.length > 0 && at > Math.min(...where) - 2 && at < Math.max(...where);
  let tabs = p.tabs;
  if (!among && where.length) {
    const rest = p.tabs.filter((t) => t !== note);
    const last = rest.indexOf(p.tabs[Math.max(...where)]);
    tabs = [...rest.slice(0, last + 1), note, ...rest.slice(last + 1)];
  }
  // Into a folded group: it folds away with the rest, and the front goes to a tab still in view.
  let active = p.active;
  if (g.collapsed && active === note) {
    const open = (t: string) => t !== note && !g.tabs.includes(t) && !groupOf(p, t)?.collapsed;
    active = (was && was !== note && open(was) ? was : undefined) ?? tabs.slice(tabs.indexOf(note) + 1).find(open) ?? tabs.slice(0, tabs.indexOf(note)).reverse().find(open) ?? note;
  }
  return tidyPane({ ...p, tabs, active, pinned: (p.pinned ?? []).filter((t) => t !== note), groups });
}

function moveTabRaw(l: Layout, from: string, note: string, to: TabDrop): Layout | null {
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

/** A page that isn't open yet, dropped into a pane: among its tabs (before one, or at the end) or at an edge as a new pane.
 *  A page already open somewhere moves from there instead. Null means nothing changes. */
export function dropPage(l: Layout, note: string, to: TabDrop): Layout | null {
  const owner = panes(l.root).find((p) => p.tabs.includes(note));
  if (owner) return moveTab(l, owner.id, note, to);
  if (!findPane(l.root, to.pane)) return null;
  if ("side" in to) return openSplit(l, to.pane, note, to.side);
  const root = mapPane(l.root, to.pane, (p) => {
    const tabs = [...p.tabs];
    const at = to.before ? tabs.indexOf(to.before) : -1;
    tabs.splice(at < 0 ? tabs.length : at, 0, note);
    return joined({ ...p, tabs, active: note }, note, joinOf(p, note, to));
  });
  return tidy({ root, focus: to.pane });
}

// ---------------------------------------------------------------- pins and groups

/** Pins a tab (small, never replaced by a click on a page) or lets it go. A pinned tab leaves its group. */
export function pinTab(l: Layout, pane: string, tab: string, on: boolean): Layout {
  const p = findPane(l.root, pane);
  if (!p || !p.tabs.includes(tab) || isPinned(p, tab) === on) return l;
  return tidy({
    ...l,
    root: mapPane(l.root, pane, (q) => {
      // Pinned, it goes to the front of the strip, after the pins already there; from then on it can be dragged
      // anywhere. Unpinned, it stays where it is.
      const pinned = on ? [...(q.pinned ?? []), tab] : (q.pinned ?? []).filter((t) => t !== tab);
      const rest = q.tabs.filter((t) => t !== tab);
      let at = 0;
      while (at < rest.length && (q.pinned ?? []).includes(rest[at])) at++;
      const tabs = on ? [...rest.slice(0, at), tab, ...rest.slice(at)] : q.tabs;
      const groups = on ? q.groups?.map((g) => ({ ...g, tabs: g.tabs.filter((t) => t !== tab) })) : q.groups;
      return { ...q, tabs, pinned, ...(groups ? { groups } : {}) };
    }),
  });
}

/** A pinned tab's own icon, written as a page's icon is ("emoji:🧪", "art:…", "media:…"); null goes back to the page's. */
export function setTabIcon(l: Layout, pane: string, tab: string, icon: string | null): Layout {
  const p = findPane(l.root, pane);
  if (!p || !isPinned(p, tab)) return l;
  return tidy({
    ...l,
    root: mapPane(l.root, pane, (q) => {
      const icons = { ...(q.icons ?? {}) };
      if (icon) icons[tab] = icon;
      else delete icons[tab];
      return { ...q, icons };
    }),
  });
}

/** The first colour no group in the pane uses yet, so a new group stands apart. */
export function freeGroupColor(p: PaneNode | undefined): GroupColor {
  const used = new Set<string>((p?.groups ?? []).map((g) => g.color));
  return GROUP_COLORS.slice(1).find((c) => !used.has(c)) ?? GROUP_COLORS[(p?.groups?.length ?? 0) % GROUP_COLORS.length];
}

/** Puts tabs in a group of the pane: an existing one (by id), or a new one made with that id. Pinned tabs come unpinned. */
export function groupTabs(l: Layout, pane: string, tabs: string[], group: string, init: { name?: string; color?: GroupColor } = {}): Layout {
  const p = findPane(l.root, pane);
  const add = tabs.filter((t) => p?.tabs.includes(t));
  if (!p || !add.length) return l;
  return tidy({
    ...l,
    root: mapPane(l.root, pane, (q) => {
      const others = (q.groups ?? []).map((g) => (g.id === group ? g : { ...g, tabs: g.tabs.filter((t) => !add.includes(t)) }));
      const groups = others.some((g) => g.id === group)
        ? others.map((g) => (g.id === group ? { ...g, tabs: [...g.tabs.filter((t) => !add.includes(t)), ...add] } : g))
        : [...others, { id: group, name: init.name ?? "", color: init.color ?? freeGroupColor(q), tabs: add }];
      // Joining a group that exists, they go after its last tab.
      const last = (q.groups ?? []).find((g) => g.id === group)?.tabs.filter((t) => !add.includes(t)).at(-1);
      const rest = q.tabs.filter((t) => !add.includes(t));
      const tabs = last ? [...rest.slice(0, rest.indexOf(last) + 1), ...add, ...rest.slice(rest.indexOf(last) + 1)] : q.tabs;
      return { ...q, tabs, pinned: (q.pinned ?? []).filter((t) => !add.includes(t)), groups };
    }),
  });
}

/** Takes a tab out of its group; it stays open, right after the group. */
/** Moves a tab to the end of its pane's strip (the + puts a New tab there). */
export function tabToEnd(l: Layout, pane: string, tab: string): Layout {
  const p = findPane(l.root, pane);
  if (!p || !p.tabs.includes(tab) || p.tabs.at(-1) === tab) return l;
  return tidy({ ...l, root: mapPane(l.root, pane, (q) => ({ ...q, tabs: [...q.tabs.filter((t) => t !== tab), tab] })) });
}

export function ungroupTab(l: Layout, pane: string, tab: string): Layout {
  const p = findPane(l.root, pane);
  const g = groupOf(p, tab);
  if (!p || !g) return l;
  return tidy({
    ...l,
    root: mapPane(l.root, pane, (q) => {
      const last = g.tabs.filter((t) => t !== tab).at(-1);
      const rest = q.tabs.filter((t) => t !== tab);
      const at = last ? rest.indexOf(last) + 1 : q.tabs.indexOf(tab);
      return { ...q, tabs: [...rest.slice(0, at), tab, ...rest.slice(at)], groups: q.groups!.map((x) => (x.id === g.id ? { ...x, tabs: x.tabs.filter((t) => t !== tab) } : x)) };
    }),
  });
}

/** Renames, recolours, folds or unfolds a group. Folding the group the front tab is in moves the front to a tab
 *  outside it; when it holds every tab in view, it stays unfolded. */
export function editGroup(l: Layout, pane: string, group: string, patch: { name?: string; color?: GroupColor; collapsed?: boolean }): Layout {
  const p = findPane(l.root, pane);
  const g = p?.groups?.find((x) => x.id === group);
  if (!p || !g) return l;
  let active = p.active;
  let collapsed = patch.collapsed ?? !!g.collapsed;
  if (collapsed && active && g.tabs.includes(active)) {
    const at = p.tabs.indexOf(active);
    const open = (t: string) => !g.tabs.includes(t) && !groupOf(p, t)?.collapsed;
    const next = p.tabs.slice(at + 1).find(open) ?? p.tabs.slice(0, at).reverse().find(open);
    if (next) active = next;
    else collapsed = false;
  }
  const { collapsed: _c, ...bare } = g;
  const next: TabGroup = { ...bare, name: patch.name ?? g.name, color: patch.color && isGroupColor(patch.color) ? patch.color : g.color, ...(collapsed ? { collapsed: true } : {}) };
  return tidy({ ...l, root: mapPane(l.root, pane, (q) => ({ ...q, active, groups: q.groups!.map((x) => (x.id === group ? next : x)) })) });
}

/**
 * Moves a whole group, with its name, colour and tabs: along its pane's strip, or to another pane. `before` is the
 * tab it lands in front of (null: the end); when that tab is inside another group, it lands beside that group, on
 * the nearer side. Null means nothing changes.
 */
export function moveGroup(l: Layout, from: string, group: string, to: { pane: string; before: string | null }): Layout | null {
  const src = findPane(l.root, from);
  const dst = findPane(l.root, to.pane);
  const g = src?.groups?.find((x) => x.id === group);
  if (!src || !dst || !g) return null;
  const mine = new Set(g.tabs);
  const base = from === to.pane ? src.tabs.filter((t) => !mine.has(t)) : dst.tabs;
  let anchor = to.before && !mine.has(to.before) && base.includes(to.before) ? to.before : null;
  const other = anchor ? groupOf(dst, anchor) : undefined;
  if (other && other.id !== group && other.tabs[0] !== anchor) {
    // Inside another group: before it from its first half, after it from its second.
    const after = other.tabs.indexOf(anchor!) > (other.tabs.length - 1) / 2;
    anchor = after ? (base[base.indexOf(other.tabs.at(-1)!) + 1] ?? null) : other.tabs[0];
  }
  const at = anchor ? base.indexOf(anchor) : base.length;
  const tabs = [...base.slice(0, at), ...g.tabs, ...base.slice(at)];
  if (from === to.pane) {
    const next = tidy({ ...l, root: mapPane(l.root, from, (p) => ({ ...p, tabs })) });
    return same(findPane(next.root, from)!, src) ? null : next;
  }
  const left = src.tabs.filter((t) => !mine.has(t));
  const open = (t: string) => !groupOf(src, t)?.collapsed;
  const active = src.active && mine.has(src.active) ? (left.find(open) ?? left[0] ?? null) : src.active;
  let root = mapPane(l.root, to.pane, (p) => ({ ...p, tabs, groups: [...(p.groups ?? []), g], active: g.collapsed ? p.active : (p.active ?? g.tabs[0]) }));
  root = left.length ? mapPane(root, from, (p) => ({ ...p, tabs: left, active, groups: p.groups!.filter((x) => x.id !== group) })) : removePane(root, from)!;
  return tidy({ root, focus: to.pane });
}

/** Dissolves a group: its tabs stay open where they are. */
export function ungroup(l: Layout, pane: string, group: string): Layout {
  const p = findPane(l.root, pane);
  if (!p?.groups?.some((g) => g.id === group)) return l;
  return tidy({ ...l, root: mapPane(l.root, pane, (q) => ({ ...q, groups: q.groups!.filter((g) => g.id !== group) })) });
}

/** Pages that were archived or deleted leave their tabs; panes left empty close. */
export function prune(l: Layout, exists: (id: string) => boolean): Layout {
  let root = l.root;
  for (const p of panes(l.root)) {
    if (p.tabs.every(exists) && (p.active === null || exists(p.active))) continue;
    const tabs = p.tabs.filter(exists);
    const at = p.active ? p.tabs.indexOf(p.active) : -1;
    const active = p.active && exists(p.active) ? p.active : (tabs[Math.min(Math.max(at, 0), tabs.length - 1)] ?? null);
    root = mapPane(root, p.id, () => tidyPane({ ...p, tabs, active }));
  }
  for (const p of panes(root)) if (!p.tabs.length && count(root) > 1) root = removePane(root, p.id)!;
  const f = findPane(root, l.focus) ? l.focus : panes(root)[0].id;
  return root === l.root && f === l.focus ? l : { root, focus: f };
}

/**
 * A tab whose page got a new id (a file on disk renamed or moved): every place the layout names it follows, and so
 * do the tabs for what's inside it when it's a folder ("old/…" → "new/…"). Its pin, group and icon stay.
 */
export function renameTab(l: Layout, from: string, to: string): Layout {
  const map = (t: string) => (t === from ? to : t.startsWith(from + "/") ? to + t.slice(from.length) : t);
  let root = l.root;
  for (const p of panes(l.root)) {
    if (!p.tabs.some((t) => map(t) !== t)) continue;
    // A tab already open at the new place stays the one tab.
    const tabs = [...new Set(p.tabs.map(map))];
    root = mapPane(root, p.id, () =>
      tidyPane({
        ...p,
        tabs,
        active: p.active === null ? null : map(p.active),
        ...(p.pinned ? { pinned: [...new Set(p.pinned.map(map))] } : {}),
        ...(p.groups ? { groups: p.groups.map((g) => ({ ...g, tabs: [...new Set(g.tabs.map(map))] })) } : {}),
        ...(p.icons ? { icons: Object.fromEntries(Object.entries(p.icons).map(([k, v]) => [map(k), v])) } : {}),
      }),
    );
  }
  return root === l.root ? l : { root, focus: l.focus };
}

/** A pane's zoom steps, the ones a browser uses. */
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const clampZoom = (z: number) => Math.min(3, Math.max(0.5, Math.round(z * 100) / 100));
/** The next step in (1), out (-1), back to 100% (0), or a size of its own. */
export function nextZoom(z: number, by: 1 | -1 | 0 | { to: number }): number {
  if (typeof by === "object") return clampZoom(by.to);
  if (by === 0) return 1;
  return by > 0 ? (ZOOM_STEPS.find((s) => s > z + 0.001) ?? 3) : ([...ZOOM_STEPS].reverse().find((s) => s < z - 0.001) ?? 0.5);
}
export const paneZoom = (p: PaneNode | undefined) => p?.zoom ?? 1;
export function setPaneZoom(l: Layout, pane: string, zoom: number): Layout {
  const z = clampZoom(zoom);
  return {
    ...l,
    root: mapPane(l.root, pane, (p) => {
      const { zoom: _z, ...rest } = p;
      return z === 1 ? rest : { ...rest, zoom: z };
    }),
  };
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
      const strs = (x: unknown): string[] => (Array.isArray(x) ? x.filter((t): t is string => typeof t === "string") : []);
      const groups: TabGroup[] = (Array.isArray(v.groups) ? v.groups : [])
        .filter((g: any) => g && typeof g === "object" && typeof g.id === "string")
        .map((g: any) => ({ id: g.id, name: typeof g.name === "string" ? g.name.slice(0, 60) : "", color: isGroupColor(g.color) ? g.color : "gray", tabs: strs(g.tabs), ...(g.collapsed === true ? { collapsed: true } : {}) }));
      const icons = v.icons && typeof v.icons === "object" && !Array.isArray(v.icons) ? Object.fromEntries(Object.entries(v.icons).filter(([, x]) => typeof x === "string" && (x as string).length < 400)) : {};
      const zoom = typeof v.zoom === "number" && Number.isFinite(v.zoom) && v.zoom !== 1 ? clampZoom(v.zoom) : undefined;
      return tidyPane({ k: "pane", id: v.id, tabs, active, pinned: strs(v.pinned), groups, icons: icons as Record<string, string>, ...(zoom ? { zoom } : {}) });
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
