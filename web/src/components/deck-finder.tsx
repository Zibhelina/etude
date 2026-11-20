// Ctrl/⌘K anywhere outside a study session: a search bar in the middle of the screen over a blurred page, with
// suggestions before you type, that jumps to a deck in the Library. Enter opens the deck, ⌘/Ctrl+Enter studies it.
// Typed after a ">", it's the app's commands instead (a new chat, a new tab, the panels, the screens). Whatever opens
// in the Notebook (a command's chat or tab, or a page found here with Tab) can go through a second step that shows
// the panes as they are and lets you pick where it lands.
import { NoteIcon } from "@/editor/note-icon";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search } from "lucide-react";
import { api, type DeckNode, type NoteSummary } from "@/lib/api";
import { isLocal } from "@/lib/transport";
import { findPages, fold, pagePaths, recentPages, type PageHit } from "@/lib/page-find";
import { isPhone } from "@/lib/device";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { DeckBadge } from "@/components/deck-icon";
import { toast } from "sonner";
import { WEB_HOME, canWebTabs, isWebTab, webTabs, webTitle } from "@/lib/web-tabs";
import { applyView, viewNow } from "@/lib/view-remote";
import { chatTabId, dock } from "@/lib/agent-dock";
import { chatToPanel } from "@/components/agent-panel";
import { PlacePicker, canPlaceLive, type Place } from "@/components/place-picker";
import { usePluginCommands, type PluginCommand } from "@/lib/plugins";

/** Other parts of the app (a search button, a menu) can open it with this event. */
export const DECK_FINDER_EVENT = "etude:deck-finder";
/** `q` starts the box with that text (">" opens straight into the commands). */
export const openDeckFinder = (q?: string) => window.dispatchEvent(new CustomEvent(DECK_FINDER_EVENT, { detail: typeof q === "string" ? q : undefined }));

const enc = encodeURIComponent;
const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const FINDER_KEY = mac ? "⌘K" : "Ctrl+K";
const todo = (d: DeckNode) => d.new + d.learning + d.review;
const leaf = (name: string) => name.split("::").pop()!;
const parentPath = (name: string) => name.split("::").slice(0, -1).join(" › ");

interface Hit {
  deck: DeckNode;
  score: number;
  /** Character positions in the deck's own name to bold. */
  marks: number[];
}

/** Where `q`'s characters appear in order inside `s` (all lowercased), preferring starts of words; null when they don't. */
function subsequence(s: string, q: string): number[] | null {
  const out: number[] = [];
  let from = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    let i = -1;
    // A word start is a better place for the letter than the middle of a word.
    for (let j = from; j < s.length; j++) {
      if (s[j] === ch && (j === 0 || /[\s\-_:./()]/.test(s[j - 1]))) {
        i = j;
        break;
      }
    }
    if (i < 0) i = s.indexOf(ch, from);
    if (i < 0) return null;
    out.push(i);
    from = i + 1;
  }
  return out;
}

function match(d: DeckNode, raw: string): Hit | null {
  const q = raw.trim().toLowerCase();
  const name = leaf(d.name).toLowerCase();
  const full = d.name.toLowerCase().replaceAll("::", " ");
  const range = (start: number, n: number) => Array.from({ length: n }, (_, i) => start + i);
  // The deck's own name counts most; its parents still find it ("307 week 3").
  if (name === q) return { deck: d, score: 1000, marks: range(0, q.length) };
  if (name.startsWith(q)) return { deck: d, score: 900 - name.length, marks: range(0, q.length) };
  const at = name.indexOf(q);
  if (at >= 0) return { deck: d, score: 700 - at - name.length / 10, marks: range(at, q.length) };
  // Words: each one has to start a word somewhere in the path ("307 week 3"). A word equal to a whole
  // path word counts more than one that only starts it, so "week 3" finds what's in Week 3 before Week 1 of Networking.
  const words = q.split(/\s+/).filter(Boolean);
  const tokens = full.split(/[\s\-_/.()]+/).filter(Boolean);
  if (words.length && words.every((w) => tokens.some((t) => t.startsWith(w)))) {
    const exact = words.filter((w) => tokens.includes(w)).length;
    const marks = words.flatMap((w) => {
      const i = name.search(new RegExp(`(^|[\\s\\-_/.()])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      return i >= 0 ? range(i === 0 && name.startsWith(w) ? 0 : i + 1, w.length) : [];
    });
    // The whole phrase in the path, as typed ("week 3" inside "… week 3 …"), beats words found far apart.
    const phrase = new RegExp(`(^|\\s)${q.replace(/\s+/g, " ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(full) ? 80 : 0;
    return { deck: d, score: 500 + phrase + exact * 40 - full.length / 10 + marks.length * 2, marks };
  }
  const sub = subsequence(name, q.replace(/\s+/g, ""));
  if (sub) {
    const spread = sub[sub.length - 1] - sub[0];
    return { deck: d, score: 300 - spread - name.length / 10, marks: sub };
  }
  return null;
}

/** True when one of the words typed starts a word of the text: "lect" finds "lecture", not "select". */
function startsAWord(text: string, q: string): boolean {
  const t = fold(text);
  return fold(q).split(/\s+/).filter(Boolean).some((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u").test(t));
}

function Marked({ text, marks }: { text: string; marks: number[] }) {
  if (!marks.length) return <>{text}</>;
  const set = new Set(marks);
  return (
    <>
      {[...text].map((c, i) => (set.has(i) ? <b key={i} className="deck-finder-mark">{c}</b> : <span key={i}>{c}</span>))}
    </>
  );
}

/** Mounted once by the app; listens for Ctrl/⌘K and the open event. */
export function DeckFinder({ enabled }: { enabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [first, setFirst] = useState("");
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k")) return;
      // In a canvas Ctrl/⌘+K adds a link to a shape.
      if ((e.target as HTMLElement | null)?.closest?.(".excalidraw")) return;
      // Browse and a deck's page use ⌘K for their own search; they run first and claim the key.
      if (e.defaultPrevented || !enabledRef.current) return;
      if (document.querySelector("[role=dialog]:not([data-deck-finder]), [role=alertdialog]")) return;
      e.preventDefault();
      setFirst("");
      setOpen((o) => !o);
    };
    const ev = (e: Event) => {
      if (!enabledRef.current) return;
      setFirst(((e as CustomEvent).detail as string | undefined) ?? "");
      setOpen(true);
    };
    window.addEventListener("keydown", h);
    window.addEventListener(DECK_FINDER_EVENT, ev);
    return () => {
      window.removeEventListener("keydown", h);
      window.removeEventListener(DECK_FINDER_EVENT, ev);
    };
  }, []);
  useEffect(() => {
    if (!enabled) setOpen(false);
  }, [enabled]);
  return open ? <FinderPanel first={first} onClose={() => setOpen(false)} /> : null;
}

// ---------------------------------------------------------------- commands (after ">")

interface Command {
  id: string;
  label: string;
  /** Other words that find it. */
  also?: string;
  hint?: string;
  /** Opens something in the Notebook: the second step asks where. */
  place?: { what: string; panel?: boolean; initial?: "tab" | "left" | "right" | "top" | "bottom"; slot?: "next" | "end"; open(p: Place): Promise<void> | void };
  run?(): void;
}

const fail = (e: unknown) => toast.error((e as Error)?.message || "That didn't work");
const where = (p: Extract<Place, { pane: number }>) => ({ where: p.zone, beside: { pane: p.pane }, ...(p.zone === "tab" && p.before !== undefined ? { before: p.before } : {}) }) as const;

function commands(pluginCommands: PluginCommand[] = []): Command[] {
  const shell = viewNow().shell;
  const go = (route: string) => () => void applyView({ action: "go", route }).catch(fail);
  const out: Command[] = [
    ...pluginCommands.map((pc): Command => ({
      id: `plugin:${pc.pluginId}:${pc.id}`,
      label: pc.label,
      also: `${pc.pluginName} plugin`,
      hint: pc.shortcut || pc.pluginName,
      run: pc.run,
    })),
    {
      id: "chat",
      label: "New chat",
      also: "ask agent minimi conversation",
      place: {
        what: "New chat",
        panel: true,
        initial: "right",
        open: async (p) => {
          const chat = { key: Math.random().toString(36).slice(2, 9), conv: null };
          if ("panel" in p) return chatToPanel(chat);
          dock.add(chat);
          await applyView({ action: "open", note: chatTabId(chat.key), ...where(p) });
        },
      },
    },
    {
      id: "tab",
      label: "New tab",
      also: "start page blank",
      place: { what: "New tab", slot: "end", open: async (p) => void ("pane" in p && (await applyView({ action: "open", ...where(p) }))) },
    },
    ...(canWebTabs()
      ? [
          {
            id: "web",
            label: "New web tab",
            also: "browser website internet url search link",
            place: { what: "New web tab", slot: "end", open: async (p: Place) => void ("pane" in p && (await applyView({ action: "open", note: webTabs.create(WEB_HOME), ...where(p) }))) },
          } satisfies Command,
        ]
      : []),
    {
      id: "page",
      label: "New page",
      also: "note create write",
      place: {
        what: "Untitled",
        open: async (p) => {
          if (!("pane" in p)) return;
          const n = await api.createNote({ title: "" });
          await applyView({ action: "open", note: n.id, ...where(p) });
        },
      },
    },
    { id: "panel", label: shell?.panel ? "Close the Ask panel" : "Open the Ask panel", also: "chat side toggle", run: () => void applyView({ action: "panel", open: !shell?.panel }).catch(fail) },
    { id: "sidebar", label: shell?.sidebar === "open" ? "Collapse the sidebar" : "Open the sidebar", also: "toggle rail", run: () => void applyView({ action: "sidebar", mode: shell?.sidebar === "open" ? "rail" : "open" }).catch(fail) },
    { id: "go-library", label: "Go to Library", also: "decks home", hint: "Screen", run: go("/") },
    { id: "go-notes", label: "Go to Notebook", also: "notes pages", hint: "Screen", run: go("/notes") },
    { id: "go-browse", label: "Go to Browse", also: "cards search", hint: "Screen", run: go("/browse") },
    { id: "go-stats", label: "Go to Stats", also: "statistics charts", hint: "Screen", run: go("/stats") },
    { id: "go-market", label: "Go to Market", also: "shop store", hint: "Screen", run: go("/market") },
    { id: "go-settings", label: "Go to Settings", also: "preferences options", hint: "Screen", run: go("/settings") },
  ];
  // Phones have no panes to place things in.
  return isPhone() ? out.filter((c) => !c.place || c.id === "chat").map((c) => (c.place ? { ...c, place: undefined, run: () => chatToPanel({ key: Math.random().toString(36).slice(2, 9), conv: null }) } : c)) : out;
}

function findCommands(all: Command[], q: string): { c: Command; marks: number[] }[] {
  const ql = q.trim().toLowerCase();
  if (!ql) return all.map((c) => ({ c, marks: [] }));
  const hits: { c: Command; marks: number[]; score: number }[] = [];
  for (const c of all) {
    const l = c.label.toLowerCase();
    const at = l.indexOf(ql);
    if (at >= 0) {
      hits.push({ c, marks: Array.from({ length: ql.length }, (_, i) => at + i), score: 900 - at });
      continue;
    }
    const words = ql.split(/\s+/).filter(Boolean);
    const pool = `${l} ${c.also ?? ""}`.split(/\s+/);
    if (words.every((w) => pool.some((t) => t.startsWith(w)))) {
      hits.push({ c, marks: [], score: 600 });
      continue;
    }
    const sub = subsequence(l, ql.replace(/\s+/g, ""));
    if (sub) hits.push({ c, marks: sub, score: 300 - (sub[sub.length - 1] - sub[0]) });
  }
  return hits.sort((a, b) => b.score - a.score);
}

function FinderPanel({ first, onClose }: { first: string; onClose(): void }) {
  const [decks, setDecks] = useState<DeckNode[] | null>(null);
  const [pages, setPages] = useState<NoteSummary[]>([]);
  const [folders, setFolders] = useState<Map<string, string>>(() => new Map());
  const [q, setQ] = useState(first);
  const [active, setActive] = useState(0);
  /** The second step: where the chosen thing opens. */
  const [placing, setPlacing] = useState<NonNullable<Command["place"]> | null>(null);
  /** The place is drawn on the Notebook itself, so the box steps aside. */
  const live = !!placing && canPlaceLive();
  const [closing, setClosing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // Hover only moves the selection once the mouse really moves, so the list scrolling under a still pointer doesn't.
  const pointerMoved = useRef(false);

  useEffect(() => {
    let live = true;
    api.decks().then((d) => live && setDecks(d)).catch(() => live && setDecks([]));
    // Notes isn't on phones yet, so the finder lists only decks there.
    if (!isPhone()) api.notes().then((n) => live && setPages(n)).catch(() => {});
    // Folders on this computer, open in the Notebook: their names, to say where a file found in one is.
    if (!isPhone() && !isLocal()) api.folders().then((f) => live && setFolders(new Map(f.folders.map((x) => [x.id, x.name]))), () => {});
    const prev = document.activeElement as HTMLElement | null;
    const html = document.documentElement;
    const overflow = html.style.overflow;
    html.style.overflow = "hidden";
    return () => {
      live = false;
      html.style.overflow = overflow;
      prev?.focus?.({ preventScroll: true });
    };
  }, []);
  useLayoutEffect(() => input.current?.focus(), []);

  const pluginCommands = usePluginCommands();
  const cmdMode = q.trimStart().startsWith(">");
  const query = cmdMode ? "" : q.trim();
  const cmdHits = useMemo(() => (cmdMode ? findCommands(commands(pluginCommands), q.trimStart().slice(1)) : []), [cmdMode, q, pluginCommands]);
  // Plain search (3+ chars) also surfaces matching plugin commands (e.g. typing "pomodoro").
  const pluginHits = useMemo(() => {
    if (cmdMode || query.length < 3 || !pluginCommands.length) return [];
    const ql = query.toLowerCase();
    return pluginCommands
      .filter((c) => `${c.label} ${c.pluginName}`.toLowerCase().includes(ql))
      .map((pc): Command => ({
        id: `plugin:${pc.pluginId}:${pc.id}`,
        label: pc.label,
        hint: pc.shortcut || pc.pluginName,
        run: pc.run,
      }));
  }, [cmdMode, query, pluginCommands]);
  const { title, rows } = useMemo(() => {
    const all = (decks ?? []).filter((d) => !d.archived);
    if (!query) {
      // Before you type: the decks with the most waiting today, or the top-level decks when nothing is due.
      // A parent counts its subdecks' cards, so suggest the most specific deck holding the work: one with no
      // subdeck that has work of its own.
      const due = all.filter((d) => d.mode !== "watch" && todo(d) > 0);
      const picks: Hit[] = due
        .filter((d) => !due.some((c) => c.name.startsWith(d.name + "::")))
        .sort((a, b) => todo(b) - todo(a) || a.name.localeCompare(b.name))
        .slice(0, 6)
        .map((deck) => ({ deck, score: 0, marks: [] }));
      if (picks.length) return { title: "Waiting for you today", rows: picks };
      return { title: "Your decks", rows: all.filter((d) => d.depth === 0).slice(0, 8).map((deck) => ({ deck, score: 0, marks: [] })) };
    }
    const hits = all.map((d) => match(d, query)).filter((h): h is Hit => !!h);
    hits.sort((a, b) => b.score - a.score || a.deck.depth - b.deck.depth || a.deck.name.localeCompare(b.deck.name));
    return { title: hits.length ? "Decks" : "", rows: hits.slice(0, 50) };
  }, [decks, query]);

  // Pages found by their text (the server searches the bodies), a moment after typing stops.
  const [inText, setInText] = useState<{ q: string; hits: (NoteSummary & { snippet: string })[] }>({ q: "", hits: [] });
  useEffect(() => {
    if (query.length < 2 || isPhone()) return setInText({ q: "", hits: [] });
    let live = true;
    const t = window.setTimeout(() => api.searchNotes(query, 12).then((hits) => live && setInText({ q: query, hits }), () => {}), 140);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [query]);
  // Notebook pages: before you type, the ones opened last; then the ones whose title (or a folder above them)
  // matches, found like decks; then the ones that only have the words in their text.
  const pageHits: PageHit<NoteSummary>[] = useMemo(() => {
    if (!query) return recentPages(pages, 5);
    const byTitle = findPages(pages, query, 30);
    const have = new Set(byTitle.map((h) => h.n.id));
    const paths = pagePaths(pages);
    // Files in a folder on this computer come from the server already matched (by name, then by their text):
    // a name match shows where the file is, a text match shows the line.
    const diskPath = (n: NoteSummary) => [folders.get(n.local!.folder) ?? "", ...n.local!.path.split("/").slice(0, -1)].filter(Boolean).join(" › ");
    const byText = inText.q === query ? inText.hits.filter((n) => !have.has(n.id) && !n.archived && (n.local || startsAWord(n.snippet, query))).map((n) => ({ n, score: 100, marks: [], path: n.local ? diskPath(n) : paths.get(n.id) ?? "", snippet: n.snippet })) : [];
    return [...byTitle, ...byText];
  }, [pages, query, inText, folders]);
  const count = cmdMode ? cmdHits.length : rows.length + pageHits.length + pluginHits.length;
  // Pages go first when the best page matches better than the best deck ("greed" → the page Greedy, not a deck that only has those letters).
  const pagesFirst = !!query && !!pageHits.length && (!rows.length || pageHits[0].score > (rows[0] as Hit).score);
  const deckAt = (i: number) => (pagesFirst ? i - pageHits.length : i);
  const pageAt = (i: number) => (pagesFirst ? i : i - rows.length);
  const pluginAt = (i: number) => i - rows.length - pageHits.length;
  useEffect(() => setActive(0), [query, cmdMode]);
  useEffect(() => {
    list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const close = (then?: () => void) => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(() => {
      onClose();
      then?.();
    }, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 120);
  };
  const goPage = (n: NoteSummary) => close(() => navigate(`/notes?id=${enc(n.id)}`));
  /** Tab on a page: pick where it opens. */
  const placePage = (n: NoteSummary) =>
    setPlacing({ what: n.title.trim() || "Untitled", open: async (p) => void ("pane" in p && (await applyView({ action: "open", note: n.id, ...where(p) }))) });
  const runCommand = (c: Command) => {
    if (c.place) return setPlacing(c.place);
    close(() => c.run?.());
  };
  const placed = (p: Place) => {
    const job = placing;
    if (!job) return;
    close(() => void Promise.resolve(job.open(p)).catch(fail));
  };
  const titleOf = (id: string) => (id.startsWith("chat:") ? "Chat" : id.startsWith("new:") ? "New tab" : isWebTab(id) ? webTitle(webTabs.get(id)) : pages.find((n) => n.id === id)?.title.trim() || "Untitled");
  const go = (d: DeckNode, study: boolean) => {
    const to = !study
      ? `/deck?name=${enc(d.name)}`
      : d.mode === "watch"
        ? `/watch?deck=${enc(d.name)}`
        : `/study?deck=${enc(d.name)}${todo(d) ? "" : "&ahead=1"}`;
    close(() => navigate(to));
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      return close();
    }
    if (placing) return;
    if (cmdMode) {
      if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) (e.preventDefault(), setActive((a) => (count ? (a + 1) % count : 0)));
      else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) (e.preventDefault(), setActive((a) => (count ? (a - 1 + count) % count : 0)));
      else if ((e.key === "Enter" || e.key === "Tab") && cmdHits[active]) (e.preventDefault(), runCommand(cmdHits[active].c));
      else if (e.key === "Tab") e.preventDefault();
      return;
    }
    const pageHere = pageAt(active) >= 0 ? pageHits[pageAt(active)] : undefined;
    if (e.key === "Tab" && pageHere && !isPhone()) {
      e.preventDefault();
      return placePage(pageHere.n);
    }
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      setActive((a) => (count ? (a + 1) % count : 0));
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      setActive((a) => (count ? (a - 1 + count) % count : 0));
    } else if (e.key === "Enter" && pluginAt(active) >= 0 && pluginHits[pluginAt(active)]) {
      e.preventDefault();
      runCommand(pluginHits[pluginAt(active)]);
    } else if (e.key === "Enter" && pageHits[pageAt(active)] && pageAt(active) >= 0) {
      e.preventDefault();
      goPage(pageHits[pageAt(active)].n);
    } else if (e.key === "Enter" && deckAt(active) >= 0 && rows[deckAt(active)]) {
      e.preventDefault();
      go(rows[deckAt(active)].deck, e.metaKey || e.ctrlKey);
    } else if (e.key === "Tab") e.preventDefault();
  };

  const decksSection = (
    <>
      {title && rows.length > 0 && <div className={cn("px-2.5 pb-1 text-[11.5px] font-semibold tracking-wide text-muted-foreground uppercase", pagesFirst ? "pt-3" : "pt-1.5")}>{title}</div>}
              {rows.map((h, ri) => {
                const i = pagesFirst ? ri + pageHits.length : ri;
                const d = h.deck;
                const name = leaf(d.name);
                const parent = parentPath(d.name);
                const n = todo(d);
                return (
                  <div
                    key={d.id}
                    id={`deck-finder-${i}`}
                    data-i={i}
                    role="option"
                    aria-selected={i === active}
                    className={cn("deck-finder-row flex cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2", i === active && "is-active")}
                    style={{ animationDelay: `${Math.min(ri, 8) * 18}ms` }}
                    onMouseMove={() => pointerMoved.current && setActive(i)}
                    onClick={(e) => go(d, e.metaKey || e.ctrlKey)}
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center">
                      {d.icon === "none" ? <span className="size-2 rounded-full bg-muted-foreground/40" /> : <DeckBadge icon={d.icon} d={d} size={30} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] text-foreground/85">
                        <Marked text={name} marks={h.marks} />
                      </span>
                      {parent && <span className="block truncate text-[12.5px] text-muted-foreground">{parent}</span>}
                    </span>
                    {d.mode === "watch" ? (
                      <span className="shrink-0 text-[12.5px] text-muted-foreground">Tour</span>
                    ) : n ? (
                      <span className="shrink-0 text-[12.5px] text-muted-foreground tabular-nums">{n} today</span>
                    ) : null}
                    <span className="deck-finder-enter shrink-0 text-[12px] text-muted-foreground" aria-hidden>↵</span>
                  </div>
                );
              })}
    </>
  );
  const pagesSection = (
    <>
              {pageHits.length > 0 && <div className={cn("px-2.5 pb-1 text-[11.5px] font-semibold tracking-wide text-muted-foreground uppercase", pagesFirst ? "pt-1.5" : "pt-3")}>{query ? "Notebook" : "Jump back in"}</div>}
              {pageHits.map((h, j) => {
                const i = pagesFirst ? j : rows.length + j;
                return (
                  <div
                    key={h.n.id}
                    id={`deck-finder-${i}`}
                    data-i={i}
                    role="option"
                    aria-selected={i === active}
                    className={cn("deck-finder-row flex cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2", i === active && "is-active")}
                    onMouseMove={() => pointerMoved.current && setActive(i)}
                    onClick={() => goPage(h.n)}
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center" aria-hidden><NoteIcon icon={h.n.icon} size={22} fallback={h.n.kind === "folder" ? "📁" : "📄"} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] text-foreground/85"><Marked text={h.n.title.trim() || "Untitled"} marks={h.marks} /></span>
                      {(h.snippet || h.path) && <span className="block truncate text-[12.5px] text-muted-foreground" data-finder-sub>{h.snippet ? `${h.path ? `${h.path} · ` : ""}${h.snippet}` : h.path}</span>}
                    </span>
                    <span className="shrink-0 text-[12.5px] text-muted-foreground">{h.n.kind === "file" ? "File" : h.n.kind === "canvas" ? "Canvas" : h.n.kind === "web" ? "Web" : h.n.kind === "kanban" ? "Kanban" : h.n.kind === "pdf" ? "PDF" : h.n.kind === "folder" ? "Folder" : "Page"}</span>
                    <span className="deck-finder-enter shrink-0 text-[12px] text-muted-foreground" aria-hidden>↵</span>
                  </div>
                );
              })}
    </>
  );

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Find a deck"
      data-deck-finder=""
      data-closing={closing || undefined}
      data-placing-live={live || undefined}
      className="deck-finder fixed inset-0 z-[60] flex justify-center px-4"
      onMouseDown={(e) => !live && !(e.target as HTMLElement).closest(".deck-finder-box") && close()}
      onKeyDown={onKey}
      onMouseMove={() => (pointerMoved.current = true)}
    >
      {live && placing && (
        <PlacePicker live what={placing.what} panel={placing.panel} initial={placing.initial} slot={placing.slot} titleOf={titleOf} onPick={placed} onBack={() => (setPlacing(null), requestAnimationFrame(() => input.current?.focus()))} />
      )}
      <div className="deck-finder-veil" aria-hidden style={{ backdropFilter: "blur(14px) saturate(0.9)", WebkitBackdropFilter: "blur(14px) saturate(0.9)" }} />
      <div className="deck-finder-box relative flex max-h-[min(560px,70dvh)] w-full max-w-[620px] flex-col self-start overflow-hidden rounded-2xl bg-popover text-popover-foreground">
        <label className="flex h-14 shrink-0 items-center gap-3 px-4.5">
          <Search className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={cmdMode ? "Run a command…" : "Find a deck or page, or > for commands…"}
            aria-label="Find a deck"
            role="combobox"
            aria-expanded="true"
            aria-controls="deck-finder-list"
            aria-activedescendant={active < count ? `deck-finder-${active}` : undefined}
            autoComplete="off"
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent text-[17px] outline-none placeholder:text-muted-foreground/80"
          />
          <kbd className="hidden shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground sm:block">esc</kbd>
        </label>
        <div className="h-px shrink-0 bg-border" />
        {placing && !live ? (
          <PlacePicker what={placing.what} panel={placing.panel} initial={placing.initial} slot={placing.slot} titleOf={titleOf} onPick={placed} onBack={() => (setPlacing(null), requestAnimationFrame(() => input.current?.focus()))} />
        ) : cmdMode ? (
          <div ref={list} id="deck-finder-list" role="listbox" aria-label="Commands" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
            {!cmdHits.length ? (
              <div className="px-3 py-8 text-center text-sm text-muted-foreground">No command has “{q.trimStart().slice(1).trim()}”.</div>
            ) : (
              <>
                <div className="px-2.5 pt-1.5 pb-1 text-[11.5px] font-semibold tracking-wide text-muted-foreground uppercase">Commands</div>
                {cmdHits.map(({ c, marks }, i) => (
                  <div
                    key={c.id}
                    id={`deck-finder-${i}`}
                    data-i={i}
                    role="option"
                    aria-selected={i === active}
                    data-command={c.id}
                    className={cn("deck-finder-row flex cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2", i === active && "is-active")}
                    style={{ animationDelay: `${Math.min(i, 8) * 18}ms` }}
                    onMouseMove={() => pointerMoved.current && setActive(i)}
                    onClick={() => runCommand(c)}
                  >
                    <span className="min-w-0 flex-1 truncate text-[15px] text-foreground/85"><Marked text={c.label} marks={marks} /></span>
                    {c.place ? <span className="shrink-0 text-[12.5px] text-muted-foreground">Pick where</span> : c.hint ? <span className="shrink-0 text-[12.5px] text-muted-foreground">{c.hint}</span> : null}
                    <span className="deck-finder-enter shrink-0 text-[12px] text-muted-foreground" aria-hidden>↵</span>
                  </div>
                ))}
              </>
            )}
          </div>
        ) : (
        <div ref={list} id="deck-finder-list" role="listbox" aria-label={title || "Decks"} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
          {decks === null ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">Loading your decks…</div>
          ) : !count ? (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">
              {query ? <>No deck or page has “{query}”.</> : "No decks yet."}
            </div>
          ) : (
            <>
              {pagesFirst ? <>{pagesSection}{decksSection}</> : <>{decksSection}{pagesSection}</>}
              {pluginHits.length > 0 && (
                <>
                  <div className="px-2.5 pt-3 pb-1 text-[11.5px] font-semibold tracking-wide text-muted-foreground uppercase">Plugins</div>
                  {pluginHits.map((c, j) => {
                    const i = rows.length + pageHits.length + j;
                    return (
                      <div
                        key={c.id}
                        id={`deck-finder-${i}`}
                        data-i={i}
                        role="option"
                        aria-selected={i === active}
                        data-command={c.id}
                        className={cn("deck-finder-row flex cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2", i === active && "is-active")}
                        onMouseMove={() => pointerMoved.current && setActive(i)}
                        onClick={() => runCommand(c)}
                      >
                        <span className="min-w-0 flex-1 truncate text-[15px] text-foreground/85">{c.label}</span>
                        {c.hint && <span className="shrink-0 text-[12.5px] text-muted-foreground">{c.hint}</span>}
                        <span className="deck-finder-enter shrink-0 text-[12px] text-muted-foreground" aria-hidden>↵</span>
                      </div>
                    );
                  })}
                </>
              )}
            </>
          )}
        </div>
        )}
        <div className="hidden shrink-0 items-center gap-4 border-t px-4 py-2 text-[11.5px] text-muted-foreground sm:flex">
          {placing ? (
            <>
              <span><kbd className="deck-finder-kbd">←</kbd><kbd className="deck-finder-kbd">→</kbd><kbd className="deck-finder-kbd">↑</kbd><kbd className="deck-finder-kbd">↓</kbd> edge, then next pane</span>
              <span><kbd className="deck-finder-kbd">tab</kbd> pane</span>
              {placing.panel && <span><kbd className="deck-finder-kbd">P</kbd> panel</span>}
              <span><kbd className="deck-finder-kbd">↵</kbd> open here</span>
              <span className="ml-auto"><kbd className="deck-finder-kbd">esc</kbd> back</span>
            </>
          ) : cmdMode ? (
            <>
              <span><kbd className="deck-finder-kbd">↑</kbd><kbd className="deck-finder-kbd">↓</kbd> move</span>
              <span><kbd className="deck-finder-kbd">↵</kbd> run</span>
              <span className="ml-auto">delete the <kbd className="deck-finder-kbd">&gt;</kbd> to search</span>
            </>
          ) : (
            <>
              <span><kbd className="deck-finder-kbd">↑</kbd><kbd className="deck-finder-kbd">↓</kbd> move</span>
              <span><kbd className="deck-finder-kbd">↵</kbd> open</span>
              {!isPhone() && <span><kbd className="deck-finder-kbd">tab</kbd> pick where</span>}
              <span><kbd className="deck-finder-kbd">{mac ? "⌘" : "Ctrl"}</kbd><kbd className="deck-finder-kbd">↵</kbd> study</span>
              <span className="ml-auto"><kbd className="deck-finder-kbd">&gt;</kbd> commands</span>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
