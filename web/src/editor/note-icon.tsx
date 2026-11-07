// A page's icon: an illustration from the deck-icon library, an emoji, or a picture of your own (in the
// collection's media, so it syncs later with the rest). Old pages stored a bare emoji; that still shows.
import { useMemo, useRef, useState } from "react";
import { ImagePlus, Search } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { artUrl, DECK_ART, EMOJI_SUGGESTIONS, parseDeckIcon } from "@/lib/deck-icons";
import { useEtudeSrc } from "@/lib/local-url";
import { cn } from "@/lib/utils";

/** The icon at `size` px, or a page glyph when the page has none (`fallback`). */
export function NoteIcon({ icon, size = 18, fallback = "📄", className }: { icon: string | null | undefined; size?: number; fallback?: string | null; className?: string }) {
  const v = icon ? (parseDeckIcon(icon) ?? (/^(art|emoji|media):/.test(icon) ? null : { kind: "emoji" as const, emoji: icon })) : null;
  const media = useEtudeSrc(v?.kind === "media" ? v.src : null);
  if (!v) return fallback ? <span aria-hidden className={cn("av-emoji-glyph inline-flex items-center justify-center leading-none", className)} style={{ width: size, height: size, fontSize: Math.round(size * 0.86) }}>{fallback}</span> : null;
  return (
    <span aria-hidden className={cn("inline-flex shrink-0 items-center justify-center select-none", className)} style={{ width: size, height: size }}>
      {v.kind === "art" ? (
        <img src={v.src} alt="" draggable={false} className="size-full object-contain" />
      ) : v.kind === "media" ? (
        media && <img src={media} alt="" draggable={false} className="size-full rounded-[22%] object-cover" />
      ) : (
        <span className="av-emoji-glyph leading-none" style={{ fontSize: Math.round(size * 0.86) }}>{v.emoji}</span>
      )}
    </span>
  );
}

type Tab = "emoji" | "art" | "image";
const tabOf = (icon: string | null): Tab => (icon?.startsWith("art:") ? "art" : icon?.startsWith("media:") ? "image" : "emoji");

export function NoteIconPicker({ icon, onPick, onRemove }: { icon: string | null; onPick(icon: string): void; onRemove(): void }) {
  const [tab, setTab] = useState<Tab>(tabOf(icon));
  const [q, setQ] = useState("");
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const groups = useMemo(() => {
    const s = q.trim().toLowerCase();
    return DECK_ART.map((g) => ({ ...g, icons: g.icons.filter((i) => !s || i.label.toLowerCase().includes(s) || i.id.includes(s) || g.name.toLowerCase().includes(s)) })).filter((g) => g.icons.length);
  }, [q]);
  const upload = async (f?: File) => {
    if (!f) return;
    setBusy(true);
    try {
      const m = await api.uploadMedia(f);
      if (m.kind !== "image") throw new Error("That file isn't a picture.");
      onPick(`media:${m.file}`);
    } catch (e) {
      toast.error(`Couldn't use that picture: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const tabs: [Tab, string][] = [["emoji", "Emoji"], ["art", "Illustration"], ["image", "Image"]];
  return (
    <div className="flex w-[20rem] flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <div role="tablist" className="flex gap-0.5 rounded-full bg-muted p-0.5 text-[12.5px]">
          {tabs.map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cn("h-7 rounded-full px-3", tab === k ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
              {l}
            </button>
          ))}
        </div>
        {icon && <button type="button" onClick={onRemove} className="h-7 rounded-full px-2.5 text-[12.5px] text-muted-foreground hover:bg-accent hover:text-foreground">Remove</button>}
      </div>
      {tab === "emoji" && (
        <>
          <div className="grid grid-cols-8 gap-0.5">
            {EMOJI_SUGGESTIONS.map((e) => (
              <button key={e} type="button" aria-label={e} onClick={() => onPick(`emoji:${e}`)} className="av-emoji-glyph flex aspect-square items-center justify-center rounded-[7px] text-[20px] hover:bg-accent">{e}</button>
            ))}
          </div>
          <input value={custom} onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => e.key === "Enter" && custom.trim() && onPick(`emoji:${custom.trim()}`)} placeholder="Or paste any emoji and press Enter" aria-label="Any emoji" className="note-cards-input h-9" />
        </>
      )}
      {tab === "art" && (
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search illustrations" aria-label="Search illustrations" className="note-cards-input h-9" style={{ paddingLeft: 32 }} />
          </div>
          <div className="max-h-72 overflow-y-auto pr-1">
            {groups.map((g) => (
              <div key={g.name} className="mb-2">
                <div className="note-fmt-head px-0.5">{g.name}</div>
                <div className="grid grid-cols-6 gap-0.5">
                  {g.icons.map((i) => (
                    <button key={i.id} type="button" title={i.label} aria-label={i.label} onClick={() => onPick(`art:${i.id}`)} className={cn("flex aspect-square items-center justify-center rounded-[9px] p-1 hover:bg-accent", icon === `art:${i.id}` && "bg-accent ring-2 ring-foreground/60")}>
                      <img src={artUrl(i.id)} alt="" draggable={false} className="size-full object-contain" />
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {!groups.length && <p className="py-5 text-center text-[13px] text-muted-foreground">No illustration matches “{q}”.</p>}
          </div>
        </>
      )}
      {tab === "image" && (
        <>
          <input ref={file} type="file" accept="image/*" hidden onChange={(e) => (void upload(e.target.files?.[0]), (e.target.value = ""))} />
          <button
            type="button"
            disabled={busy}
            onClick={() => file.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => (e.preventDefault(), void upload(e.dataTransfer.files?.[0]))}
            className="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border px-4 py-7 text-center hover:border-muted-foreground/60 hover:bg-accent/40"
          >
            {icon?.startsWith("media:") ? <NoteIcon icon={icon} size={56} /> : <ImagePlus className="size-7 text-muted-foreground" />}
            <span className="text-[13.5px] font-medium">{busy ? "Adding…" : "Choose a picture"}</span>
            <span className="text-[12px] text-muted-foreground">or drop one here. Square works best.</span>
          </button>
        </>
      )}
    </div>
  );
}
