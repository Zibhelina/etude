// Ctrl/⌘K anywhere outside a study session: a search bar in the middle of the screen over a blurred page, with
// suggestions before you type, that jumps to a deck in the Library. Enter opens the deck, ⌘/Ctrl+Enter studies it.
import { NoteIcon } from "@/editor/note-icon";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search } from "lucide-react";
import { api, type DeckNode, type NoteSummary } from "@/lib/api";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { DeckBadge } from "@/components/deck-icon";

/** Other parts of the app (a search button, a menu) can open it with this event. */
export const DECK_FINDER_EVENT = "etude:deck-finder";
export const openDeckFinder = () => window.dispatchEvent(new Event(DECK_FINDER_EVENT));

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
  // path word counts more than one that only starts it, so "week 3" finds what's in Week 3 before Week 1 of CMPT 371.
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
      setOpen((o) => !o);
    };
    const ev = () => enabledRef.current && setOpen(true);
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
  return open ? <FinderPanel onClose={() => setOpen(false)} /> : null;
}

function FinderPanel({ onClose }: { onClose(): void }) {
  const [decks, setDecks] = useState<DeckNode[] | null>(null);
  const [pages, setPages] = useState<NoteSummary[]>([]);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [closing, setClosing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // Hover only moves the selection once the mouse really moves, so the list scrolling under a still pointer doesn't.
  const pointerMoved = useRef(false);

  useEffect(() => {
    let live = true;
    api.decks().then((d) => live && setDecks(d)).catch(() => live && setDecks([]));
    api.notes().then((n) => live && setPages(n)).catch(() => {});
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

  const query = q.trim();
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

  // Notes pages whose title matches, after the decks (only once you type).
  const pageHits = useMemo(() => {
    if (!query) return [];
    const q = query.toLowerCase();
    return pages
      .map((n) => {
        const t = (n.title || "Untitled").toLowerCase();
        const at = t.indexOf(q);
        const words = q.split(/\s+/).filter(Boolean);
        const score = t === q ? 1000 : at === 0 ? 900 : at > 0 ? 700 - at : words.every((w) => t.includes(w)) ? 500 : -1;
        return { n, score, marks: at >= 0 ? Array.from({ length: q.length }, (_, i) => at + i) : [] };
      })
      .filter((h) => h.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  }, [pages, query]);
  const count = rows.length + pageHits.length;
  // Pages go first when the best page matches better than the best deck ("greed" → the page Greedy, not a deck that only has those letters).
  const pagesFirst = !!pageHits.length && (!rows.length || pageHits[0].score > (rows[0] as Hit).score);
  const deckAt = (i: number) => (pagesFirst ? i - pageHits.length : i);
  const pageAt = (i: number) => (pagesFirst ? i : i - rows.length);
  useEffect(() => setActive(0), [query]);
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
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      setActive((a) => (count ? (a + 1) % count : 0));
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      setActive((a) => (count ? (a - 1 + count) % count : 0));
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
              {pageHits.length > 0 && <div className={cn("px-2.5 pb-1 text-[11.5px] font-semibold tracking-wide text-muted-foreground uppercase", pagesFirst ? "pt-1.5" : "pt-3")}>Pages</div>}
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
                    <span className="flex size-8 shrink-0 items-center justify-center" aria-hidden><NoteIcon icon={h.n.icon} size={22} /></span>
                    <span className="min-w-0 flex-1 truncate text-[15px] text-foreground/85"><Marked text={h.n.title || "Untitled"} marks={h.marks} /></span>
                    <span className="shrink-0 text-[12.5px] text-muted-foreground">{h.n.kind === "file" ? "File" : h.n.kind === "canvas" ? "Canvas" : "Page"}</span>
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
      className="deck-finder fixed inset-0 z-[60] flex justify-center px-4"
      onMouseDown={(e) => !(e.target as HTMLElement).closest(".deck-finder-box") && close()}
      onKeyDown={onKey}
      onMouseMove={() => (pointerMoved.current = true)}
    >
      <div className="deck-finder-veil" aria-hidden style={{ backdropFilter: "blur(14px) saturate(0.9)", WebkitBackdropFilter: "blur(14px) saturate(0.9)" }} />
      <div className="deck-finder-box relative flex max-h-[min(560px,70dvh)] w-full max-w-[620px] flex-col self-start overflow-hidden rounded-2xl bg-popover text-popover-foreground">
        <label className="flex h-14 shrink-0 items-center gap-3 px-4.5">
          <Search className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a deck or page…"
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
        <div ref={list} id="deck-finder-list" role="listbox" aria-label={title || "Decks"} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
          {decks === null ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">Loading your decks…</div>
          ) : !count ? (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">
              {query ? <>No deck or page called “{query}”.</> : "No decks yet."}
            </div>
          ) : (
            <>
{pagesFirst ? <>{pagesSection}{decksSection}</> : <>{decksSection}{pagesSection}</>}
            </>
          )}
        </div>
        <div className="hidden shrink-0 items-center gap-4 border-t px-4 py-2 text-[11.5px] text-muted-foreground sm:flex">
          <span><kbd className="deck-finder-kbd">↑</kbd><kbd className="deck-finder-kbd">↓</kbd> move</span>
          <span><kbd className="deck-finder-kbd">↵</kbd> open</span>
          <span><kbd className="deck-finder-kbd">{mac ? "⌘" : "Ctrl"}</kbd><kbd className="deck-finder-kbd">↵</kbd> study</span>
          <span className="ml-auto"><kbd className="deck-finder-kbd">{FINDER_KEY}</kbd> anywhere</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
