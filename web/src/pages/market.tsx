// The market: themes, decks and card types other people shared, from a public GitHub repository.
// Discover is a featured entry and one shelf per kind; each entry opens its own page (?entry=kind/id).
// Themes can be tried on: the whole app repaints until you keep it or take it off. Publish opens a pull
// request with the user's GitHub CLI.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Blocks, Check, ChevronRight, Download, ExternalLink, Eye, GitPullRequest, Layers, Loader2, Palette, RefreshCw, Search, Store, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, Page } from "@/components/page";
import { ThemeMiniature, ThemeSwatches } from "@/components/settings-theme-preview";
import { CardPreview } from "@/components/card-preview";
import { download } from "@/components/type-editor/starter";
import { api, ApiError, type CardType, type MarketEntry, type MarketFile, type MarketKind, type PublishResult } from "@/lib/api";
import { EtudeImg } from "@/lib/local-url";
import { MarketGallery } from "@/components/market-gallery";
import { DetailLayout, niceDate, paragraphs, type InfoCell } from "@/components/market-detail";
import { Comments, socialCells, TileCounts, useEntryStats, Votes } from "@/components/market-social";
import { useMarketStats, type EntryCounts } from "@/lib/market-social";
import { HArrows, nearestIndex, useHScroll } from "@/lib/hscroll";
import { applyTheme, currentTheme, setPreviewing, type Theme } from "@/lib/theme";
import { navigate, useLocation } from "@/lib/router";
import { cn } from "@/lib/utils";
import { serverless } from "@/lib/native";
import { LibraryView, PaidDetail, PaidTile, SellingView, usePaidIndex } from "@/components/market-paid";
import { money, type PaidEntry } from "@/lib/account";
import { canShowPurchases, isNativeApp } from "@/lib/platform";
import { track } from "@/lib/telemetry";

const KIND_LABEL: Record<MarketKind, string> = { theme: "Theme", deck: "Deck", type: "Card type" };
const KIND_ICON: Record<MarketKind, React.ComponentType<{ className?: string }>> = { theme: Palette, deck: Layers, type: Blocks };
const GRADER_WORD: Record<string, string> = { self: "self-rated", script: "checked by script", ai: "AI-graded", hybrid: "script + AI" };
const plural = (n: number, w: string) => `${n.toLocaleString("en-US")} ${w}${n === 1 ? "" : "s"}`;
const kb = (b: number) => (b < 1e6 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1e6).toFixed(1)} MB`);
/** The shelves' order: these first, the rest after, what you already have last. */
const FEATURED = ["kanji-mage", "countries-of-the-world", "anatomy-3d", "flippy-bit", "periodic-table", "piano", "logic-puzzles", "geometry-puzzles", "etude-showcase", "morse-code-letters"];
const official = (author: string) => /^(Joao|João|Zibhelina)\b/.test(author);

type Filter = "all" | MarketKind;
type Tab = "browse" | "library" | "selling";
type Item = { paid: false; key: string; e: MarketEntry } | { paid: true; key: string; e: PaidEntry };

const s_ = (e: MarketEntry) => e.summary as any;
const parts = (decks: string[] = []) => decks.filter((d) => d.includes("::")).map((d) => d.split("::").pop()!);
const words = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);
const matches = (e: { name: string; description: string; author: string; tags: string[] }, w: string[]) => w.every((x) => [e.name, e.description, e.author, ...e.tags].join(" ").toLowerCase().includes(x));
function firstSentence(d: string, max = 120) {
  let s = (d || "").split(/(?<=[.!?])\s/)[0] ?? "";
  if (s.length > max) s = s.slice(0, max - 3).replace(/\s\S*$/, "") + "…";
  return s;
}
function pitch(d: string) {
  const ss = (d || "").split(/(?<=[.!?])\s+/);
  let out = "";
  for (const s of ss) {
    if (out && (out + " " + s).length > 200) break;
    out += (out ? " " : "") + s;
  }
  return out;
}
function featRank(key: string, installed: boolean, kind: MarketKind) {
  const i = FEATURED.indexOf(key.split("/").pop()!);
  return (i < 0 ? 99 + (kind === "theme" ? 50 : 0) : i) + (installed ? 500 : 0);
}
function metaLine(e: MarketEntry): string {
  const s = s_(e);
  if (e.kind === "theme") return `${s.theme.scheme === "light" ? "Light" : "Dark"} theme`;
  if (e.kind === "type") return `Card type · ${(s.types as any[]).map((t) => GRADER_WORD[t.grader] ?? t.grader).join(", ")}`;
  const p = parts(s.decks).length;
  return `${plural(s.items, "card")}${p > 1 ? ` · ${p} parts` : ""}${s.watch ? " · tour" : ""}`;
}
function By({ author }: { author: string }) {
  return official(author) ? <span className="inline-flex items-center gap-1 whitespace-nowrap"><span className="score-serif text-[15px] text-foreground">ε</span>Etude</span> : <span className="whitespace-nowrap">{author}</span>;
}

export function MarketPage() {
  // Usage count (only when the person turned usage stats on).
  useEffect(() => track("market.open"), []);
  const { params } = useLocation();
  const filter = (params.get("kind") as Filter) || "all";
  // Store apps never sell, so they don't get the Selling tab.
  const tabs: Tab[] = isNativeApp() ? ["browse", "library"] : ["browse", "library", "selling"];
  const tab: Tab = tabs.includes(params.get("tab") as Tab) ? (params.get("tab") as Tab) : "browse";
  const paid = usePaidIndex();
  const { stats, reload: reloadStats } = useMarketStats();
  const [data, setData] = useState<{ repo: string; url: string; selectedTheme: string; entries: MarketEntry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (refresh = false) => {
    setRefreshing(refresh);
    try {
      const d = await api.market(refresh);
      setData(d);
      setError(null);
      return d;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setRefreshing(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // ---- theme try-on: repaint the whole app with a market theme, then keep it or put the old one back.
  const [trying, setTrying] = useState<MarketEntry | null>(null);
  const before = useRef<Theme | null>(null);
  const takeOff = useCallback(() => {
    if (before.current) applyTheme(before.current, { persist: false });
    before.current = null;
    setPreviewing(false);
    setTrying(null);
  }, []);
  const tryOn = (e: MarketEntry) => {
    if (!before.current) before.current = currentTheme();
    setPreviewing(true);
    applyTheme(s_(e).theme as Theme, { persist: false });
    setTrying(e);
  };
  useEffect(() => () => {
    // Leaving the Market takes it off.
    if (before.current) applyTheme(before.current, { persist: false });
    before.current = null;
    setPreviewing(false);
  }, []);
  const [keeping, setKeeping] = useState(false);
  const keep = async () => {
    if (!trying) return;
    setKeeping(true);
    try {
      const r = await api.marketInstall(trying.id, "theme", { use: true });
      const t = await api.themes();
      const sel = t.themes.find((x) => x.id === r.ids[0]);
      before.current = null;
      setPreviewing(false);
      if (sel) applyTheme(sel);
      toast.success(`${trying.name} is on`, { description: "Change it any time in Settings → Appearance." });
      setTrying(null);
      void load(true);
    } catch (e) {
      toast.error("Couldn't keep the theme", { description: (e as Error).message });
    } finally {
      setKeeping(false);
    }
  };

  // ---- the open entry, from ?entry=<kind>/<id> (shareable links); paid decks are paid/<listing>.
  const want = params.get("entry");
  const openFree = useMemo(() => {
    if (!want || !data) return null;
    const [k, id] = want.split("/");
    return data.entries.find((e) => e.kind === k && e.id === id) ?? null;
  }, [data, want]);
  const openPaid = useMemo(() => (want?.startsWith("paid/") ? paid.entries.find((e) => e.listing === want.slice(5)) ?? null : null), [paid.entries, want]);
  const open = (it: Item) => navigate(`/market?entry=${it.paid ? `paid/${it.e.listing}` : `${it.e.kind}/${it.e.id}`}`);
  const leaveDetail = () => navigate(filter === "all" ? "/market" : `/market?kind=${filter}`);

  // ---- what Discover shows
  const items = useMemo<Item[]>(() => [
    ...paid.entries.map((e): Item => ({ paid: true, key: `paid/${e.listing}`, e })),
    ...(data?.entries ?? []).map((e): Item => ({ paid: false, key: `${e.kind}/${e.id}`, e })),
  ], [paid.entries, data]);
  const kindOf = (it: Item): MarketKind => (it.paid ? "deck" : it.e.kind);
  const counts = useMemo(() => {
    const c = { all: 0, theme: 0, deck: 0, type: 0 } as Record<Filter, number>;
    for (const it of items) (c.all++, c[kindOf(it)]++);
    return c;
  }, [items]);
  const sorted = (list: Item[]) => [...list].sort((a, b) => featRank(a.key, !!a.e.installed, kindOf(a)) - featRank(b.key, !!b.e.installed, kindOf(b)));
  const shown = useMemo(() => sorted(items.filter((it) => (filter === "all" || kindOf(it) === filter) && matches(it.e, words(query)))), [items, filter, query]);
  // Featured: the paid decks on sale first, then the free picks in FEATURED order (installed or not), then the most
  // liked of the rest, up to eight. Only entries with a cover, so every card has a picture.
  const featured = useMemo(() => {
    const buyable = canShowPurchases() ? sorted(items.filter((it) => it.paid && !it.e.owned && it.e.cover)) : [];
    const picks = items.filter((it) => !it.paid && it.e.cover && FEATURED.includes(it.e.id)).sort((a, b) => FEATURED.indexOf(a.e.id) - FEATURED.indexOf(b.e.id));
    const liked = items.filter((it) => !it.paid && it.e.cover && !FEATURED.includes(it.e.id) && (stats[it.key]?.likes ?? 0) > 0).sort((a, b) => (stats[b.key]?.likes ?? 0) - (stats[a.key]?.likes ?? 0));
    return [...buyable, ...picks, ...liked].slice(0, 8);
  }, [items, stats]);

  const setTab = (t: Tab) => navigate(t === "browse" ? "/market" : `/market?tab=${t}`, { replace: true });
  const setFilter = (f: Filter) => navigate(f === "all" ? "/market" : `/market?kind=${f}`, { replace: true });
  const tabLabel: Record<Tab, string> = { browse: "Discover", library: "Yours", selling: "Selling" };
  const yoursCount = (data?.entries ?? []).filter((e) => e.installed && e.kind !== "theme").length + paid.entries.filter((e) => e.owned).length;
  const detail = !!want && (openFree || openPaid);

  // "/" searches; Esc takes a theme off, then leaves an entry's page.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t?.closest?.("input, textarea, select, [contenteditable=true]");
      if (document.querySelector("[role=dialog]")) return;
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && tab === "browse" && !detail) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "Escape") {
        if (typing) return void t!.blur();
        if (trying) return void (e.preventDefault(), takeOff());
        if (detail) return void (e.preventDefault(), leaveDetail());
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [tab, detail, trying, takeOff, filter]);

  const tryBar = trying && (
    <div className="mk-trybar" role="status" data-tryon={trying.id}>
      <span><ThemeSwatches theme={s_(trying).theme} />Trying on <b className="truncate">{trying.name}</b></span>
      <Button variant="outline" onClick={takeOff} data-tryoff>Take it off</Button>
      <Button onClick={() => void keep()} disabled={keeping} data-keep>{keeping && <Loader2 className="size-4 animate-spin" />}Keep it</Button>
    </div>
  );

  const repo = data?.repo ?? "";
  let body: React.ReactNode;
  if (detail && openFree) {
    body = (
      <EntryDetail
        key={`${openFree.kind}/${openFree.id}`}
        entry={openFree}
        all={data?.entries ?? []}
        repo={repo}
        inUse={openFree.kind === "theme" && openFree.installedIds[0] === data?.selectedTheme}
        trying={trying?.id === openFree.id && openFree.kind === "theme"}
        onTry={() => tryOn(openFree)}
        onKeep={() => void keep()}
        onBack={leaveDetail}
        onOpen={(e) => open({ paid: false, key: `${e.kind}/${e.id}`, e })}
        onInstalled={() => (void load(true), void reloadStats())}
        signedIn={paid.signedIn}
      />
    );
  } else if (detail && openPaid) {
    body = <PaidDetail key={openPaid.listing} entry={openPaid} signedIn={paid.signedIn} onBack={leaveDetail} onChanged={() => (void paid.reload(), void reloadStats())} />;
  } else {
    body = (
      <>
        <header className="mb-[18px] flex items-end gap-3.5">
          <div className="min-w-0 flex-1">
            <h1 className="mk-serif text-[34px] leading-[1.1] font-semibold max-md:text-[30px]">Market</h1>
            <p className="mt-2 max-w-[560px] text-[14.5px] leading-snug text-muted-foreground">
              {canShowPurchases() ? "Decks, card types and themes people made. Most of it is free." : "Decks, card types and themes people made, free to install."}{" "}
              {data && <a className="whitespace-nowrap underline decoration-muted-foreground/40 underline-offset-2 hover:text-foreground" href={`https://github.com/${data.repo}`} target="_blank" rel="noreferrer">Browse on GitHub</a>}
            </p>
          </div>
          <Button variant="ghost" size="icon" aria-label="Refresh" onClick={() => load(true)} disabled={refreshing}>
            <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
          </Button>
          {/* Publishing opens a pull request with the GitHub CLI on the desktop. */}
          {tab === "browse" && !serverless() && (
            <Button variant="outline" className="h-10 gap-1.5 shadow-[0_2px_0_var(--border)] max-md:w-10 max-md:px-0" onClick={() => setPublishing(true)} aria-label="Publish">
              <Upload className="size-4" /> <span className="max-md:hidden">Publish</span>
            </Button>
          )}
        </header>

        <nav className="mk-tabs" aria-label="Market sections" data-market-tabs>
          {tabs.map((t) => (
            <button key={t} onClick={() => setTab(t)} aria-current={tab === t ? "page" : undefined}>
              {tabLabel[t]}
              {t === "library" && yoursCount > 0 && <span>{yoursCount}</span>}
            </button>
          ))}
        </nav>

        {tab === "library" && <Yours data={data} showBought={paid.available || paid.signedIn} onOpen={(e) => open({ paid: false, key: `${e.kind}/${e.id}`, e })} onChanged={() => void load(true)} onThemes={() => setFilter("theme")} />}
        {tab === "selling" && <SellingView />}

        {tab === "browse" && (
          <>
            <label className="mk-search">
              <Search className="size-[18px]" />
              <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search decks, card types, themes" aria-label="Search the market" autoComplete="off" />
              {query ? <button type="button" aria-label="Clear search" onClick={() => (setQuery(""), searchRef.current?.focus())}><X className="size-4" /></button> : <kbd>/</kbd>}
            </label>
            <div className="mk-chips" role="group" aria-label="Kind">
              {(["all", "deck", "type", "theme"] as Filter[]).map((f) => (
                <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                  {f === "all" ? "All" : f === "type" ? "Card types" : `${KIND_LABEL[f]}s`}
                  {data && <span>{counts[f]}</span>}
                </button>
              ))}
            </div>

            {error ? (
              <section className="mk-panel mk-none">
                <h3 className="mk-serif">Can't reach the Market.</h3>
                <p>{error}. Everything you already installed still works; it lives on this device.</p>
                <div className="flex flex-wrap items-center gap-3"><Button variant="outline" onClick={() => load(true)}>Try again</Button><Button variant="ghost" onClick={() => setTab("library")}>See what you have</Button></div>
              </section>
            ) : !data ? (
              <>
                <Skeleton className="mb-10 h-72 rounded-[18px]" />
                <div className="grid gap-5 sm:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="aspect-[16/10] rounded-xl" />)}</div>
              </>
            ) : query || filter !== "all" ? (
              shown.length === 0 ? (
                <section className="mk-panel mk-none">
                  <h3 className="mk-serif">Nothing matches “{query}”.</h3>
                  <p>Try a shorter word, or make it yourself: anything you build in Etude can be published here.</p>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button variant="outline" onClick={() => (setQuery(""), setFilter("all"))}>Clear search</Button>
                    {!serverless() && <Button variant="ghost" onClick={() => setPublishing(true)}>Publish one</Button>}
                  </div>
                </section>
              ) : (
                <>
                  <div className="mk-results-head">
                    {shown.length} {shown.length === 1 ? "result" : "results"}{query && <> for “{query}”</>}
                    {filter !== "all" && <Button variant="ghost" size="sm" className="text-foreground" onClick={() => setFilter("all")}>Show everything</Button>}
                  </div>
                  <div className="mk-grid">{shown.map((it) => <AnyTile key={it.key} it={it} counts={stats[it.key]} onOpen={() => open(it)} onTry={tryOn} />)}</div>
                </>
              )
            ) : (
              <>
                <Featured items={featured} stats={stats} onOpen={open} onChanged={() => (void load(true), void reloadStats())} />
                <Shelf title="Decks" sub="Install one and it shows up in your Library." items={sorted(items.filter((it) => !it.paid && it.e.kind === "deck"))} stats={stats} onAll={() => setFilter("deck")} onOpen={open} onTry={tryOn} />
                <Shelf
                  title={canShowPurchases() ? "Paid decks" : "Your decks"}
                  sub={canShowPurchases() ? "From creators, sold on etude.study. The creator sets the price." : "Bought with your Etude account"}
                  items={items.filter((it) => it.paid)}
                  stats={stats}
                  onOpen={open}
                  onTry={tryOn}
                  data-paid-section
                />
                <Shelf title="Card types" sub="New kinds of cards. Try one here before you install it." items={sorted(items.filter((it) => !it.paid && it.e.kind === "type"))} stats={stats} onAll={() => setFilter("type")} onOpen={open} onTry={tryOn} />
                <Shelf title="Themes" sub="Try one on. Nothing changes until you keep it." items={sorted(items.filter((it) => !it.paid && it.e.kind === "theme"))} stats={stats} onAll={() => setFilter("theme")} onOpen={open} onTry={tryOn} themes />
              </>
            )}
          </>
        )}
      </>
    );
  }

  return (
    <Page wide className="mk-page">
      {tryBar}
      {want && !detail && data && (!want.startsWith("paid/") || paid.loaded) ? (
        <section className="mk-panel mk-none">
          <h3 className="mk-serif">That isn't in the Market anymore.</h3>
          <p>It may have been renamed or taken down.</p>
          <Button variant="outline" onClick={() => navigate("/market")}>Back to the Market</Button>
        </section>
      ) : want && !detail && !error ? (
        <Skeleton className="h-96 rounded-2xl" />
      ) : (
        body
      )}
      {publishing && <PublishDialog repo={repo} onClose={() => setPublishing(false)} />}
    </Page>
  );
}

// ------------------------------------------------------------------ discover

/** Featured: the big cards in one row that scrolls sideways, with dots under it and arrows on hover. */
function Featured({ items, stats, onOpen, onChanged }: { items: Item[]; stats: Record<string, EntryCounts>; onOpen(it: Item): void; onChanged(): void }) {
  const row = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(0);
  const hs = useHScroll(row, { dep: items.length });
  if (!items.length) return null;
  return (
    <section className={cn("mk-feat", items.length === 1 && "one")} aria-label="Featured" data-featured>
      <div className="mk-shelf-head">
        <div className="min-w-0 flex-1">
          <h2 className="mk-serif">Featured</h2>
          <p>Picked by the Etude team.</p>
        </div>
      </div>
      <div className="hs-wrap">
        <div className="mk-feat-row" ref={row} {...hs.rowProps} aria-label="Featured, scroll sideways" onScroll={() => row.current && setAt(nearestIndex(row.current))} data-featured-row>
          {items.map((it) => <Hero key={it.key} it={it} counts={stats[it.key]} onOpen={() => onOpen(it)} onChanged={onChanged} />)}
        </div>
        <HArrows edge={hs.edge} page={hs.page} label="featured" />
      </div>
      {items.length > 1 && (
        <div className="mk-feat-dots" role="tablist" aria-label="Featured">
          {items.map((it, i) => <button key={it.key} role="tab" aria-label={it.e.name} aria-current={i === at} aria-selected={i === at} onClick={() => hs.to(i)} />)}
        </div>
      )}
    </section>
  );
}

function Hero({ it, counts, onOpen, onChanged }: { it: Item; counts?: EntryCounts; onOpen(): void; onChanged(): void }) {
  const [busy, setBusy] = useState(false);
  const e = it.e;
  const stop = (x: React.MouseEvent) => x.stopPropagation();
  let cover: React.ReactNode, meta: string, btn: React.ReactNode, eyebrow: string;
  if (it.paid) {
    const p = it.e;
    cover = <img src={p.cover} alt="" />;
    meta = plural(p.summary?.items ?? 0, "card");
    eyebrow = canShowPurchases() && !p.owned ? "New · paid deck" : "Yours";
    btn = <Button className="mk-big gap-1.5" onClick={(x) => (stop(x), onOpen())}>{p.owned || !canShowPurchases() ? "Open" : `Buy · ${money(p.price, p.currency)}`}</Button>;
  } else {
    const f = it.e;
    cover = <EtudeImg src={api.marketCoverUrl(f.kind, f.id)} alt="" />;
    meta = metaLine(f);
    eyebrow = `Featured · ${KIND_LABEL[f.kind].toLowerCase()}`;
    const get = async () => {
      setBusy(true);
      try {
        const r = await api.marketInstall(f.id, f.kind);
        toast.success(`${r.result === "updated" ? "Updated" : "Installed"} ${f.name}`, { description: f.kind === "deck" ? "It's in your Library." : undefined });
        onChanged();
      } catch (err) {
        toast.error("Install failed", { description: (err as Error).message });
      } finally {
        setBusy(false);
      }
    };
    const goTo = () => navigate(f.kind === "deck" ? `/deck?name=${encodeURIComponent(s_(f).decks[0])}` : `/types/${encodeURIComponent(s_(f).types[0].id)}`);
    btn = f.installed === "installed"
      ? <Button className="mk-big" onClick={(x) => (stop(x), goTo())}>Open</Button>
      : <Button className="mk-big gap-1.5" disabled={busy} onClick={(x) => (stop(x), void get())}>{busy ? <Loader2 className="size-4 animate-spin" /> : f.installed === "update" ? <RefreshCw className="size-4" /> : <Check className="size-[18px]" strokeWidth={2.4} />}{f.installed === "update" ? "Update" : "Get it"}</Button>;
  }
  return (
    <div className="mk-hero" role="link" tabIndex={0} onClick={onOpen} onKeyDown={(x) => x.key === "Enter" && x.target === x.currentTarget && onOpen()} data-market-hero={it.key}>
      <div className="mk-hero-cover" data-hs-anchor>{cover}</div>
      <div className="mk-hero-text">
        <div className="mk-eyebrow">{eyebrow}</div>
        <h2 className="mk-serif">{e.name}</h2>
        <p>{pitch(e.description)}</p>
        <div className="mk-meta mb-[18px]">{meta}<span aria-hidden="true">·</span><By author={e.author} /><TileCounts c={counts} /></div>
        <div className="mk-actions">
          {btn}
          <Button variant="ghost" className="h-10 text-muted-foreground" onClick={(x) => (x.stopPropagation(), onOpen())}>Details</Button>
        </div>
      </div>
    </div>
  );
}

function Shelf({ title, sub, items, stats, onAll, onOpen, onTry, themes, ...rest }: { title: string; sub?: string; items: Item[]; stats: Record<string, EntryCounts>; onAll?(): void; onOpen(it: Item): void; onTry(e: MarketEntry): void; themes?: boolean; "data-paid-section"?: boolean }) {
  const row = useRef<HTMLDivElement>(null);
  const hs = useHScroll(row, { page: "view", dep: items.length });
  if (!items.length) return null;
  return (
    <section className={cn("mk-shelf", themes && "themes")} {...rest}>
      <div className="mk-shelf-head">
        <div className="min-w-0 flex-1">
          <h2 className="mk-serif">{title}</h2>
          {sub && <p>{sub}</p>}
        </div>
        {onAll && <Button variant="ghost" size="sm" className="text-foreground" onClick={onAll}>See all</Button>}
      </div>
      <div className="hs-wrap mk-row-wrap">
        <div className="mk-row" ref={row} {...hs.rowProps} aria-label={`${title}, scroll sideways`}>
          {items.map((it) => <AnyTile key={it.key} it={it} counts={stats[it.key]} onOpen={() => onOpen(it)} onTry={onTry} />)}
        </div>
        <HArrows edge={hs.edge} page={hs.page} label={title.toLowerCase()} />
      </div>
    </section>
  );
}

function AnyTile({ it, counts, onOpen, onTry }: { it: Item; counts?: EntryCounts; onOpen(): void; onTry(e: MarketEntry): void }) {
  return it.paid ? <PaidTile entry={it.e} counts={counts} onOpen={onOpen} /> : <EntryTile entry={it.e} counts={counts} onOpen={onOpen} onTry={() => onTry(it.e)} />;
}

function StateMark({ state }: { state: MarketEntry["installed"] }) {
  if (state === "installed") return <span className="mk-state"><Check className="size-3.5" strokeWidth={3} />Installed</span>;
  if (state === "update") return <span className="mk-state update">Update</span>;
  return <span className="mk-price">Free</span>;
}

/** The entry's cover: its image, its theme in miniature, or its first sample cards. */
function Cover({ entry }: { entry: MarketEntry }) {
  const s = s_(entry);
  if (entry.kind === "theme") return <ThemeMiniature theme={s.theme} />;
  if (entry.cover) return <EtudeImg src={api.marketCoverUrl(entry.kind, entry.id)} alt="" loading="lazy" />;
  const Icon = KIND_ICON[entry.kind];
  const samples: string[] = s.samples ?? [];
  return (
    <div className="flex size-full min-w-0 flex-col gap-2.5 overflow-hidden p-4">
      <div className="mk-eyebrow flex items-center gap-1.5"><Icon className="size-3.5" />{KIND_LABEL[entry.kind]}</div>
      <div className="flex min-h-0 flex-1 flex-col justify-center gap-1.5">
        {(samples.length ? samples : [entry.name]).slice(0, 2).map((line, i) => (
          <div key={i} className="mk-serif truncate rounded-md border bg-card px-3 py-2 text-[15px] text-card-foreground shadow-sm" style={{ marginLeft: i * 10, marginRight: -i * 10, opacity: 1 - i * 0.3 }}>{line}</div>
        ))}
      </div>
    </div>
  );
}

function EntryTile({ entry, counts, onOpen, onTry }: { entry: MarketEntry; counts?: EntryCounts; onOpen(): void; onTry(): void }) {
  const isTheme = entry.kind === "theme";
  return (
    <div role="link" tabIndex={0} className="mk-tile" onClick={onOpen} onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && onOpen()} data-entry={`${entry.kind}/${entry.id}`}>
      <div className="mk-cover" data-hs-anchor><Cover entry={entry} /></div>
      <div className="mk-tile-body">
        <div className="mk-tile-title"><b>{entry.name}</b><StateMark state={entry.installed} /></div>
        <p>{firstSentence(entry.description) || KIND_LABEL[entry.kind]}</p>
        <div className="mk-tile-meta">
          <span>{metaLine(entry)}</span>
          {!isTheme && !official(entry.author) && <><span aria-hidden="true">·</span><span>{entry.author}</span></>}
          <TileCounts c={counts} />
          {isTheme && <ThemeSwatches theme={s_(entry).theme} className={counts?.likes || counts?.downloads ? undefined : "ml-auto"} />}
        </div>
      </div>
      {isTheme ? (
        <button type="button" className="mk-try" onClick={(e) => (e.stopPropagation(), onTry())} data-try-on={entry.id}>Try it on</button>
      ) : entry.kind === "type" ? (
        <span className="mk-try" aria-hidden="true">Try it</span>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ yours

/** A theme at thumbnail size: four of its colours in a square. */
function Palette4({ theme }: { theme: Theme }) {
  const v = theme.vars;
  return (
    <span className="grid size-full grid-cols-2" aria-hidden="true">
      {[v["--background"], v["--highlight"] ?? v["--primary"], v["--card"], v["--again"]].map((c, i) => <i key={i} style={{ background: c }} />)}
    </span>
  );
}

function Yours({ data, showBought, onOpen, onChanged, onThemes }: { data: { selectedTheme: string; entries: MarketEntry[] } | null; showBought: boolean; onOpen(e: MarketEntry): void; onChanged(): void; onThemes(): void }) {
  const [busy, setBusy] = useState<string | null>(null);
  if (!data) return <Skeleton className="h-64 rounded-2xl" />;
  const inst = [...data.entries.filter((e) => e.installed && e.kind !== "theme")].sort((a, b) => featRank(a.id, false, a.kind) - featRank(b.id, false, b.kind));
  const themes = data.entries.filter((e) => e.installed && e.kind === "theme");
  const ups = inst.filter((e) => e.installed === "update");
  const install = async (list: MarketEntry[], key: string, use = false) => {
    setBusy(key);
    try {
      for (const e of list) {
        const r = await api.marketInstall(e.id, e.kind, { use });
        if (use && e.kind === "theme") {
          const t = await api.themes();
          const sel = t.themes.find((x) => x.id === r.ids[0]);
          if (sel) applyTheme(sel);
        }
      }
      toast.success(use ? `${list[0].name} is on` : list.length > 1 ? `Updated ${list.length}` : `Updated ${list[0].name}`, use ? undefined : { description: "Your reviews and scheduling stay as they are." });
      onChanged();
    } catch (e) {
      toast.error("That didn't work", { description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const goTo = (e: MarketEntry) => {
    const s = s_(e);
    if (e.kind === "deck") navigate(`/deck?name=${encodeURIComponent(s.decks[0])}`);
    else navigate(`/types/${encodeURIComponent(s.types[0].id)}`);
  };
  return (
    <div data-yours>
      {ups.length > 0 && (
        <div className="mk-panel mk-update" data-updates>
          <div>
            <b>{ups.length === 1 ? "1 update" : `${ups.length} updates`}</b>
            <span>{ups.map((e) => e.name).join(" and ")}. Your reviews and scheduling stay as they are.</span>
          </div>
          <Button className="mk-big" disabled={!!busy} onClick={() => void install(ups, "all")}>{busy === "all" && <Loader2 className="size-4 animate-spin" />}{ups.length === 1 ? "Update" : "Update all"}</Button>
        </div>
      )}
      {showBought && <LibraryView />}
      <section className="mk-lsec">
        <div className="mk-lhead"><span>Installed from the Market{inst.length > 0 && <i>{inst.length}</i>}</span></div>
        <div className="mk-panel mk-list">
          {inst.length === 0 && <div className="px-3 py-3 text-sm text-muted-foreground">Nothing yet. Decks and card types you install show up here.</div>}
          {inst.map((e) => (
            <div key={`${e.kind}/${e.id}`} className="mk-li" role="button" tabIndex={0} onClick={() => onOpen(e)} onKeyDown={(x) => x.key === "Enter" && x.target === x.currentTarget && onOpen(e)}>
              <div className="mk-li-thumb"><Cover entry={e} /></div>
              <div className="mk-li-text"><b>{e.name}</b><small>{metaLine(e)} · v{e.version}{e.installed === "update" && <em> · new version</em>}</small></div>
              <div className="mk-li-acts" onClick={(x) => x.stopPropagation()}>
                {e.installed === "update" ? (
                  <button className="mk-get" disabled={!!busy} onClick={() => void install([e], e.id)}>{busy === e.id ? <Loader2 className="size-4 animate-spin" /> : "Update"}</button>
                ) : (
                  <button className="mk-get ghost" onClick={() => goTo(e)}>Open</button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="mk-lsec">
        <div className="mk-lhead"><span>Themes{themes.length > 0 && <i>{themes.length}</i>}</span><Button variant="ghost" size="sm" className="text-foreground" onClick={onThemes}>Browse themes</Button></div>
        <div className="mk-panel mk-list">
          {themes.length === 0 && <div className="px-3 py-3 text-sm text-muted-foreground">You're on {currentTheme().name}. Themes you install from the Market show up here.</div>}
          {themes.map((e) => {
            const inUse = e.installedIds[0] === data.selectedTheme;
            return (
              <div key={e.id} className="mk-li" role="button" tabIndex={0} onClick={() => onOpen(e)} onKeyDown={(x) => x.key === "Enter" && x.target === x.currentTarget && onOpen(e)}>
                <div className="mk-li-thumb"><Palette4 theme={s_(e).theme} /></div>
                <div className="mk-li-text"><b>{e.name}</b><small>{metaLine(e)}{e.installed === "update" && <em> · new version</em>}</small></div>
                <div className="mk-li-acts" onClick={(x) => x.stopPropagation()}>
                  <button className={cn("mk-get", inUse && "ghost")} disabled={inUse || !!busy} onClick={() => void install([e], e.id, true)}>{busy === e.id ? <Loader2 className="size-4 animate-spin" /> : inUse ? "In use" : "Use"}</button>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ detail

function EntryDetail({ entry, all, repo, inUse, trying, signedIn, onTry, onKeep, onBack, onOpen, onInstalled }: { entry: MarketEntry; all: MarketEntry[]; repo: string; inUse: boolean; trying: boolean; signedIn: boolean; onTry(): void; onKeep(): void; onBack(): void; onOpen(e: MarketEntry): void; onInstalled(): void }) {
  const [file, setFile] = useState<MarketFile | null>(null);
  const [busy, setBusy] = useState<null | "install" | "use">(null);
  const s = s_(entry);
  const sKey = `${entry.kind}/${entry.id}`;
  const [stats, setStats] = useEntryStats(sKey);

  useEffect(() => {
    if (entry.kind === "type") api.marketEntry(entry.kind, entry.id).then(setFile).catch((e) => toast.error("Couldn't load the card type", { description: (e as Error).message }));
  }, [entry.kind, entry.id]);

  const install = async (use = false) => {
    setBusy(use ? "use" : "install");
    try {
      const r = await api.marketInstall(entry.id, entry.kind, { use });
      if (entry.kind === "theme" && use) {
        const t = await api.themes();
        const sel = t.themes.find((x) => x.id === r.ids[0]);
        if (sel) applyTheme(sel);
      }
      const what = entry.kind === "theme" ? "theme" : entry.kind === "deck" ? "deck" : "card type";
      toast.success(r.result === "unchanged" ? `You already have the latest ${what}` : `${r.result === "updated" ? "Updated" : "Installed"} ${entry.name}`, {
        description:
          entry.kind === "theme"
            ? use ? "It's on now." : "Pick it in Settings → Appearance."
            : `${r.report.items.created} new, ${r.report.items.updated} updated item${r.report.items.updated === 1 ? "" : "s"}${r.report.types.created ? `, ${plural(r.report.types.created, "card type")}` : ""}.`,
      });
      onInstalled();
    } catch (e) {
      toast.error("Install failed", { description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const goTo = () => {
    if (entry.kind === "deck") navigate(`/deck?name=${encodeURIComponent(s.decks[0])}`);
    else if (entry.kind === "type") navigate(`/types/${encodeURIComponent(s.types[0].id)}`);
    else navigate("/settings#appearance");
  };

  const spin = <Loader2 className="size-4 animate-spin" />;
  let actions: React.ReactNode;
  if (entry.kind === "theme") {
    actions = (
      <>
        {inUse ? (
          <Button className="mk-big gap-1.5" disabled><Check className="size-4" />In use</Button>
        ) : trying ? (
          <Button className="mk-big" onClick={onKeep} data-keep-detail>Keep it</Button>
        ) : (
          <Button className="mk-big" onClick={onTry} data-try-on={entry.id}>Try it on</Button>
        )}
        {!inUse && (
          <Button variant="outline" className="mk-big gap-1.5" disabled={!!busy} onClick={() => install(true)}>
            {busy === "use" ? spin : <Download className="size-4" />}
            {entry.installed === "installed" ? "Use" : entry.installed === "update" ? "Update and use" : "Install and use"}
          </Button>
        )}
      </>
    );
  } else if (entry.installed === "installed") {
    actions = <Button className="mk-big" onClick={goTo}>{entry.kind === "deck" ? "Open in Library" : "Open"}</Button>;
  } else if (entry.installed === "update") {
    actions = (
      <>
        <Button className="mk-big gap-1.5" disabled={!!busy} onClick={() => install(false)}>{busy ? spin : <RefreshCw className="size-4" />}Update to v{entry.version}</Button>
        <Button variant="outline" className="mk-big" onClick={goTo}>Open</Button>
      </>
    );
  } else {
    actions = (
      <Button className="mk-big gap-2" disabled={!!busy} onClick={() => install(false)} data-install={entry.id}>
        {busy ? spin : <Download className="size-4" />}Get it<span className="rounded-[5px] bg-primary-foreground/20 px-1.5 py-0.5 text-[12.5px] font-semibold opacity-80">Free</span>
      </Button>
    );
  }

  const p = parts(entry.kind === "deck" ? s.decks : []);
  const types: { id: string; name: string }[] = entry.kind === "deck" ? s.types : [];
  // The numbers row, App Store style: what people think first, then what you get, then the file facts.
  const info: InfoCell[] = [...socialCells(stats)];
  // Parts and card types have their own sections below, so the row only counts the cards.
  if (entry.kind === "deck") info.push({ label: s.items === 1 ? "Card" : "Cards", value: Number(s.items).toLocaleString("en-US") });
  if (entry.kind === "type") info.push({ label: "Checks", value: (s.types as any[]).map((t) => GRADER_WORD[t.grader] ?? t.grader).join(", ") });
  if (entry.kind === "theme") info.push({ label: "Look", value: s.theme.scheme === "light" ? "Light" : "Dark" });
  info.push({ label: "Size", value: kb(entry.bytes) });
  if (entry.updated) info.push({ label: "Updated", value: niceDate(entry.updated) });
  info.push({ label: "Version", value: `v${entry.version}` });

  return (
    <DetailLayout
      onBack={onBack}
      head={
        <>
          <div className="mk-eyebrow">{KIND_LABEL[entry.kind]}</div>
          <h1 className="mk-serif">{entry.name}</h1>
          <div className="mk-by">
            by <By author={entry.author} />
            {entry.installed === "installed" && <span className="mk-pill"><Check className="size-3" strokeWidth={3} />Installed</span>}
            {entry.installed === "update" && <span className="mk-pill update"><RefreshCw className="size-3" />Update</span>}
          </div>
        </>
      }
      gallery={<MarketGallery entry={entry} cover={entry.kind === "theme" ? <div className="mk-theme-big"><ThemeMiniature theme={s.theme} /></div> : <Cover entry={entry} />} />}
      actions={
        <>
          <div className="mk-actions">{actions}</div>
          <Votes k={sKey} stats={stats} setStats={setStats} signedIn={signedIn} />
          {entry.kind === "theme" && !entry.installed && <Button variant="link" className="h-auto basis-full justify-start p-0 text-xs text-muted-foreground" disabled={!!busy} onClick={() => install(false)}>Install without changing my theme</Button>}
          {entry.kind === "theme" && <p className="mk-fine">Try it on to see the whole app in it. Nothing changes until you keep it.</p>}
        </>
      }
      info={info}
    >
      <section id="market-about" className="mk-sec">
        <h3 className="mk-serif">About this {entry.kind === "type" ? "card type" : entry.kind}</h3>
        {paragraphs(entry.description || "No description yet.").map((x, i) => <p key={i}>{x}</p>)}
      </section>
      {p.length > 1 && (
        <section className="mk-sec">
          <h3 className="mk-serif">What's inside</h3>
          <div className="mk-parts">{p.map((x, i) => <span key={i}>{x}</span>)}</div>
        </section>
      )}
      {types.length > 0 && (
        <section className="mk-sec">
          <h3 className="mk-serif">Comes with {types.length === 1 ? "a card type" : `${types.length} card types`}</h3>
          <div className="mk-parts">
            {types.map((t) => {
              const m = all.find((x) => x.kind === "type" && (x.summary as any).types?.[0]?.id === t.id);
              return m ? <button key={t.id} onClick={() => onOpen(m)}>{t.name}<ChevronRight className="size-3.5" /></button> : <span key={t.id}>{t.name}</span>;
            })}
          </div>
        </section>
      )}
      {entry.kind === "type" && (
        <section className="mk-sec">
          <h3 className="mk-serif">Try it</h3>
          <TypePreview file={file} />
        </section>
      )}
      <Comments k={sKey} signedIn={signedIn} onCount={(d) => stats && setStats({ ...stats, comments: Math.max(0, stats.comments + d) })} />
      <div className="mk-source">
        <a href={`https://github.com/${repo}/blob/main/${entry.path}`} target="_blank" rel="noreferrer"><ExternalLink className="size-4" />See the files on GitHub</a>
        {entry.tags.length > 0 && <span>{entry.tags.slice(0, 6).map((t) => `#${t}`).join(" ")}</span>}
      </div>
    </DetailLayout>
  );
}

/** The type's first example card, running for real: try it before installing. */
function TypePreview({ file }: { file: MarketFile | null }) {
  const def: CardType | undefined = file?.content.types?.[0];
  const sample = useMemo(() => file?.content.items?.find((i: any) => i.type === def?.id)?.fields ?? {}, [file, def?.id]);
  const [html, setHtml] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!def) return;
    api.frameHtml(def).then((r) => setHtml(r.html)).catch((e) => setErr((e as Error).message));
  }, [def]);
  const load = useCallback(async (seed: number, face: string) => {
    if (!def) return null;
    const r = await api.previewType(def, sample, { seed, face });
    if (!r.view) throw new Error(r.errors.join("\n"));
    return { view: r.view, key: r.key ?? {}, seed: r.seed ?? seed };
  }, [def, sample]);
  const grade = useCallback(async (answer: unknown, d: { seed: number }) => {
    if (!def) return null;
    const r = await api.previewType(def, sample, { seed: d.seed, answer });
    return r.grade ?? null;
  }, [def, sample]);
  if (err) return <div className="rounded-xl border p-4 text-sm text-destructive">{err}</div>;
  if (!def || !html) return <Skeleton className="h-72 rounded-xl" />;
  return (
    <div data-type-preview>
      <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground"><Eye className="size-3.5" /> This preview runs the card here and saves nothing.</div>
      <CardPreview html={html} version={`market:${def.id}`} load={load} faces={def.faces} generated={!!def.prepare} grade={def.grader.kind === "script" || def.grader.kind === "hybrid" ? grade : undefined} />
    </div>
  );
}

// ------------------------------------------------------------------ publish

function PublishDialog({ repo, onClose }: { repo: string; onClose(): void }) {
  const [kind, setKind] = useState<MarketKind>("deck");
  const [options, setOptions] = useState<Record<MarketKind, { value: string; label: string }[]> | null>(null);
  const [ref, setRef] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [version, setVersion] = useState("1");
  const [author, setAuthor] = useState("");
  const [gh, setGh] = useState<{ ok: boolean; login?: string; reason?: string } | null>(null);
  const [preview, setPreview] = useState<PublishResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<PublishResult | null>(null);

  useEffect(() => {
    api.publishStatus().then(setGh).catch(() => setGh({ ok: false, reason: "couldn't check gh" }));
    Promise.all([api.themes(), api.decks(), api.types()]).then(([t, d, ty]) => {
      setOptions({
        theme: t.themes.filter((x) => !x.builtin).map((x) => ({ value: x.id, label: x.name })),
        deck: d.filter((x) => x.cards > 0).map((x) => ({ value: x.name, label: `${"  ".repeat(x.depth)}${x.name.split("::").pop()}` })),
        type: ty.filter((x) => !x.builtin).map((x) => ({ value: x.id, label: `${x.name} (${x.id})` })),
      });
    });
  }, []);

  useEffect(() => {
    setRef("");
    setPreview(null);
    setProblem(null);
  }, [kind]);

  const input = () => ({ kind, ref, name: name || undefined, description: description || undefined, author: author || undefined, version: version || undefined, tags: tags.split(/[,\s]+/).filter(Boolean) });

  // Check the submission as it's filled in, so problems show before anything is sent.
  useEffect(() => {
    if (!ref) return;
    let live = true;
    const t = setTimeout(async () => {
      try {
        const r = await api.publish({ ...input(), dryRun: true });
        if (!live) return;
        setPreview(r);
        setProblem(null);
      } catch (e) {
        if (!live) return;
        setPreview(null);
        setProblem((e as Error).message);
      }
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [kind, ref, name, description, tags, version, author]);

  const send = async () => {
    setSending(true);
    try {
      const r = await api.publish(input());
      setDone(r);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      toast.error("Couldn't open the pull request", { description: msg });
    } finally {
      setSending(false);
    }
  };

  const saveFile = async () => {
    const r = await api.publish({ ...input(), dryRun: true, full: true });
    if (r.file) download(`${r.file.id}.json`, r.file);
  };

  const list = options?.[kind] ?? [];

  if (done) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Pull request opened</DialogTitle>
            <DialogDescription>
              {done.entry.name} goes live for everyone once it's reviewed and merged{done.fork ? `. It came from your fork ${done.fork}` : ""}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>Close</Button>
            <Button className="gap-1.5" asChild>
              <a href={done.url} target="_blank" rel="noreferrer"><GitPullRequest className="size-4" /> See #{done.number}</a>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Publish to the market</DialogTitle>
          <DialogDescription>
            This opens a pull request on <span className="text-foreground">{repo}</span>. Decks go without your review history.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <ToggleGroup type="single" variant="outline" value={kind} onValueChange={(v) => v && setKind(v as MarketKind)} className="w-full">
            {(["deck", "type", "theme"] as MarketKind[]).map((k) => {
              const Icon = KIND_ICON[k];
              return (
                <ToggleGroupItem key={k} value={k} className="flex-1 gap-1.5 text-[13px]">
                  <Icon className="size-4" /> {KIND_LABEL[k]}
                </ToggleGroupItem>
              );
            })}
          </ToggleGroup>

          <Field label={kind === "deck" ? "Deck" : kind === "type" ? "Card type" : "Theme"} hint={list.length === 0 && options ? (kind === "theme" ? "Make a custom theme in Settings → Appearance first." : kind === "type" ? "Only your own card types can be published." : "No decks with cards yet.") : undefined}>
            <Select value={ref} onValueChange={setRef} disabled={!list.length}>
              <SelectTrigger className="h-10 w-full"><SelectValue placeholder={options ? "Choose one" : "Loading…"} /></SelectTrigger>
              <SelectContent>
                {list.map((o) => <SelectItem key={o.value} value={o.value}><span className="whitespace-pre">{o.label}</span></SelectItem>)}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Name" hint="Shown in the market. Leave empty to use its current name.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={preview?.entry.name} className="h-10" />
          </Field>
          <Field label="Description">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder={preview?.entry.description || "What it is and who it's for"} rows={3} />
          </Field>
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <Field label="Tags" hint="Separated by spaces or commas.">
              <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="beginner, dark, music" className="h-10" />
            </Field>
            <Field label="Version">
              <Input value={version} onChange={(e) => setVersion(e.target.value)} className="h-10 w-20" />
            </Field>
          </div>
          <Field label="Credit as" hint={gh?.ok ? `Default: your GitHub login, ${gh.login}.` : undefined}>
            <Input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder={gh?.login ?? "your name"} className="h-10" />
          </Field>

          {problem && <p className="rounded-md border border-destructive/30 px-3 py-2 text-[13px] text-destructive">{problem}</p>}
          {preview && (
            <p className="text-[13px] text-muted-foreground">
              Adds <code className="text-foreground">{preview.path}</code> ({kb(preview.bytes)}).
            </p>
          )}
          {gh && !gh.ok && (
            <p className="rounded-md border px-3 py-2 text-[13px] text-muted-foreground">
              To open the pull request from here, Etude needs the GitHub CLI signed in on the machine running it ({gh.reason}). You can also save the file and add it on GitHub yourself.
            </p>
          )}
        </div>

        <DialogFooter className="sticky -bottom-[calc(1.25rem+env(safe-area-inset-bottom))] -mx-5 -mb-[calc(1.25rem+env(safe-area-inset-bottom))] gap-2 border-t bg-background/95 px-5 pt-3 pb-[calc(1.25rem+env(safe-area-inset-bottom))] backdrop-blur sm:-bottom-6 sm:-mx-6 sm:-mb-6 sm:px-6 sm:pb-6">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          {preview && (
            <Button variant="outline" className="gap-1.5" onClick={saveFile}>
              <Download className="size-4" /> Save file
            </Button>
          )}
          {gh && !gh.ok && preview ? (
            <Button className="gap-1.5" asChild>
              <a href={preview.manualUrl} target="_blank" rel="noreferrer"><ExternalLink className="size-4" /> Add on GitHub</a>
            </Button>
          ) : (
            <Button className="gap-1.5" disabled={!preview || sending || !gh?.ok} onClick={send}>
              {sending ? <Loader2 className="size-4 animate-spin" /> : <GitPullRequest className="size-4" />} Open pull request
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
