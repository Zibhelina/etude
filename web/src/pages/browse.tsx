// Browse (Etude 3): every card in a sortable table; the picked card opens in a drawer on the right.
// Phones show a list, then the card as its own page. An empty library is one page without the table.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronDown, FolderInput, MoreHorizontal, Pause, Play, Plus, RotateCcw, Search, Tag, Trash2, Upload, X, Archive, ArchiveRestore } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { groupItems, ItemEditor, MoveDialog, NewItemDialog, ORDERS, TagDialog, type ItemRowData } from "@/components/item-editor";
import { daysWords } from "@/components/item-memory";
import { useImportPicker } from "@/pages/decks";
import { api, relative, type DeckNode, type SearchRow, type TypeSummary } from "@/lib/api";
import { DeckIcon } from "@/components/deck-icon";
import { appPath, withBase } from "@/lib/router";
import { useLongPress, usePhone } from "@/lib/phone";
import { cn } from "@/lib/utils";
import { track } from "@/lib/telemetry";

const PAGE = 200;
/** iPad widths, landscape included: the list narrows to 304px so the inspector keeps its room. */
const TABLET = "(min-width: 768px) and (max-width: 1199px)";
const DAY = 86_400_000;

/** Plain-word filters; each adds one term of the search language. */
const CHIPS = [
  ["due", "Due", "is:due"],
  ["new", "New", "is:new"],
  ["learning", "Learning", "is:learning"],
  ["missed", "Often missed", "prop:lapses>=2"],
  ["today", "Missed today", "rated:1:1"],
  ["suspended", "Suspended", "is:suspended"],
] as const;

/** Table columns: [key, header, engine sort order, numbers (right-aligned)]. */
const COLS = [
  ["card", "Card", "title", false],
  ["deck", "Deck", "deck", false],
  ["type", "Type", "type", false],
  ["next", "Next", "due", false],
  ["every", "Every", "interval", true],
  ["recall", "Recall", "recall", true],
  ["missed", "Missed", "lapses", true],
  ["edited", "Edited", "updated", true],
] as const;
type ColKey = (typeof COLS)[number][0];
/** Columns iPad drops so the card text keeps its room. */
const TABLET_HIDDEN = new Set<ColKey>(["deck", "edited"]);

const quote = (s: string) => (/[\s()"]/.test(s) ? `"${s.replace(/"/g, "")}"` : s);

/** The words a search looks for in card text (not field:value terms), for highlighting. */
function searchWords(q: string): string[] {
  const out: string[] = [];
  q.replace(/(-?\S+?:"[^"]*"|-?"[^"]*"|\S+)/g, (m) => (out.push(m), m));
  return out
    .filter((t) => !t.startsWith("-") && t !== "OR" && t !== "or" && !/^[a-z]+:/i.test(t))
    .map((t) => t.replace(/^\(+|\)+$/g, "").replace(/^"|"$/g, "").replace(/\*/g, ""))
    .filter((t) => t.length > 1);
}

function Highlight({ text, words }: { text: string; words: string[] }) {
  if (!words.length) return <>{text}</>;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "ig");
  return <>{text.split(re).map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : <Fragment key={i}>{p}</Fragment>))}</>;
}

/** When the card comes up next, as a dot and a few words. */
function State({ r }: { r: SearchRow }) {
  const dot = "size-[7px] shrink-0 rounded-full";
  if (r.suspended) return <span className="flex items-center gap-[5px] text-[12.5px] font-semibold text-muted-foreground/70"><i className={cn(dot, "shadow-[inset_0_0_0_1.7px_currentColor]")} />Suspended</span>;
  if (r.state === 0) return <span className="flex items-center gap-[5px] text-[12.5px] font-semibold text-new"><i className={cn(dot, "shadow-[inset_0_0_0_1.7px_currentColor]")} />New</span>;
  if (r.state === 1 || r.state === 3) return <span className="flex items-center gap-[5px] text-[12.5px] font-semibold text-learn"><i className={cn(dot, "bg-[linear-gradient(90deg,currentColor_50%,transparent_50%)] shadow-[inset_0_0_0_1.7px_currentColor]")} />Learning</span>;
  const left = (new Date(r.due).getTime() - Date.now()) / DAY;
  if (left <= 0) {
    const late = Math.floor(-left);
    return late >= 1
      ? <span className="flex items-center gap-[5px] text-[12.5px] font-semibold text-hard tabular"><i className={cn(dot, "bg-current")} />{daysWords(late)} late</span>
      : <span className="flex items-center gap-[5px] text-[12.5px] font-semibold text-good"><i className={cn(dot, "bg-current")} />Due</span>;
  }
  return <span className="flex items-center gap-[5px] text-[12.5px] font-medium text-muted-foreground tabular"><i className={cn(dot, "bg-ring")} />in {daysWords(left)}</span>;
}

function Box({ on, onClick, label, className }: { on: boolean; onClick(e: React.MouseEvent): void; label: string; className?: string }) {
  return (
    <button
      role="checkbox"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      className={cn("relative grid size-[18px] shrink-0 place-items-center rounded-[5px] text-background shadow-[inset_0_0_0_1.6px_color-mix(in_oklab,var(--muted-foreground)_55%,transparent)] after:absolute after:-inset-2.5 after:content-['']", on && "bg-foreground shadow-none", className)}
    >
      {on && <Check className="size-3" strokeWidth={3} />}
    </button>
  );
}

function Row({ r, typeName, words, active, checked, selecting, dirty, phone, tablet, onOpen, onToggle }: { r: ItemRowData; typeName: string; words: string[]; active: boolean; checked: boolean; selecting: boolean; dirty: boolean; phone: boolean; tablet: boolean; onOpen(): void; onToggle(): void }) {
  const { handlers, held } = useLongPress(onToggle);
  const parts = r.deck.split("::");
  return (
    <div
      data-item-row
      data-id={r.itemId}
      aria-current={active || undefined}
      onClick={(e) => {
        if (held()) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey || (phone && selecting)) return onToggle();
        onOpen();
      }}
      {...(phone ? handlers : {})}
      className={cn(
        "browse-row group relative flex cursor-pointer items-start gap-3 rounded-xl py-3 pr-3.5 pl-3 select-none",
        phone ? "rounded-none px-1 py-3.5 [-webkit-touch-callout:none] active:bg-secondary [&+&]:before:absolute [&+&]:before:inset-x-1 [&+&]:before:top-0 [&+&]:before:h-px [&+&]:before:bg-border" : "hover:bg-secondary",
        active && !phone && "bg-accent hover:bg-accent",
      )}
    >
      {selecting && <Box on={checked} className="mt-0.5" label="Select" onClick={(e) => { e.stopPropagation(); onToggle(); }} />}
      <div className={cn("min-w-0 flex-1", r.suspended && "opacity-50")}>
        <div className="line-clamp-2 text-[15px] leading-[1.35] font-[550] [overflow-wrap:anywhere]">
          {r.title ? <Highlight text={r.title} words={words} /> : <span className="text-muted-foreground">{r.itemId}</span>}
          {dirty && <i className="ml-1.5 inline-block size-1.5 rounded-full bg-hard align-middle" title="Unsaved changes" />}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground">
          <span className={cn("min-w-0 truncate", r.tags.length > 0 && !tablet && "max-w-[55%]")}>{parts[parts.length - 1]}</span>
          <span className="shrink-0 text-muted-foreground/50">·</span>
          <span className="shrink-0">{typeName}</span>
          {r.faces > 1 && <><span className="shrink-0 text-muted-foreground/50">·</span><span className="shrink-0 tabular">{r.faces} cards</span></>}
          {r.tags.length > 0 && !tablet && <span className="min-w-0 flex-1 truncate"><span className="mr-1.5 text-muted-foreground/50">·</span>{r.tags.join(", ")}</span>}
        </div>
      </div>
      <div className={cn("flex min-w-[62px] shrink-0 flex-col items-end gap-1 pt-px", r.suspended && "opacity-70")}>
        <State r={r} />
        {r.lapses >= 2 && <span className="text-xs font-medium whitespace-nowrap text-muted-foreground">missed {r.lapses}×</span>}
      </div>
    </div>
  );
}

function TableRow({ r, typeName, icon, words, active, checked, selecting, dirty, cols, onOpen, onToggle }: { r: ItemRowData; typeName: string; icon: string | null; words: string[]; active: boolean; checked: boolean; selecting: boolean; dirty: boolean; cols: Set<ColKey>; onOpen(): void; onToggle(): void }) {
  const parts = r.deck.split("::");
  const R = r.retrievability;
  const td = "h-[46px] px-2.5 shadow-[inset_0_-1px_0_var(--border)] whitespace-nowrap overflow-hidden text-ellipsis max-w-0";
  const none = <span className="text-muted-foreground/50">–</span>;
  return (
    <tr
      data-item-row
      data-id={r.itemId}
      aria-current={active || undefined}
      aria-selected={active}
      onClick={(e) => (e.metaKey || e.ctrlKey || e.shiftKey ? onToggle() : onOpen())}
      className={cn("browse-tr group cursor-pointer select-none", active && "on", r.suspended && "text-muted-foreground/70")}
    >
      <td className={cn(td, "w-[38px] pr-0 pl-1.5")}>
        <Box on={checked} label="Select" className={cn("transition-opacity", !(selecting || checked) && "opacity-40 group-hover:opacity-100")} onClick={(e) => { e.stopPropagation(); onToggle(); }} />
      </td>
      <td className={cn(td, "text-[14.5px] font-[550]", !r.suspended && "text-foreground")} title={r.title || r.itemId}>
        {r.title ? <Highlight text={r.title} words={words} /> : <span className="text-muted-foreground">{r.itemId}</span>}
        {dirty && <i className="ml-1.5 inline-block size-1.5 rounded-full bg-hard align-middle" title="Unsaved changes" />}
      </td>
      {cols.has("deck") && (
        <td className={cn(td, "text-[13.5px] text-muted-foreground")} title={parts.join(" › ")}>
          <span className="flex min-w-0 items-center gap-1.5">{icon && <DeckIcon icon={icon} size={18} className="shrink-0" />}<span className="truncate">{parts[parts.length - 1]}</span></span>
        </td>
      )}
      <td className={cn(td, "text-[13.5px] text-muted-foreground")} title={typeName}>{typeName}{r.faces > 1 && <span className="text-muted-foreground/60"> · {r.faces}</span>}</td>
      <td className={td}><State r={r} /></td>
      <td className={cn(td, "text-right text-[13.5px] text-muted-foreground tabular")}>{r.interval != null && r.interval > 0 ? daysWords(r.interval) : none}</td>
      <td className={cn(td, "text-right text-[13.5px] tabular")}>{R != null && r.state !== 0 ? <span className={cn("font-semibold", R < 0.85 ? "text-hard" : "text-foreground")}>{Math.round(R * 100)}%</span> : none}</td>
      <td className={cn(td, "text-right text-[13.5px] tabular", r.lapses >= 2 ? "font-semibold text-learn" : r.lapses ? "text-foreground" : "text-muted-foreground/50")}>{r.lapses}</td>
      {cols.has("edited") && <td className={cn(td, "text-right text-[13px] text-muted-foreground tabular")} title={new Date(r.updated).toLocaleString()}>{r.updated ? relative(r.updated) : ""}</td>}
    </tr>
  );
}

function Blank({ plus, className }: { plus?: boolean; className?: string }) {
  // Three stacked blank cards: the empty-state drawing.
  return (
    <div className={cn("relative h-[126px] w-[180px]", className)} aria-hidden>
      <i className="absolute inset-x-5 top-0 h-[70%] rotate-[-6deg] rounded-xl bg-secondary shadow-[0_0_0_1px_var(--border)]" />
      <i className="absolute inset-x-3 top-2 h-[74%] rotate-[4deg] rounded-xl bg-secondary shadow-[0_0_0_1px_var(--border)]" />
      <i className="browse-paper absolute inset-x-0 top-5 grid h-[78%] place-items-center text-muted-foreground/60">{plus && <Plus className="size-7" />}</i>
    </div>
  );
}

export function BrowsePage({ initialQuery, openItem }: { initialQuery: string; openItem: string | null }) {
  // Usage count (only when the person turned usage stats on).
  useEffect(() => track("browse.open"), []);
  const phone = usePhone();
  const [tablet, setTablet] = useState(() => matchMedia(TABLET).matches);
  useEffect(() => {
    const m = matchMedia(TABLET);
    const h = () => setTablet(m.matches);
    m.addEventListener("change", h);
    return () => m.removeEventListener("change", h);
  }, []);

  const [query, setQuery] = useState(initialQuery);
  const [chips, setChips] = useState<Set<string>>(new Set());
  const [deckF, setDeckF] = useState("");
  const [typeF, setTypeF] = useState("");
  const [order, setOrder] = useState("relevance");
  const [reverse, setReverse] = useState(false);
  const [rows, setRows] = useState<SearchRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(openItem);
  const [dirtyId, setDirtyId] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [decks, setDecks] = useState<DeckNode[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [types, setTypes] = useState<TypeSummary[]>([]);
  const [library, setLibrary] = useState<number | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | "delete" | "reset">(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // The card drawer's width: dragged by its left edge, remembered per device size, double-click resets.
  const drawerRef = useRef<HTMLElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const wKey = () => `etude.browse.drawer.${tablet ? "tablet" : "desktop"}`;
  const [pageW, setPageW] = useState(0);
  const [savedW, setSavedW] = useState<number | null>(() => Number(localStorage.getItem(`etude.browse.drawer.${matchMedia(TABLET).matches ? "tablet" : "desktop"}`)) || null);
  useEffect(() => setSavedW(Number(localStorage.getItem(wKey())) || null), [tablet]);
  useEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPageW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  });
  const minW = 420, maxW = Math.max(minW, pageW - (tablet ? 220 : 320));
  const defW = Math.round(pageW * (tablet ? 0.66 : 0.6));
  const drawerW = Math.min(maxW, Math.max(minW, savedW ?? defW));
  const setDrawerW = (w: number | null) => {
    setSavedW(w == null ? null : Math.min(maxW, Math.max(minW, w)));
    try { w == null ? localStorage.removeItem(wKey()) : localStorage.setItem(wKey(), String(Math.round(Math.min(maxW, Math.max(minW, w))))); } catch {}
  };
  const startResize = (e: React.PointerEvent) => {
    if (e.button > 0) return;
    e.preventDefault();
    const right = pageRef.current!.getBoundingClientRect().right;
    let w = drawerW;
    document.body.classList.add("browse-resizing");
    const move = (ev: PointerEvent) => { w = Math.min(maxW, Math.max(minW, right - ev.clientX)); setSavedW(w); };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      document.body.classList.remove("browse-resizing");
      setDrawerW(w);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  };

  const fullQuery = useMemo(() => {
    const extra = [...CHIPS.filter(([k]) => chips.has(k)).map(([, , q]) => q), deckF && `deck:${quote(deckF)}`, typeF && `type:${quote(typeF)}`].filter(Boolean);
    if (!extra.length) return query;
    return [query.trim() ? `(${query.trim()})` : "", ...extra].filter(Boolean).join(" ");
  }, [query, chips, deckF, typeF]);
  const filtered = chips.size > 0 || !!deckF || !!typeF;

  const run = useCallback(async (q = fullQuery, limit = PAGE) => {
    try {
      const r = await api.search(q, { limit, order, reverse });
      setRows(r.rows);
      setTotal(r.total);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, [fullQuery, order, reverse]);
  const refresh = () => run(fullQuery, Math.max(PAGE, rows.length));

  useEffect(() => {
    const t = setTimeout(() => run(fullQuery), 180);
    return () => clearTimeout(t);
  }, [fullQuery, order, reverse]);

  useEffect(() => {
    const p = new URLSearchParams();
    if (query) p.set("q", query);
    if (selected) p.set("item", selected);
    const url = `/browse${p.toString() ? `?${p}` : ""}`;
    if (appPath() + location.search !== url) history.replaceState(null, "", withBase(url));
  }, [query, selected]);

  const reloadMeta = () => {
    api.decks().then(setDecks);
    api.tags().then((t) => setTags(t.map((x) => x.tag)));
    api.types().then(setTypes);
    api.search("", { limit: 1 }).then((r) => setLibrary(r.total)).catch(() => {});
  };
  useEffect(reloadMeta, []);
  const changed = () => { refresh(); reloadMeta(); };
  const importFile = useImportPicker(changed);

  const items = useMemo(() => groupItems(rows), [rows]);
  const words = useMemo(() => searchWords(query), [query]);
  const typeName = useMemo(() => new Map(types.map((t) => [t.id, t.name])), [types]);
  const deckNames = useMemo(() => decks.map((d) => d.name), [decks]);
  const topDecks = useMemo(() => new Set(decks.map((d) => d.name.split("::")[0])).size, [decks]);

  // The row the arrow keys are on. The drawer opens with Enter or a click and then follows it.
  const [cursor, setCursor] = useState<string | null>(openItem);

  const toggle = (id: string) => {
    setSelecting(true);
    setChecked((c) => {
      const n = new Set(c);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };
  const endSelect = () => { setSelecting(false); setChecked(new Set()); };
  const allChecked = items.length > 0 && items.every((r) => checked.has(r.itemId));

  const step = (k: number) => {
    if (!items.length) return;
    let i = items.findIndex((r) => r.itemId === (selected ?? cursor));
    i = i < 0 ? 0 : Math.max(0, Math.min(items.length - 1, i + k));
    const id = items[i].itemId;
    setCursor(id);
    if (selected) setSelected(id);
    requestAnimationFrame(() => listRef.current?.querySelector(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" }));
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t?.closest("input, textarea, select, [contenteditable=true], .cm-editor");
      const overlay = !!document.querySelector("[role=dialog], [role=menu], [role=alertdialog]");
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (e.key === "Escape" && !overlay) {
        if (typing && t === searchRef.current) return void searchRef.current?.blur();
        if (selecting) return endSelect();
        if (selected) return setSelected(null);
        return;
      }
      if (typing || overlay || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "/") { e.preventDefault(); searchRef.current?.focus(); return; }
      if (phone) return;
      if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); step(1); return; }
      if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); step(-1); return; }
      if (e.key === "Enter" && !selected && cursor && !(t && t.closest("button, a"))) { e.preventDefault(); setSelected(cursor); return; }
      if (e.key === "x" && (selected ?? cursor)) { toggle((selected ?? cursor)!); return; }
      if (e.key === "n") { e.preventDefault(); setCreating(true); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [items, selected, cursor, selecting, phone]);

  // ---------------------------------------------------------------- bulk actions, with Undo where it can be undone
  const ids = [...checked];
  const pickedRows = rows.filter((r) => checked.has(r.itemId));
  const after = (msg: string, undo?: () => Promise<unknown>) => {
    endSelect();
    changed();
    toast.success(msg, undo ? { action: { label: "Undo", onClick: async () => { try { await undo(); changed(); toast("Undone"); } catch (e) { toast.error((e as Error).message); } } } } : undefined);
  };
  const fail = (e: unknown) => toast.error((e as Error).message);
  const plural = (n: number, w = "card") => `${n} ${w}${n === 1 ? "" : "s"}`;
  const bulkMove = async (deck: string) => {
    const was = new Map<string, string[]>();
    for (const r of items) if (checked.has(r.itemId)) was.set(r.deck, [...(was.get(r.deck) ?? []), r.itemId]);
    try {
      await api.bulkItems("move", ids, { deck });
      after(`Moved ${plural(ids.length)} to ${deck.split("::").pop()}`, async () => { for (const [d, list] of was) await api.bulkItems("move", list, { deck: d }); });
    } catch (e) { fail(e); }
  };
  const bulkTag = async (add: string[], remove: string[]) => {
    const had = (t: string) => items.filter((r) => checked.has(r.itemId) && r.tags.includes(t)).map((r) => r.itemId);
    const undoRemove = add.map((t) => [t, ids.filter((id) => !had(t).includes(id))] as const);
    const undoAdd = remove.map((t) => [t, had(t)] as const);
    try {
      await api.bulkItems("tag", ids, { add, remove });
      after(`Tags changed on ${plural(ids.length)}`, async () => {
        for (const [t, list] of undoRemove) if (list.length) await api.bulkItems("tag", list, { add: [], remove: [t] });
        for (const [t, list] of undoAdd) if (list.length) await api.bulkItems("tag", list, { add: [t], remove: [] });
      });
    } catch (e) { fail(e); }
  };
  const bulkSuspend = async (on: boolean) => {
    const cards = pickedRows.filter((r) => r.suspended !== on).map((r) => r.cardId);
    try {
      await api.bulkCards(on ? "suspend" : "unsuspend", cards);
      after(`${on ? "Suspended" : "Unsuspended"} ${plural(ids.length)}`, () => api.bulkCards(on ? "unsuspend" : "suspend", cards));
    } catch (e) { fail(e); }
  };
  const bulkArchive = async (on: boolean) => {
    const list = items.filter((r) => checked.has(r.itemId) && r.archived !== on).map((r) => r.itemId);
    try {
      await api.bulkItems(on ? "archive" : "unarchive", list);
      after(`${on ? "Archived" : "Unarchived"} ${plural(ids.length)}`, () => api.bulkItems(on ? "unarchive" : "archive", list));
    } catch (e) { fail(e); }
  };
  const bulkReset = async () => {
    try {
      await api.bulkCards("reset", pickedRows.map((r) => r.cardId));
      after(`${plural(ids.length)} start over as new`);
    } catch (e) { fail(e); }
  };
  const bulkDelete = async () => {
    try {
      await api.bulkItems("delete", ids);
      if (selected && ids.includes(selected)) setSelected(null);
      after(`Deleted ${plural(ids.length)}`);
    } catch (e) { fail(e); }
  };

  // ---------------------------------------------------------------- pieces
  const header = (
    <header className="mb-4 flex items-end gap-2.5">
      <div className="min-w-0">
        <div className="score-kicker whitespace-nowrap text-muted-foreground">{library ? `Every card · ${topDecks} deck${topDecks === 1 ? "" : "s"}` : "Every card"}</div>
        <h1 className="browse-serif mt-1.5 text-[32px] leading-[1.1] max-md:text-[30px]">Browse</h1>
      </div>
      <div className="flex-1" />
      {(phone || tablet
        ? <Button variant="outline" size="icon" className="size-10 rounded-[10px] bg-card shadow-xs max-md:border-0 max-md:bg-transparent max-md:shadow-none max-md:dark:bg-transparent" onClick={() => setCreating(true)} aria-label="New card" title="New card · N"><Plus className="size-[22px]" /></Button>
        : <Button variant="outline" className="h-10 gap-2 rounded-[10px] bg-card px-3.5 font-semibold" onClick={() => setCreating(true)} title="New card · N"><Plus className="size-[17px]" />New card</Button>)}
    </header>
  );
  const syntax = /(^|\s|\()-?[a-z]+:/i.test(query);
  const search = (
    <label className={cn("browse-search flex h-[46px] items-center gap-2 rounded-xl bg-card pr-1.5 pl-3.5 text-muted-foreground dark:bg-[color-mix(in_oklab,var(--card)_80%,var(--background))]")}>
      <Search className="size-[18px] shrink-0" />
      <input
        ref={searchRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={tablet ? "Search, or is:due tag:…" : phone ? "Search cards, or try is:due tag:capitals" : "Search, or try is:due tag:capitals"}
        aria-label="Search cards"
        autoComplete="off"
        spellCheck={false}
        className={cn("min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground/70", syntax && "font-mono text-[13.5px]")}
      />
      {query
        ? <button className="grid size-[30px] place-items-center rounded-lg hover:bg-accent hover:text-foreground" onClick={() => { setQuery(""); searchRef.current?.focus(); }} aria-label="Clear search"><X className="size-[15px]" /></button>
        : !phone && <kbd className="mr-1.5 rounded-[5px] px-1.5 py-0.5 font-sans text-[11px] font-medium text-muted-foreground/70 shadow-[inset_0_0_0_1px_var(--border)]">/</kbd>}
    </label>
  );
  const chip = "browse-chip inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13.5px] font-semibold whitespace-nowrap text-muted-foreground hover:text-foreground max-md:h-9 max-md:text-sm";
  const chipOn = "bg-foreground text-background shadow-none hover:text-background";
  const chipRow = (wrap: boolean) => (
    <div className={cn("mt-3 flex gap-1.5", wrap ? "flex-wrap" : cn("browse-chips overflow-x-auto pr-[30px]", phone ? "-mx-5 px-5" : tablet ? "-mr-3" : "-mr-[22px]"))}>
      {deckF ? (
        <button className={cn(chip, chipOn)} onClick={() => setDeckF("")} aria-label={`Deck ${deckF}, clear`}>{deckF.split("::").pop()}<X className="size-[13px]" strokeWidth={2.4} /></button>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><button className={chip}>All decks <ChevronDown className="size-3.5" strokeWidth={2.2} /></button></DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
            {decks.filter((d) => !d.archived).map((d) => (
              <DropdownMenuItem key={d.name} onClick={() => setDeckF(d.name)} style={{ paddingLeft: 8 + d.depth * 14 }} className={cn(d.depth > 0 && "text-muted-foreground")}>{d.name.split("::").pop()}</DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {CHIPS.map(([k, label]) => (
        <button key={k} aria-pressed={chips.has(k)} className={cn(chip, chips.has(k) && chipOn)} onClick={() => setChips((c) => { const n = new Set(c); n.has(k) ? n.delete(k) : n.add(k); return n; })}>{label}</button>
      ))}
      {typeF ? (
        <button className={cn(chip, chipOn)} onClick={() => setTypeF("")}>{typeName.get(typeF) ?? typeF}<X className="size-[13px]" strokeWidth={2.4} /></button>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><button className={chip}>Any type <ChevronDown className="size-3.5" strokeWidth={2.2} /></button></DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
            {types.map((t) => <DropdownMenuItem key={t.id} onClick={() => setTypeF(t.id)}>{t.name}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
  const count = error
    ? <span className="min-w-0 truncate text-destructive">{error}</span>
    : <span className="tabular min-w-0 truncate whitespace-nowrap">{library != null && total !== library ? `${total.toLocaleString("en-US")} of ${library.toLocaleString("en-US")}` : `${total.toLocaleString("en-US")} card${total === 1 ? "" : "s"}`}</span>;
  const orderLabel = (ORDERS.find(([v]) => v === order)?.[1] ?? COLS.find(([, , o]) => o === order)?.[1] ?? "Sorted") + (reverse ? " ↑" : "");
  const toolbar = selecting && checked.size > 0 && !phone ? (
    bulkBar()
  ) : (
    <div className="mt-2.5 flex min-h-10 items-center gap-2.5 text-[13px] text-muted-foreground">
      {selecting && <Box on={allChecked} label="Select all" onClick={() => setChecked(allChecked ? new Set() : new Set(items.map((r) => r.itemId)))} />}
      {count}
      <div className="flex-1" />
      {items.length > 0 && <button className="shrink-0 rounded-lg px-2 py-1.5 font-semibold hover:bg-accent hover:text-foreground" onClick={() => (selecting ? endSelect() : setSelecting(true))}>{selecting ? "Done" : "Select"}</button>}
      <DropdownMenu>
        <DropdownMenuTrigger asChild><button className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 font-semibold whitespace-nowrap hover:bg-accent hover:text-foreground"><ArrowUpDown className="size-[15px]" />{orderLabel}</button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel className="text-xs text-muted-foreground">Sort by</DropdownMenuLabel>
          {ORDERS.map(([v, label]) => <DropdownMenuItem key={v} onClick={() => { setOrder(v); setReverse(false); }}>{label}{v === order && <Check className="ml-auto" />}</DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  function bulkBar() {
    const btn = cn("inline-flex shrink-0 items-center gap-1.5 rounded-lg whitespace-nowrap hover:bg-[rgb(127_127_127/0.25)]", phone ? "p-2" : tablet ? "px-1.5 py-[7px]" : "px-2 py-[7px]");
    return (
      <div className={cn("browse-fi flex items-center rounded-xl bg-foreground py-1 pr-1.5 pl-3 text-[13.5px] font-semibold text-background", phone ? "fixed inset-x-3 bottom-[calc(var(--tabbar-h)+12px)] z-30 min-h-14 gap-0 rounded-[18px] shadow-[0_12px_30px_rgb(0_0_0/0.25)]" : cn("mt-2.5 min-h-10", tablet ? "gap-0" : "gap-1"))}>
        <b className="mr-auto pr-2 whitespace-nowrap tabular">{checked.size} selected</b>
        <button className={btn} onClick={() => setMoveOpen(true)} title="Move"><FolderInput className="size-[17px]" /></button>
        <button className={btn} onClick={() => setTagOpen(true)} title="Tags"><Tag className="size-[17px]" /></button>
        <button className={btn} onClick={() => bulkSuspend(true)} title="Suspend"><Pause className="size-[17px]" /></button>
        {!tablet && <button className={btn} onClick={() => setConfirm("reset")} title="Start over"><RotateCcw className="size-[17px]" /></button>}
        <button className={btn} onClick={() => setConfirm("delete")} title="Delete"><Trash2 className="size-[17px]" /></button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><button className={btn} aria-label="More actions"><MoreHorizontal className="size-[17px]" /></button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {tablet && <DropdownMenuItem onClick={() => setConfirm("reset")}><RotateCcw />Start over</DropdownMenuItem>}
            <DropdownMenuItem onClick={() => bulkSuspend(false)}><Play />Unsuspend</DropdownMenuItem>
            <DropdownMenuItem onClick={() => bulkArchive(true)}><Archive />Archive</DropdownMenuItem>
            <DropdownMenuItem onClick={() => bulkArchive(false)}><ArchiveRestore />Unarchive</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button className={btn} onClick={endSelect} title="Done · Esc" aria-label="Clear selection"><X className="size-[17px]" /></button>
      </div>
    );
  }

  const noMatch = (
    <div className="flex flex-col items-center gap-2.5 px-5 py-[60px] text-center text-[14.5px] text-muted-foreground max-md:pt-[70px]">
      <h3 className="browse-serif mt-1.5 text-2xl leading-tight text-foreground">Nothing matches</h3>
      <span>{query ? <>No card has “{query}”</> : "No card fits these filters"}{query && filtered ? " with these filters" : ""}.</span>
      <Button variant="outline" className="mt-2.5 h-10 rounded-[11px]" onClick={() => { setQuery(""); setChips(new Set()); setDeckF(""); setTypeF(""); }}>Clear search and filters</Button>
    </div>
  );
  const more = total > rows.length && (
    <div className="flex justify-center py-4">
      <Button variant="outline" className="rounded-[11px]" onClick={() => run(fullQuery, rows.length + PAGE)}>Show {Math.min(PAGE, total - rows.length)} more</Button>
    </div>
  );
  const dialogs = (
    <>
      <NewItemDialog open={creating} onOpenChange={setCreating} decks={deckNames} types={types} defaultDeck={deckF || undefined} onCreated={(id) => { setSelected(id); changed(); }} />
      <MoveDialog open={moveOpen} onOpenChange={setMoveOpen} decks={deckNames} onMove={bulkMove} />
      <TagDialog open={tagOpen} onOpenChange={setTagOpen} tags={tags} onApply={bulkTag} />
      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "delete" ? `Delete ${plural(checked.size)}?` : `Start ${plural(checked.size)} over?`}</AlertDialogTitle>
            <AlertDialogDescription>{confirm === "delete" ? "This removes them with all their review history. Archiving hides them and keeps the history." : "They come back as new cards. Their past reviews stay in History."}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant={confirm === "delete" ? "destructive" : "default"} onClick={() => (confirm === "delete" ? bulkDelete() : bulkReset())}>{confirm === "delete" ? "Delete" : "Start over"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );

  // Fills the window exactly: the app's main adds bottom padding for scrolling pages, which this one cancels.
  const H = "h-[calc(100dvh-var(--tabbar-h))] -mb-6 md:-mb-16";

  // An empty library: one page, no split, search or chips.
  if (library === 0 && !rows.length)
    return (
      <div className={cn(H, "overflow-y-auto")}>
        <div className={cn("mx-auto max-w-[1180px] pb-[120px]", phone ? "px-5 pt-[calc(0.5rem+env(safe-area-inset-top))]" : tablet ? "px-7 pt-6" : "px-11 pt-[30px]")}>
          {header}
          <div className="flex flex-col items-center gap-2.5 px-5 pt-[90px] pb-10 text-center text-[14.5px] text-muted-foreground max-md:pt-[70px]">
            <Blank plus className="mb-1.5 h-[150px] w-[220px]" />
            <h3 className="browse-serif mt-1.5 text-2xl leading-tight text-foreground">No cards yet</h3>
            <span>Every card in every deck shows up here, ready to search and edit.</span>
            <div className="mt-2.5 flex flex-wrap justify-center gap-2.5">
              <Button className="h-10 gap-2 rounded-[11px] px-4 font-semibold" onClick={() => setCreating(true)}><Plus className="size-4" />New card</Button>
              <Button variant="outline" className="h-10 gap-2 rounded-[11px] px-4" onClick={importFile}><Upload className="size-4" />Import</Button>
            </div>
          </div>
        </div>
        {dialogs}
      </div>
    );

  // Nothing matches the search: one column with the message under the search.
  if (loaded && !rows.length && !error && library !== 0 && !phone)
    return (
      <div className={cn(H, "overflow-y-auto")}>
        <div className={cn("mx-auto max-w-[1180px] pb-[120px]", tablet ? "px-7 pt-6" : "px-11 pt-[30px]")}>
          {header}{search}{chipRow(true)}{toolbar}{noMatch}
        </div>
        {dialogs}
      </div>
    );

  const editor = selected && (
    <ItemEditor
      key={selected}
      id={selected}
      gutter={!phone}
      closeX={!phone}
      onBack={() => setSelected(null)}
      decks={deckNames}
      tags={tags}
      onDirtyChange={(d) => setDirtyId(d ? selected : null)}
      onSaved={changed}
      onDeleted={() => { setSelected(null); changed(); }}
      onDuplicate={(newId) => { setSelected(newId); setCursor(newId); changed(); }}
    />
  );

  // Phones: the list, then the card as its own page.
  if (phone)
    return (
      <div className={cn(H, "flex min-w-0")}>
        {!selected && (
          <section className="block min-h-0 w-full min-w-0 overflow-y-auto px-5 pt-[calc(0.5rem+env(safe-area-inset-top))] [&>*]:shrink-0">
            {header}{search}{chipRow(false)}{toolbar}
            <div ref={listRef} className="pb-[150px]">
              {items.map((r) => (
                <Row key={r.itemId} r={r} typeName={typeName.get(r.type) ?? r.type} words={words} active={false} checked={checked.has(r.itemId)} selecting={selecting} dirty={dirtyId === r.itemId} phone tablet={false} onOpen={() => setSelected(r.itemId)} onToggle={() => toggle(r.itemId)} />
              ))}
              {loaded && !items.length && !error && noMatch}
              {more}
            </div>
            {selecting && checked.size > 0 && bulkBar()}
          </section>
        )}
        {selected && <section className="relative min-h-0 min-w-0 flex-1 overflow-y-auto" id="browse-inspector">{editor}</section>}
        {dialogs}
      </div>
    );

  // Desktop and iPad: the table fills the page; a picked card opens in a drawer on the right.
  const cols = new Set<ColKey>(COLS.map(([k]) => k).filter((k) => !(tablet && TABLET_HIDDEN.has(k))));
  const W: Partial<Record<ColKey, number>> = tablet ? { type: 92, next: 112, every: 74, recall: 70, missed: 66 } : { deck: 168, type: 104, next: 122, every: 78, recall: 72, missed: 70, edited: 100 };
  const sortBy = (o: string) => {
    if (order === o) setReverse((v) => !v);
    else { setOrder(o); setReverse(false); }
  };
  const iconOf = (deck: string) => decks.find((d) => d.name === deck.split("::")[0])?.icon ?? null;
  return (
    <div ref={pageRef} className={cn(H, "relative flex min-w-0")}>
      <section className={cn("flex min-h-0 min-w-0 flex-1 flex-col [&>*]:shrink-0", tablet ? "px-7 pt-6" : "px-11 pt-[30px]")}>
        {header}{search}{chipRow(false)}{toolbar}
        <div ref={listRef} className={cn("browse-tw -mx-2 mt-1.5 min-h-0 flex-1 shrink! overflow-auto pb-28")}>
          <table className="w-full table-fixed border-separate border-spacing-0">
            <colgroup>
              <col style={{ width: 38 }} />
              {COLS.filter(([k]) => cols.has(k)).map(([k]) => <col key={k} style={W[k] ? { width: W[k] } : undefined} />)}
            </colgroup>
            <thead>
              <tr>
                <th className="sticky top-0 z-[2] bg-background px-1.5 shadow-[inset_0_-1px_0_var(--border)]">
                  {selecting && <Box on={allChecked} label="Select all" onClick={() => setChecked(allChecked ? new Set() : new Set(items.map((r) => r.itemId)))} />}
                </th>
                {COLS.filter(([k]) => cols.has(k)).map(([k, label, o, num]) => {
                  const on = order === o;
                  return (
                    <th key={k} aria-sort={on ? (reverse ? "descending" : "ascending") : undefined} className={cn("sticky top-0 z-[2] bg-background p-0 shadow-[inset_0_-1px_0_var(--border)]", num ? "text-right" : "text-left")}>
                      <button onClick={() => sortBy(o)} className={cn("inline-flex h-9 w-full items-center gap-1 px-2.5 text-xs font-[650] whitespace-nowrap hover:text-foreground", num && "justify-end", on ? "text-foreground" : "text-muted-foreground")} title={`Sort by ${label.toLowerCase()}`}>
                        {label}{on && (reverse ? <ArrowUp className="size-3" strokeWidth={2.5} /> : <ArrowDown className="size-3" strokeWidth={2.5} />)}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <TableRow
                  key={r.itemId}
                  r={r}
                  typeName={typeName.get(r.type) ?? r.type}
                  icon={iconOf(r.deck)}
                  words={words}
                  active={(selected ?? cursor) === r.itemId}
                  checked={checked.has(r.itemId)}
                  selecting={selecting}
                  dirty={dirtyId === r.itemId}
                  cols={cols}
                  onOpen={() => { setCursor(r.itemId); setSelected(r.itemId); }}
                  onToggle={() => toggle(r.itemId)}
                />
              ))}
            </tbody>
          </table>
          {more}
        </div>
      </section>
      {selected && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the card panel"
          aria-valuenow={Math.round(drawerW)}
          tabIndex={0}
          title="Drag to resize · double-click to reset"
          onPointerDown={startResize}
          onDoubleClick={() => setDrawerW(null)}
          onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); setDrawerW(drawerW + (e.key === "ArrowLeft" ? 40 : -40)); } }}
          className="browse-resize absolute inset-y-0 z-30 w-3 cursor-col-resize touch-none outline-none"
          style={{ right: drawerW - 6 }}
        />
      )}
      {selected && (
        <aside ref={drawerRef} className="browse-drawer absolute inset-y-0 right-0 z-20 overflow-y-auto bg-background" style={{ width: drawerW }} id="browse-inspector" aria-label="Card">
          {editor}
          {/* Room to scroll the last field clear of the corner Minimi / Ask bubble. */}
          <div aria-hidden className="h-24" />
        </aside>
      )}
      {dialogs}
    </div>
  );
}
