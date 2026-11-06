// A deck's picture (an illustration, one emoji, an image of your own, the count rings, or nothing) and the Change icon picker.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, Search } from "lucide-react";
import { toast } from "sonner";
import { api, type DeckNode } from "@/lib/api";
import { cn } from "@/lib/utils";
import { artUrl, DECK_ART, EMOJI_SUGGESTIONS, parseDeckIcon } from "@/lib/deck-icons";
import { leafOf } from "@/components/move-deck";
import { DeckRing } from "@/components/deck-ring";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/** The icon at `size` px, or nothing when the deck has none. */
export function DeckIcon({ icon, size = 48, className }: { icon: string | null | undefined; size?: number; className?: string }) {
  const v = parseDeckIcon(icon);
  if (!v) return null;
  return (
    <span aria-hidden className={cn("inline-flex shrink-0 items-center justify-center select-none", className)} style={{ width: size, height: size }}>
      {v.kind === "art" ? (
        <img src={v.src} alt="" draggable={false} className="size-full object-contain" />
      ) : v.kind === "media" ? (
        <img src={v.src} alt="" draggable={false} className="size-full rounded-[24%] object-cover" />
      ) : (
        <span className="leading-none" style={{ fontSize: Math.round(size * 0.72) }}>{v.emoji}</span>
      )}
    </span>
  );
}

type Tab = "none" | "default" | "emoji" | "image" | "art";
const TABS: [Tab, string][] = [["none", "None"], ["default", "Default"], ["emoji", "Emoji"], ["image", "Image"], ["art", "Illustration"]];
const tabOf = (icon: string | null): Tab => (icon === "none" ? "none" : icon?.startsWith("emoji:") ? "emoji" : icon?.startsWith("media:") ? "image" : icon?.startsWith("art:") ? "art" : "default");
const IMAGE_TYPES = ".png,.jpg,.jpeg,.gif,.webp,.avif,.svg,.bmp";
const MAX_ICON_BYTES = 8 * 1024 * 1024;

/** The badge a deck shows in the Library for a stored icon: its picture, the count rings by default, or nothing for `none`. */
export function DeckBadge({ icon, d, size = 46 }: { icon: string | null | undefined; d: Pick<DeckNode, "new" | "learning" | "review" | "cards" | "mode">; size?: number }) {
  if (icon === "none") return null;
  return parseDeckIcon(icon) ? <DeckIcon icon={icon} size={size} className="lib-art" /> : <DeckRing d={d} size={size} />;
}

const SAMPLE = { new: 4, learning: 2, review: 6, cards: 12, mode: "study" } as Pick<DeckNode, "new" | "learning" | "review" | "cards" | "mode">;

export function ChangeIconDialog({ deck, icon, counts, open, onOpenChange, onSaved }: { deck: string | null; icon: string | null; counts?: Pick<DeckNode, "new" | "learning" | "review" | "cards" | "mode"> | null; open: boolean; onOpenChange(o: boolean): void; onSaved(icon: string | null): void }) {
  const [tab, setTab] = useState<Tab>("default");
  // One pick per kind, so trying another tab doesn't lose the emoji, image or illustration chosen before.
  const [picks, setPicks] = useState<Partial<Record<Tab, string>>>({});
  const setPick = (v: string) => setPicks((p) => ({ ...p, [tabOf(v)]: v }));
  const pick = picks[tab] ?? null;
  const [q, setQ] = useState("");
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dropping, setDropping] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // Motion: the pill slides to the chosen tab, the body grows or shrinks to the new content, which slides in from
  // the side of the tab it came from.
  const [dir, setDir] = useState(0);
  const tabRefs = useRef(new Map<Tab, HTMLButtonElement>());
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null);
  const [bodyH, setBodyH] = useState<number | null>(null);
  // Watches whichever tab's content is mounted (each tab is its own element), so the height follows it.
  const bodyRo = useRef<ResizeObserver | null>(null);
  const body = (el: HTMLDivElement | null) => {
    bodyRo.current?.disconnect();
    bodyRo.current = null;
    if (!el) return;
    setBodyH(el.offsetHeight);
    bodyRo.current = new ResizeObserver(() => setBodyH(el.offsetHeight));
    bodyRo.current.observe(el);
  };
  useEffect(() => () => bodyRo.current?.disconnect(), []);
  const choose = (k: Tab) => { setDir(Math.sign(TABS.findIndex(([t]) => t === k) - TABS.findIndex(([t]) => t === tab))); setTab(k); };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => { const b = tabRefs.current.get(tab); if (b) setPill({ x: b.offsetLeft, w: b.offsetWidth }); };
    place();
    const ro = new ResizeObserver(place);
    const list = tabRefs.current.get(tab)?.parentElement;
    if (list) ro.observe(list);
    return () => ro.disconnect();
  }, [open, tab]);
  useEffect(() => {
    if (!open) return;
    setPicks(icon && icon !== "none" ? { [tabOf(icon)]: icon } : {});
    setQ("");
    setCustom("");
    setTab(tabOf(icon));
    setDir(0);
    setPill(null);
    setBodyH(null);
  }, [open, icon]);

  const groups = useMemo(() => {
    const s = q.trim().toLowerCase();
    return DECK_ART.map((g) => ({ ...g, icons: g.icons.filter((i) => !s || i.label.toLowerCase().includes(s) || i.id.includes(s) || g.name.toLowerCase().includes(s)) })).filter((g) => g.icons.length);
  }, [q]);

  // What Save stores for the tab on screen: a tab whose kind hasn't been picked yet saves nothing.
  const current = tab === "none" ? "none" : tab === "default" ? null : pick;
  const ready = tab === "none" || tab === "default" || !!current;

  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (!/^image\//.test(file.type) && !/\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i.test(file.name)) return void toast.error("Choose an image: PNG, JPEG, WebP, GIF, AVIF, SVG or BMP.");
    if (file.size > MAX_ICON_BYTES) return void toast.error("That image is over 8 MB. A smaller one works better as an icon.");
    setUploading(true);
    try {
      const m = await api.uploadMedia(file);
      if (m.kind !== "image") throw new Error("That file isn't an image.");
      setPick(`media:${m.file}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    if (!deck) return;
    setBusy(true);
    try {
      const d = await api.updateDeck(deck, { icon: current ?? "default" });
      onSaved(d.icon ?? null);
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const customEmoji = custom.trim();
  const c = counts ?? SAMPLE;
  const work = c.new + c.learning + c.review;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(44rem,calc(100dvh-2rem))] flex-col gap-4 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Change icon</DialogTitle>
          <DialogDescription>{deck ? `For ${leafOf(deck)}.` : ""} It shows next to the deck in the Library.</DialogDescription>
        </DialogHeader>
        {/* The deck's Library row as it will look. */}
        <div aria-label="Preview" className="flex min-h-[4.25rem] items-center rounded-2xl border border-border px-3.5 py-2.5" data-icon-preview>
          <span className="icon-slot flex shrink-0 items-center justify-center" style={{ width: tab === "none" ? 0 : 46, marginRight: tab === "none" ? 0 : 14 }}>
            {tab === "none" ? null : (
              <span key={current ?? tab} className="icon-pop flex">
                {current && current !== "none" ? <DeckIcon icon={current} size={46} className="lib-art" /> : tab === "default" ? <DeckRing d={c} size={46} /> : <span aria-hidden className="size-[46px] shrink-0 rounded-[24%] bg-muted" />}
              </span>
            )}
          </span>
          <div className="min-w-0">
            <div className="truncate text-[15.5px] font-semibold">{deck ? leafOf(deck) : "Deck"}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{c.mode === "watch" ? "Tour" : !c.cards ? "No cards yet" : work ? `${c.new} new · ${c.learning} learning · ${c.review} due` : "Done for today"}</div>
          </div>
        </div>
        <div role="tablist" aria-label="Icon kind" className="relative grid w-full grid-cols-[repeat(4,minmax(0,1fr))_minmax(0,1.45fr)] rounded-full bg-muted p-1 text-[12.5px] sm:text-sm">
          {pill && <span aria-hidden className="icon-tab-pill absolute top-1 bottom-1 left-0 rounded-full bg-background shadow-sm" style={{ width: pill.w, transform: `translateX(${pill.x}px)` }} />}
          {TABS.map(([k, label]) => (
            <button key={k} ref={(el) => { if (el) tabRefs.current.set(k, el); else tabRefs.current.delete(k); }} role="tab" aria-selected={tab === k} onClick={() => choose(k)} className={cn("relative h-8 min-w-0 rounded-full px-1 whitespace-nowrap transition-colors duration-200 sm:px-2", tab === k ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground", !pill && tab === k && "bg-background shadow-sm")}>
              {label}
            </button>
          ))}
        </div>
        <div className="icon-body -mx-1 overflow-hidden px-1" style={bodyH != null ? { height: bodyH } : undefined}>
        <div ref={body} key={tab} className="icon-tab-in" style={{ ["--dx" as string]: `${dir * 18}px` }}>
        {tab === "none" && <p className="text-sm text-muted-foreground">No picture and no rings: the deck shows its name only.</p>}
        {tab === "default" && <p className="text-sm text-muted-foreground">Three rings for today's new, learning and due cards. A full green ring with a check means it's done for today.</p>}
        {tab === "emoji" && (
          <div>
            <div className="grid grid-cols-8 gap-1">
              {EMOJI_SUGGESTIONS.map((e) => (
                <button key={e} aria-label={e} aria-pressed={pick === `emoji:${e}`} onClick={() => setPick(`emoji:${e}`)} className={cn("flex aspect-square items-center justify-center rounded-xl text-2xl transition-[background-color,box-shadow,transform] duration-150 hover:bg-accent active:scale-95", pick === `emoji:${e}` && "bg-accent ring-2 ring-foreground/70")}>
                  {e}
                </button>
              ))}
            </div>
            <div className="mt-3 flex gap-2">
              <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Or type or paste any emoji" aria-label="Custom emoji" className="h-10" />
              <Button variant="outline" className="h-10" disabled={!customEmoji} onClick={() => setPick(`emoji:${customEmoji}`)}>Use</Button>
            </div>
          </div>
        )}
        {tab === "image" && (
          <div>
            <input ref={fileInput} type="file" accept={IMAGE_TYPES} hidden aria-label="Image file" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
            <button
              type="button"
              data-icon-drop
              onClick={() => fileInput.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDropping(true); }}
              onDragLeave={() => setDropping(false)}
              onDrop={(e) => { e.preventDefault(); setDropping(false); void upload(e.dataTransfer.files?.[0]); }}
              disabled={uploading}
              className={cn("flex w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border px-4 py-7 text-center transition-colors hover:border-muted-foreground/60 hover:bg-accent/40", dropping && "border-foreground/60 bg-accent/60")}
            >
              {pick?.startsWith("media:") ? <DeckIcon icon={pick} size={64} /> : <ImagePlus className="size-7 text-muted-foreground" />}
              <span className="text-sm font-medium">{uploading ? "Adding…" : pick?.startsWith("media:") ? "Choose another image" : "Choose an image"}</span>
              <span className="text-xs text-muted-foreground">or drop one here. Square works best; it's cropped to a rounded square.</span>
            </button>
          </div>
        )}
        {tab === "art" && (
          <div className="flex flex-col gap-3">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search illustrations" aria-label="Search illustrations" className="h-10 pl-9" />
            </div>
            <div className="max-h-[min(20rem,calc(100dvh-27rem))] min-h-32 overflow-y-auto pr-1">
              {groups.map((g) => (
                <div key={g.name} className="mb-3">
                  <div className="score-kicker mb-1.5 px-0.5">{g.name}</div>
                  <div className="grid grid-cols-5 gap-1 sm:grid-cols-7">
                    {g.icons.map((i) => (
                      <button key={i.id} title={i.label} aria-label={i.label} aria-pressed={pick === `art:${i.id}`} onClick={() => setPick(`art:${i.id}`)} className={cn("flex aspect-square items-center justify-center rounded-xl p-1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-accent active:scale-95", pick === `art:${i.id}` && "bg-accent ring-2 ring-foreground/70")}>
                        <img src={artUrl(i.id)} alt="" className="size-full object-contain" draggable={false} />
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {!groups.length && <p className="py-6 text-center text-sm text-muted-foreground">No illustration matches “{q}”.</p>}
            </div>
          </div>
        )}
        </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={busy || uploading || !ready}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
