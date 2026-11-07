// Your picture: how it's drawn (a character, an emoji on a colour, a photo, or your initial), the pieces both pickers
// share (character grid, emoji panel, photo crop), and the picture dialog Settings → Account and the sidebar open.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ImageMinus, ImagePlus, Upload, ZoomIn, ZoomOut } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useEtudeSrc } from "@/lib/local-url";
import { usePhone } from "@/lib/phone";
import { AVATAR_BGS, AVATAR_EMOJI, AVATAR_EMOJI_BG, CHARACTERS, OPEN_AVATAR_EVENT, openAvatarDialog, characterSrc, sameAvatar, saveAvatar, useAvatar, type Avatar } from "@/lib/avatar";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

// ---------------------------------------------------------------- drawing it

/** A photo being cropped, before it's saved: the file's picture, its size, and where it sits in the circle. */
export interface PhotoDraft {
  src: string;
  w: number;
  h: number;
  /** Scale at which the shorter side fills the 200 px crop circle. */
  base: number;
  zoom: number;
  x: number;
  y: number;
}
/** What a picker holds: a saved kind of picture, null for the initial, or the photo still being cropped. */
export type AvatarPick = Avatar | null | { kind: "draft" };

const CIRCLE = 200;

/** The picture at `size` px. `initial` is the letter shown when there's no picture (a person outline without one). */
export function AvatarPic({ value, size, initial, draft, className }: { value: AvatarPick | undefined; size: number; initial?: string; draft?: PhotoDraft | null; className?: string }) {
  const photo = value?.kind === "photo" ? `/media/${value.media}` : null;
  const photoSrc = useEtudeSrc(photo);
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [photo]);
  const box = cn("relative inline-grid shrink-0 place-items-center overflow-hidden rounded-full select-none", className);
  const style = { width: size, height: size };
  if (value?.kind === "char")
    return (
      <span aria-hidden className={box} style={style} data-avatar="char">
        <img src={characterSrc(value.id)} alt="" draggable={false} className="size-full object-cover" />
      </span>
    );
  if (value?.kind === "emoji")
    return (
      <span aria-hidden className={cn(box, "av-emoji")} style={{ ...style, background: value.bg, fontSize: size * 0.5 }} data-avatar="emoji">
        <span className="av-emoji-glyph">{value.e}</span>
      </span>
    );
  if (value?.kind === "draft" && draft) {
    const k = size / CIRCLE;
    const s = draft.base * draft.zoom * k;
    return (
      <span aria-hidden className={cn(box, "bg-muted")} style={style} data-avatar="draft">
        <img src={draft.src} alt="" draggable={false} className="pointer-events-none absolute max-w-none" style={{ width: draft.w * s, height: draft.h * s, left: size / 2 - (draft.w * s) / 2 + draft.x * k, top: size / 2 - (draft.h * s) / 2 + draft.y * k }} />
      </span>
    );
  }
  if (value?.kind === "photo" && !broken && photoSrc)
    return (
      <span aria-hidden className={cn(box, "bg-muted")} style={style} data-avatar="photo">
        <img src={photoSrc} alt="" draggable={false} onError={() => setBroken(true)} className="size-full object-cover" />
      </span>
    );
  return (
    <span aria-hidden className={cn(box, "bg-sidebar-accent font-bold text-foreground")} style={{ ...style, fontSize: Math.round(size * 0.42) }} data-avatar="initial">
      {initial ? initial : <PersonGlyph size={Math.round(size * 0.5)} />}
    </span>
  );
}

function PersonGlyph({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className="text-muted-foreground" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </svg>
  );
}

/** Your saved picture, kept current when it changes anywhere. */
export function MyAvatar({ size, initial, className }: { size: number; initial?: string; className?: string }) {
  const a = useAvatar();
  return <AvatarPic value={a} size={size} initial={initial} className={className} />;
}

// ---------------------------------------------------------------- shared panels

/** The selection mark on a round tile: an outline outside the art and a ✓ badge. */
function Tick({ size = 24 }: { size?: number }) {
  return (
    <span aria-hidden className="av-tick" style={{ width: size, height: size }}>
      <Check strokeWidth={3} style={{ width: size * 0.55, height: size * 0.55 }} />
    </span>
  );
}

export function CharacterGrid({ pick, onPick, cols }: { pick: AvatarPick; onPick(id: string): void; cols: number }) {
  return (
    <div role="radiogroup" aria-label="Characters" className="grid gap-6 p-2.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {CHARACTERS.map((c) => {
        const on = pick?.kind === "char" && pick.id === c.id;
        return (
          <button key={c.id} role="radio" aria-checked={on} aria-label={c.alt} data-char={c.id} onClick={() => onPick(c.id)} className={cn("av-tile aspect-square", on && "is-on")}>
            <img src={c.src} alt="" draggable={false} loading="lazy" className="size-full rounded-full object-cover" />
            <Tick />
          </button>
        );
      })}
    </div>
  );
}

export function EmojiPanel({ emoji, bg, picked, onChange }: { emoji: string; bg: string; picked: boolean; onChange(e: string, bg: string): void }) {
  const [custom, setCustom] = useState("");
  const typed = custom.trim();
  return (
    <div>
      <div className="mb-3.5 flex items-center gap-4">
        <AvatarPic value={{ kind: "emoji", e: emoji, bg }} size={76} />
        <div className="min-w-0 flex-1">
          <div className="score-kicker mb-2">Background</div>
          <div className="flex flex-wrap gap-2.5" role="radiogroup" aria-label="Background">
            {AVATAR_BGS.map((c) => (
              <button key={c} role="radio" aria-checked={bg === c} aria-label={c} data-bg={c} onClick={() => onChange(emoji, c)} className={cn("av-swatch", bg === c && "is-on")} style={{ background: c }} />
            ))}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(40px,1fr))] gap-1" role="radiogroup" aria-label="Emoji">
        {AVATAR_EMOJI.map((e) => {
          const on = picked && emoji === e;
          return (
            <button key={e} role="radio" aria-checked={on} aria-label={e} data-emoji={e} onClick={() => onChange(e, bg)} className={cn("av-emoji-glyph h-[42px] rounded-[10px] text-2xl transition-[background-color,box-shadow,transform] duration-150 hover:bg-accent active:scale-95", on && "bg-primary/12 shadow-[inset_0_0_0_2px_var(--primary)]")}>
              {e}
            </button>
          );
        })}
      </div>
      <div className="mt-3 flex gap-2">
        <Input value={custom} onChange={(ev) => setCustom(ev.target.value)} placeholder="Or type or paste any emoji" aria-label="Custom emoji" className="h-10" />
        <Button variant="outline" className="h-10" disabled={!typed || [...typed].length > 12} onClick={() => onChange(typed, bg)}>Use</Button>
      </div>
    </div>
  );
}

const MAX_PHOTO_BYTES = 20 * 1024 * 1024;

/** Reads an image file into a draft that fills the crop circle. */
export function readPhoto(file: File): Promise<PhotoDraft> {
  return new Promise((resolve, reject) => {
    if (!/^image\//.test(file.type) && !/\.(png|jpe?g|gif|webp|avif|bmp|heic|heif)$/i.test(file.name)) return reject(new Error("Choose a picture: JPG, PNG, WebP, GIF or AVIF."));
    if (file.size > MAX_PHOTO_BYTES) return reject(new Error("That picture is over 20 MB."));
    const src = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => resolve({ src, w: im.naturalWidth, h: im.naturalHeight, base: CIRCLE / Math.min(im.naturalWidth, im.naturalHeight), zoom: 1.2, x: 0, y: 0 });
    im.onerror = () => (URL.revokeObjectURL(src), reject(new Error("This browser can't open that picture. Try a JPG or PNG.")));
    im.src = src;
  });
}

/** Keeps the picture covering the whole circle. */
function clampDraft(d: PhotoDraft): PhotoDraft {
  const s = d.base * d.zoom;
  const mx = Math.max(0, (d.w * s - CIRCLE) / 2);
  const my = Math.max(0, (d.h * s - CIRCLE) / 2);
  return { ...d, x: Math.max(-mx, Math.min(mx, d.x)), y: Math.max(-my, Math.min(my, d.y)) };
}

/** Crops the circle to a 256 px square WebP (PNG where the browser can't write WebP) and saves it in the collection's media. */
export async function savePhoto(d: PhotoDraft): Promise<Avatar> {
  const OUT = 256;
  const im = new Image();
  im.src = d.src;
  await im.decode();
  const c = document.createElement("canvas");
  c.width = c.height = OUT;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  const k = OUT / CIRCLE;
  const s = d.base * d.zoom * k;
  const w = d.w * s;
  const h = d.h * s;
  ctx.drawImage(im, OUT / 2 - w / 2 + d.x * k, OUT / 2 - h / 2 + d.y * k, w, h);
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("Couldn't crop the picture."))), "image/webp", 0.9));
  const ext = blob.type === "image/webp" ? "webp" : "png";
  const m = await api.uploadMedia(new File([blob], `avatar.${ext}`, { type: blob.type }));
  if (m.kind !== "image") throw new Error("That file isn't a picture.");
  return { kind: "photo", media: m.file };
}

/** The photo tab: a drop zone, then the crop circle (drag to move, slider or wheel to zoom). */
export function PhotoPanel({ draft, onDraft, saved, onRemove }: { draft: PhotoDraft | null; onDraft(d: PhotoDraft | null): void; saved: Avatar | null; onRemove(): void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const load = async (f: File | undefined) => {
    if (!f) return;
    try {
      onDraft(await readPhoto(f));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const drag = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const latest = useRef(draft);
  latest.current = draft;
  // Wheel zoom needs a non-passive listener to keep the dialog from scrolling.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const h = (e: WheelEvent) => {
      const d = latest.current;
      if (!d) return;
      e.preventDefault();
      onDraft(clampDraft({ ...d, zoom: Math.max(1, Math.min(3, d.zoom - e.deltaY * 0.002)) }));
    };
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, [!!draft, onDraft]);
  const file = <input ref={input} type="file" accept="image/*" hidden aria-label="Photo file" onChange={(e) => (void load(e.target.files?.[0]), (e.target.value = ""))} />;
  if (!draft)
    return (
      <div className="flex flex-col items-center gap-3">
        {file}
        {saved?.kind === "photo" && (
          <div className="flex items-center gap-3 self-stretch rounded-2xl border px-3.5 py-3">
            <AvatarPic value={saved} size={48} />
            <span className="min-w-0 flex-1 text-sm text-muted-foreground">Your photo now.</span>
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={onRemove}><ImageMinus className="size-4" /> Remove</Button>
          </div>
        )}
        <button
          type="button"
          data-photo-drop
          onClick={() => input.current?.click()}
          onDragOver={(e) => (e.preventDefault(), setOver(true))}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => (e.preventDefault(), setOver(false), void load(e.dataTransfer.files?.[0]))}
          className={cn("flex min-h-[200px] w-full flex-col items-center justify-center gap-2 rounded-[18px] sm:min-h-[318px] border-[1.5px] border-dashed border-foreground/20 px-5 py-7 text-center transition-colors hover:border-primary hover:bg-primary/[0.07]", over && "border-primary bg-primary/[0.07]")}
        >
          <Upload className="size-7 text-muted-foreground" strokeWidth={1.6} />
          <b className="text-[15px] font-semibold">{saved?.kind === "photo" ? "Choose another picture" : "Drop a picture here"}</b>
          <small className="text-[13px] text-muted-foreground">or click to choose one. JPG, PNG, WebP or GIF.<br />It's cropped to a circle and stays private until you save.</small>
        </button>
      </div>
    );
  const s = draft.base * draft.zoom;
  return (
    <div className="flex flex-col items-center gap-3.5">
      {file}
      <div
        ref={box}
        data-crop
        className="relative size-[260px] cursor-grab touch-none overflow-hidden rounded-[18px] bg-[#111] active:cursor-grabbing"
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY, dx: draft.x, dy: draft.y };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const g = drag.current;
          if (!g) return;
          onDraft(clampDraft({ ...draft, x: g.dx + e.clientX - g.x, y: g.dy + e.clientY - g.y }));
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        <img src={draft.src} alt="" draggable={false} className="pointer-events-none absolute top-1/2 left-1/2 max-w-none select-none" style={{ width: draft.w * s, height: draft.h * s, transform: `translate(calc(-50% + ${draft.x}px), calc(-50% + ${draft.y}px))` }} />
        <i aria-hidden className="av-crop-mask" />
      </div>
      <small className="-mt-1 text-[12.5px] text-muted-foreground">Drag to move it</small>
      <label className="flex w-[260px] items-center gap-2.5 text-muted-foreground">
        <ZoomOut className="size-4 shrink-0" />
        <input type="range" min={1} max={3} step={0.01} value={draft.zoom} aria-label="Zoom" className="min-w-0 flex-1 accent-[var(--primary)]" onChange={(e) => onDraft(clampDraft({ ...draft, zoom: Number(e.target.value) }))} />
        <ZoomIn className="size-4 shrink-0" />
      </label>
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => input.current?.click()}><ImagePlus className="size-4" /> Choose another</Button>
        <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => onDraft(null)}><ImageMinus className="size-4" /> Remove photo</Button>
      </div>
    </div>
  );
}

/** Turns a pick into what's saved, cropping and storing a draft photo first. */
export async function finishPick(pick: AvatarPick, draft: PhotoDraft | null): Promise<Avatar | null> {
  if (pick?.kind === "draft") {
    if (!draft) throw new Error("Choose a picture first.");
    return savePhoto(draft);
  }
  return pick;
}

// ---------------------------------------------------------------- the picture dialog (Settings → Account, the sidebar)

type Tab = "chars" | "emoji" | "photo";
const TABS: [Tab, string][] = [["chars", "Characters"], ["emoji", "Emoji"], ["photo", "Photo"]];
const tabOf = (a: AvatarPick): Tab => (a?.kind === "emoji" ? "emoji" : a?.kind === "photo" || a?.kind === "draft" ? "photo" : "chars");

/** Tabs with a pill that slides to the chosen one. `list` goes on the tab list (it may mount after the dialog opens). */
export function useSlidingTabs<T extends string>(tab: T, open: boolean) {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const [listEl, setListEl] = useState<HTMLElement | null>(null);
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !listEl) return;
    const place = () => {
      const b = refs.current.get(tab);
      if (b) setPill({ x: b.offsetLeft, w: b.offsetWidth });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(listEl);
    return () => ro.disconnect();
  }, [open, tab, listEl]);
  const ref = (k: T) => (el: HTMLButtonElement | null) => {
    if (el) refs.current.set(k, el);
    else refs.current.delete(k);
  };
  return { pill, ref, list: setListEl, reset: () => setPill(null) };
}

/** A body that eases to the height of whatever is mounted inside it. */
export function useEasedHeight() {
  const [h, setH] = useState<number | null>(null);
  const ro = useRef<ResizeObserver | null>(null);
  const measure = useCallback((el: HTMLDivElement | null) => {
    ro.current?.disconnect();
    ro.current = null;
    if (!el) return;
    setH(el.offsetHeight);
    ro.current = new ResizeObserver(() => setH(el.offsetHeight));
    ro.current.observe(el);
  }, []);
  useEffect(() => () => ro.current?.disconnect(), []);
  return { h, measure, reset: () => setH(null) };
}

/** Settings → Account: your picture, with Change picture. */
export function PictureBlock({ name }: { name?: string | null }) {
  const a = useAvatar();
  const letter = (name ?? localStorage.getItem("etude.shell.name") ?? "").trim().charAt(0).toUpperCase();
  return (
    <div data-settings-row data-avatar-block className="settings-block relative flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-[15px] first:rounded-t-[14px] last:rounded-b-[14px] sm:flex-nowrap sm:px-[18px]">
      <button onClick={openAvatarDialog} aria-label="Change picture" className="shrink-0 rounded-full outline-ring transition-transform duration-150 hover:scale-105 focus-visible:outline-2 motion-reduce:transition-none">
        <AvatarPic value={a} size={64} initial={letter} />
      </button>
      <div className="min-w-0 flex-1 basis-[10rem]">
        <div data-settings-title className="text-[14.5px] font-semibold text-foreground">Your picture</div>
        <div className="mt-[3px] text-[13px] leading-[1.45] text-pretty text-muted-foreground">Shows next to your name in the sidebar.</div>
      </div>
      <Button variant="outline" size="sm" className="h-10 max-sm:ml-20 md:h-8" onClick={openAvatarDialog} data-avatar-change>Change picture</Button>
    </div>
  );
}

/** Mounted once by the app; opens on `openAvatarDialog()`. */
export function AvatarDialogHost({ initial }: { initial?: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const h = () => setOpen(true);
    window.addEventListener(OPEN_AVATAR_EVENT, h);
    return () => window.removeEventListener(OPEN_AVATAR_EVENT, h);
  }, []);
  return <AvatarDialog open={open} onOpenChange={setOpen} initial={initial} />;
}

export function AvatarDialog({ open, onOpenChange, initial }: { open: boolean; onOpenChange(o: boolean): void; initial?: string }) {
  const saved = useAvatar();
  const phone = usePhone();
  const [pick, setPick] = useState<AvatarPick>(saved);
  const [tab, setTab] = useState<Tab>("chars");
  const [dir, setDir] = useState(0);
  const [emoji, setEmoji] = useState({ e: "🦊", bg: AVATAR_EMOJI_BG });
  const [draft, setDraftState] = useState<PhotoDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const tabs = useSlidingTabs(tab, open);
  const body = useEasedHeight();
  // The preview pops whenever the pick changes.
  const [popKey, setPopKey] = useState(0);
  const choose = (p: AvatarPick) => (setPick(p), setPopKey((k) => k + 1));
  const draftSrc = useRef<string | null>(null);
  const setDraft = useCallback((d: PhotoDraft | null) => {
    const old = draftSrc.current;
    if (old && old !== d?.src) URL.revokeObjectURL(old);
    draftSrc.current = d?.src ?? null;
    setDraftState(d);
    if (d && d.src !== old) choose({ kind: "draft" });
    if (!d) setPick((p) => (p?.kind === "draft" ? saved : p));
  }, [saved]);
  useEffect(() => {
    if (!open) return;
    setPick(saved);
    setTab(tabOf(saved));
    setDir(0);
    if (saved?.kind === "emoji") setEmoji({ e: saved.e, bg: saved.bg });
    if (draftSrc.current) URL.revokeObjectURL(draftSrc.current);
    draftSrc.current = null;
    setDraftState(null);
    tabs.reset();
    body.reset();
  }, [open]);
  const go = (k: Tab) => {
    if (k === tab) return;
    setDir(Math.sign(TABS.findIndex(([t]) => t === k) - TABS.findIndex(([t]) => t === tab)));
    setTab(k);
    setPopKey((n) => n + 1);
  };
  const unchanged = pick?.kind !== "draft" && sameAvatar(pick as Avatar | null, saved);
  const save = async () => {
    setBusy(true);
    try {
      const a = await finishPick(pick, draft);
      await saveAvatar(a);
      toast.success("Picture saved");
      onOpenChange(false);
    } catch (e) {
      toast.error("Couldn't save the picture", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const big = phone ? 64 : 84;
  const letter = initial ?? (localStorage.getItem("etude.shell.name") ?? "").trim().charAt(0).toUpperCase();
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent data-avatar-dialog className="flex h-[min(88dvh,44rem)] max-h-[92dvh] flex-col gap-0 overflow-hidden p-0 pb-[env(safe-area-inset-bottom)] sm:h-[min(37rem,calc(100dvh-3rem))] sm:max-h-none sm:max-w-[600px] sm:rounded-[22px] sm:p-0">
        <div aria-hidden className="mx-auto mt-2 h-[5px] w-[38px] rounded-full bg-border sm:hidden" />
        <div className="flex items-center gap-[18px] px-5 pt-3.5 pb-3 pr-12 sm:px-6 sm:pt-[22px] sm:pb-4 sm:pr-14">
          <span key={popKey} className="av-fade flex" data-avatar-preview>
            <AvatarPic value={pick} size={big} initial={letter} draft={draft} />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-[19px] font-semibold tracking-[-0.01em]">Your picture</DialogTitle>
            <DialogDescription className="mt-1 text-[13.5px]">
              <span data-avatar-name>Shows next to your name in the sidebar.</span>
            </DialogDescription>
          </div>
        </div>
        <div className="px-5 pb-3.5 sm:px-6">
          <div ref={tabs.list} role="tablist" aria-label="Kind of picture" className="relative flex gap-0.5 rounded-xl bg-muted p-[3px]">
            {tabs.pill && <span aria-hidden className="icon-tab-pill absolute top-[3px] bottom-[3px] left-0 rounded-[9px] bg-background shadow-[0_1px_2px_rgb(0_0_0/0.08),0_0_0_1px_var(--border)] dark:bg-input dark:shadow-none" style={{ width: tabs.pill.w, transform: `translateX(${tabs.pill.x}px)` }} />}
            {TABS.map(([k, label]) => (
              <button key={k} ref={tabs.ref(k)} role="tab" aria-selected={tab === k} data-tab={k} onClick={() => go(k)} className={cn("relative h-[34px] flex-1 rounded-[9px] px-2 text-[13.5px] font-medium whitespace-nowrap transition-colors duration-200", tab === k ? "text-foreground" : "text-muted-foreground hover:text-foreground", !tabs.pill && tab === k && "bg-background")}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
          <div className="icon-body overflow-hidden" style={body.h != null ? { height: body.h } : undefined}>
            <div ref={body.measure} key={tab} className="icon-tab-in px-5 pt-1 pb-[18px] sm:px-6" style={{ ["--dx" as string]: `${dir * 28}px` }}>
              {tab === "chars" && <CharacterGrid pick={pick} cols={phone ? 4 : 6} onPick={(id) => choose({ kind: "char", id })} />}
              {tab === "emoji" && <EmojiPanel emoji={emoji.e} bg={emoji.bg} picked={pick?.kind === "emoji"} onChange={(e, bg) => (setEmoji({ e, bg }), choose({ kind: "emoji", e, bg }))} />}
              {tab === "photo" && <PhotoPanel draft={draft} onDraft={setDraft} saved={saved} onRemove={() => choose(null)} />}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 border-t px-5 py-3.5 sm:px-6">
          <Button variant="ghost" className="-ml-3" data-avatar-initial onClick={() => choose(null)} disabled={busy}>Use my initial</Button>
          <span className="flex-1" />
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={save} disabled={busy || unchanged} data-avatar-save>{busy ? "Saving…" : "Save"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
