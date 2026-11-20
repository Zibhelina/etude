// Recursive Deck Home: any deck or subdeck can open a built-in Catalog or its own sandboxed
// `home.html` (World Map, song browser, lesson path, tactic hub). Subdecks open recursively into
// their own home (or straight into Study when they use the default queue).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Folder, Play, Search, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Breadcrumb, EmptyState, Page } from "@/components/page";
import { DeckIcon } from "@/components/deck-icon";
import { api, type DeckHomeData, type DeckHomeSubdeck } from "@/lib/api";
import { navigate } from "@/lib/router";
import { pageScheme, THEME_EVENT, useScheme } from "@/lib/theme";
import { etudeFetch, isLocal } from "@/lib/transport";
import { cn } from "@/lib/utils";

const enc = encodeURIComponent;
const NONCE_PLACEHOLDER = 'nonce="%ETUDE_NONCE%"';
const withPageNonce = (html: string) => html.replaceAll(NONCE_PLACEHOLDER, `nonce="${(globalThis as { __etudeFrameNonce?: string }).__etudeFrameNonce ?? ""}"`);

const THEME_VARS = [
  "--background", "--foreground", "--card", "--card-foreground", "--popover", "--popover-foreground", "--muted",
  "--muted-foreground", "--secondary", "--secondary-foreground", "--border", "--input", "--primary", "--primary-foreground",
  "--accent", "--accent-foreground", "--ring", "--destructive", "--success", "--warning", "--danger", "--highlight",
  "--again", "--hard", "--good", "--easy", "--new", "--learn", "--review", "--radius", "--font-sans", "--font-mono",
];

function homeTheme() {
  const cs = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (const v of THEME_VARS) {
    const val = cs.getPropertyValue(v).trim();
    if (val) vars[v] = val;
  }
  return { scheme: pageScheme(), vars };
}

/** Compact label for a card's scheduler state / progress in the built-in Catalog view. */
function progressBadge(c: DeckHomeData["cards"][number]): string {
  const p = c.progress as Record<string, unknown> | null;
  if (p && typeof p === "object") {
    if (typeof p.stars === "number") return `${"★".repeat(Math.min(5, Math.max(0, Math.round(p.stars))))}`;
    if (typeof p.box === "number") return `Box ${p.box}`;
    if (typeof p.level === "number") return `Lv ${p.level}`;
    if (typeof p.pct === "number") return `${Math.round(p.pct)}%`;
  }
  if (c.state === 0) return "New";
  if (c.reps > 0) return `${c.reps}×`;
  return "";
}

function openSubdeck(sub: Pick<DeckHomeSubdeck, "name" | "home" | "mode">) {
  if (sub.mode === "watch") navigate(`/watch?deck=${enc(sub.name)}`);
  else if (sub.home !== "queue") navigate(`/home?deck=${enc(sub.name)}`);
  else navigate(`/study?deck=${enc(sub.name)}`);
}

/** Sandboxed iframe host for a custom `home.html` Deck Home. */
function DeckHomeFrame({
  data,
  onOpenDeck,
  onOpenCard,
  onStudy,
}: {
  data: DeckHomeData;
  onOpenDeck(name: string): void;
  onOpenCard(cardId: number): void;
  onStudy(opts: { deck?: string; q?: string; ahead?: boolean }): void;
}) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(320);
  const [loaded, setLoaded] = useState(false);
  const latest = useRef({ data, onOpenDeck, onOpenCard, onStudy });
  latest.current = { data, onOpenDeck, onOpenCard, onStudy };
  const src = `/frame-home/${enc(data.deck.name)}`;
  const local = isLocal();
  const [localHtml, setLocalHtml] = useState<string | null>(null);
  const scheme = useScheme();

  const post = useCallback((msg: Record<string, unknown>, transfer: Transferable[] = []) => {
    iframe.current?.contentWindow?.postMessage({ etude: 1, ...msg }, "*", transfer);
  }, []);

  useEffect(() => {
    if (!local) return;
    let live = true;
    setLocalHtml(null);
    etudeFetch(src)
      .then((r) => r.text())
      .then((html) => live && setLocalHtml(html))
      .catch((e) => toast.error(String(e?.message ?? e)));
    return () => {
      live = false;
    };
  }, [local, src]);

  useEffect(() => {
    if (!loaded) return;
    post({ type: "update", deck: data.deck, subdecks: data.subdecks, cards: data.cards, stats: data.stats });
  }, [loaded, data, post]);

  useEffect(() => {
    setLoaded(false);
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframe.current?.contentWindow) return;
      const msg = e.data;
      if (!msg || msg.etude !== 1) return;
      const cur = latest.current;
      switch (msg.type) {
        case "loaded": {
          const typeId = cur.data.deck.typeId;
          const prefsPromise = typeId ? api.typePrefs(typeId).catch(() => ({})) : Promise.resolve({});
          prefsPromise.then((prefs) =>
            post({ type: "init", deck: cur.data.deck, subdecks: cur.data.subdecks, cards: cur.data.cards, stats: cur.data.stats, prefs, theme: homeTheme() }),
          );
          break;
        }
        case "mounted":
          setLoaded(true);
          break;
        case "size":
          if (typeof msg.height === "number") setHeight(Math.max(200, Math.min(msg.height + 8, 8000)));
          break;
        case "open-deck": {
          const target = typeof msg.deck === "string" ? msg.deck.trim() : "";
          if (!target) break;
          // Only allow navigating to this deck, its subdecks, or its direct parent.
          const self = cur.data.deck.name;
          const ok = target === self || target.startsWith(self + "::") || target === cur.data.deck.parent;
          if (ok) cur.onOpenDeck(target);
          break;
        }
        case "open-card": {
          const id = Number(msg.cardId);
          if (Number.isInteger(id) && cur.data.cards.some((c) => c.cardId === id)) cur.onOpenCard(id);
          break;
        }
        case "study": {
          const target = typeof msg.deck === "string" && msg.deck.trim() ? msg.deck.trim() : cur.data.deck.name;
          const self = cur.data.deck.name;
          if (target !== self && !target.startsWith(self + "::")) break;
          cur.onStudy({ deck: target, q: typeof msg.q === "string" ? msg.q : undefined, ahead: msg.ahead === true });
          break;
        }
        case "set-pref": {
          const typeId = cur.data.deck.typeId;
          if (typeId && typeof msg.key === "string") void api.setTypePref(typeId, msg.key, msg.value ?? null).catch(() => {});
          break;
        }
        case "error":
          toast.error(String(msg.message ?? "Deck home error"));
          break;
        case "get": {
          const req = msg.req;
          let path = "";
          try {
            const u = new URL(String(msg.url), location.href);
            path = u.pathname + u.search;
          } catch {}
          if (!isLocal() || !/^\/(media|type-assets)\//.test(path)) {
            post({ type: "bytes", req, error: "not allowed" });
            break;
          }
          const assetType = /^\/type-assets\/([^/?#]+)\//.exec(path)?.[1];
          const own = cur.data.deck.typeId;
          if (assetType && own && decodeURIComponent(assetType) !== own) {
            post({ type: "bytes", req, error: "not allowed" });
            break;
          }
          etudeFetch(path)
            .then(async (r) => {
              const body = await r.arrayBuffer();
              post({ type: "bytes", req, status: r.status, contentType: r.headers.get("content-type") ?? "", body }, [body]);
            })
            .catch((err) => post({ type: "bytes", req, error: String(err?.message ?? err) }));
          break;
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [data.deck.name, post]);

  useEffect(() => {
    const onTheme = () => post({ type: "theme", theme: homeTheme() });
    window.addEventListener(THEME_EVENT, onTheme);
    return () => window.removeEventListener(THEME_EVENT, onTheme);
  }, [post]);

  return (
    <iframe
      key={data.deck.name}
      ref={iframe}
      title={`${data.deck.title} home`}
      sandbox="allow-scripts"
      src={local ? undefined : src}
      srcDoc={local && localHtml !== null ? withPageNonce(localHtml) : undefined}
      className="block w-full border-0 bg-transparent"
      style={{ height, colorScheme: scheme }}
    />
  );
}

export function DeckHomePage({ name }: { name: string }) {
  const [data, setData] = useState<DeckHomeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const r = await api.deckHome(name);
      setData(r);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [name]);

  useEffect(() => {
    reload();
    const onFocus = () => reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);

  const tags = useMemo(() => {
    if (!data) return [];
    const counts = new Map<string, number>();
    for (const c of data.cards) for (const t of c.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
  }, [data]);

  const filteredCards = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.cards.filter((c) => {
      if (tag && !c.tags.includes(tag)) return false;
      if (!q) return true;
      return c.title.toLowerCase().includes(q) || c.face.toLowerCase().includes(q) || c.tags.some((t) => t.toLowerCase().includes(q));
    });
  }, [data, query, tag]);

  if (error) {
    return (
      <Page>
        <EmptyState title="Couldn't open this deck home" action={<Button variant="outline" size="sm" onClick={() => navigate("/")}>Back to decks</Button>}>
          {error}
        </EmptyState>
      </Page>
    );
  }
  if (!data) {
    return (
      <Page>
        <div className="h-4 w-40 animate-pulse rounded bg-muted" />
        <div className="mt-4 h-8 w-64 animate-pulse rounded bg-muted" />
        <div className="mt-6 h-48 animate-pulse rounded-xl bg-muted/60" />
      </Page>
    );
  }

  const parts = data.deck.name.split("::");
  const crumbs = [
    { label: "Decks", onClick: () => navigate("/") },
    ...parts.slice(0, -1).map((p, i) => {
      const target = parts.slice(0, i + 1).join("::");
      return {
        label: p,
        onClick: async () => {
          try {
            const parentHome = await api.deckHome(target);
            navigate(parentHome.deck.home !== "queue" ? `/home?deck=${enc(target)}` : `/deck?name=${enc(target)}`);
          } catch {
            navigate(`/deck?name=${enc(target)}`);
          }
        },
      };
    }),
  ];

  const handleOpenDeck = async (target: string) => {
    const sub = data.subdecks.find((s) => s.name === target);
    if (sub) return openSubdeck(sub);
    try {
      const targetHome = await api.deckHome(target);
      navigate(targetHome.deck.home !== "queue" ? `/home?deck=${enc(target)}` : `/study?deck=${enc(target)}`);
    } catch {
      navigate(`/study?deck=${enc(target)}`);
    }
  };

  return (
    <Page>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Breadcrumb items={crumbs} />
          <div className="mt-1.5 flex items-center gap-2.5">
            {data.deck.icon && <DeckIcon icon={data.deck.icon} size={28} />}
            <h1 className="text-[24px] font-semibold tracking-tight">{data.deck.title}</h1>
          </div>
          {data.deck.description && <p className="mt-1 text-[14px] text-muted-foreground">{data.deck.description}</p>}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate(`/deck?name=${enc(data.deck.name)}`)}>
            <SlidersHorizontal className="size-3.5" />
            Manage
          </Button>
          <Button size="sm" className="gap-1.5" onClick={() => navigate(`/study?deck=${enc(data.deck.name)}`)}>
            <Play className="size-3.5" />
            Study queue
          </Button>
        </div>
      </div>

      <div className="mt-6">
        {data.deck.home === "custom" ? (
          <DeckHomeFrame
            data={data}
            onOpenDeck={handleOpenDeck}
            onOpenCard={(cardId) => navigate(`/study?deck=${enc(data.deck.name)}&card=${cardId}`)}
            onStudy={({ deck, q, ahead }) => {
              const p = new URLSearchParams();
              p.set("deck", deck ?? data.deck.name);
              if (q) p.set("q", q);
              if (ahead) p.set("ahead", "1");
              navigate(`/study?${p}`);
            }}
          />
        ) : (
          <div className="space-y-6" data-deck-home="catalog">
            {data.subdecks.length > 0 && (
              <section>
                <h2 className="mb-2.5 text-[12px] font-semibold tracking-wide uppercase text-muted-foreground">Sections</h2>
                <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                  {data.subdecks.map((sub) => {
                    const due = sub.new + sub.learning + sub.review;
                    return (
                      <button
                        key={sub.name}
                        type="button"
                        onClick={() => openSubdeck(sub)}
                        className="group flex items-center gap-3 rounded-xl border border-border bg-card p-3.5 text-left transition-colors hover:bg-accent/60"
                      >
                        {sub.icon ? <DeckIcon icon={sub.icon} size={28} /> : <Folder className="size-5 shrink-0 text-muted-foreground" />}
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[14.5px] font-semibold">{sub.title}</div>
                          <div className="mt-0.5 text-[12.5px] text-muted-foreground">
                            {sub.cards} {sub.cards === 1 ? "card" : "cards"}
                            {due > 0 ? ` · ${due} due` : ""}
                          </div>
                        </div>
                        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            {data.cards.length > 0 && (
              <section>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <div className="relative min-w-[200px] flex-1">
                    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter cards…" className="h-9 pl-8 text-[13.5px]" />
                  </div>
                  {tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        onClick={() => setTag(null)}
                        className={cn("rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors", tag === null ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-accent")}
                      >
                        All
                      </button>
                      {tags.slice(0, 12).map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => setTag(tag === t ? null : t)}
                          className={cn("rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors", tag === t ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-accent")}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                  {filteredCards.map((c) => {
                    const badge = progressBadge(c);
                    return (
                      <button
                        key={c.cardId}
                        type="button"
                        onClick={() => navigate(`/study?deck=${enc(data.deck.name)}&card=${c.cardId}`)}
                        className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-accent/50"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[14px] font-medium">{c.title || c.itemId}</div>
                          {(c.face !== "main" || c.tags.length > 0) && (
                            <div className="mt-0.5 truncate text-[12px] text-muted-foreground">
                              {c.face !== "main" ? c.face : ""}
                              {c.face !== "main" && c.tags.length > 0 ? " · " : ""}
                              {c.tags.join(" · ")}
                            </div>
                          )}
                        </div>
                        {badge && <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-[12px] font-medium tabular-nums">{badge}</span>}
                        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                      </button>
                    );
                  })}
                  {filteredCards.length === 0 && <div className="px-4 py-8 text-center text-[13.5px] text-muted-foreground">No matching cards.</div>}
                </div>
              </section>
            )}

            {data.subdecks.length === 0 && data.cards.length === 0 && (
              <EmptyState title="Empty deck" action={<Button variant="outline" size="sm" onClick={() => navigate(`/deck?name=${enc(data.deck.name)}`)}>Add cards</Button>}>
                Add cards or subdecks to populate this deck home.
              </EmptyState>
            )}
          </div>
        )}
      </div>
    </Page>
  );
}
