// The top of Settings → Account & Sync: your banner, your picture over its bottom edge, your name (edit it in
// place) and how this collection syncs. The picture opens the picture dialog; Change banner opens "Your banner".
// Nothing here remounts the page: banners cross-fade in place, dialogs fade over it.
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Camera, Check, Image as ImageIcon, Pencil, X } from "lucide-react";
import { toast } from "sonner";
import { AvatarPic } from "@/components/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { openAvatarDialog, saveName, useAvatar, useMyName, type Avatar } from "@/lib/avatar";
import { BANNER_PRESETS, readBannerImage, sameBanner, saveBanner, uploadBannerImage, useBanner, type Banner } from "@/lib/banner";
import { useEtudeSrc } from "@/lib/local-url";
import { usePhone } from "@/lib/phone";
import { STATUS_EVENT, syncStatus, type SyncSeen } from "@/lib/sync";
import type { AccountStatus } from "@/lib/account";
import { cn } from "@/lib/utils";

/** A banner being picked: saved kinds, or an image not uploaded yet (`blob`) or already in the media. */
type Draft = Banner | null | { kind: "image"; src: string; blob: Blob; y: number };
type Pattern = (typeof BANNER_PRESETS)[number]["pattern"];

const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------------------------------------------------------------- drawing it

/** Sparkles as [x %, y %, size]: the prototype's ten, kept clear of the edges. */
const SPARKS: [number, number, number][] = [[10, 25, 3], [23, 66, 2], [35, 20, 2.5], [50, 53, 3.5], [63, 22, 2], [75, 74, 2.5], [88, 32, 3], [94, 78, 2], [17, 82, 2], [42, 80, 2]];

function PatternSvg({ pattern, ink }: { pattern: Pattern; ink: string }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const common = { className: "pointer-events-none absolute inset-0 size-full", viewBox: "0 0 600 132", preserveAspectRatio: "xMidYMid slice", "aria-hidden": true } as const;
  // Sparkles and stars are placed in % of the box at a fixed size, so no box's shape crops them at its edge.
  if (pattern === "spark")
    return (
      <span aria-hidden className="pointer-events-none absolute inset-0" style={{ opacity: 0.55 }}>
        {SPARKS.map(([x, y, r], i) => (
          <svg key={i} viewBox="-1 -1 2 2" className="absolute" style={{ left: `${x}%`, top: `${y}%`, width: r * 4.8, height: r * 4.8, transform: "translate(-50%, -50%)" }}>
            <path d="M0 -1Q0 0 1 0Q0 0 0 1Q0 0 -1 0Q0 0 0 -1Z" fill={ink} />
          </svg>
        ))}
      </span>
    );
  if (pattern === "dots")
    return (
      <svg {...common} style={{ opacity: 0.55 }}>
        <defs>
          <pattern id={`d${id}`} width="22" height="22" patternUnits="userSpaceOnUse">
            <circle cx="4" cy="4" r="2" fill={ink} />
          </pattern>
        </defs>
        <rect width="600" height="132" fill={`url(#d${id})`} opacity={0.9} />
      </svg>
    );
  if (pattern === "lines")
    return (
      <svg {...common} style={{ opacity: ink === "#fff" ? 0.28 : 0.13 }}>
        <defs>
          <pattern id={`l${id}`} width="16" height="16" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
            <rect width="3" height="16" fill={ink} />
          </pattern>
        </defs>
        <rect width="600" height="132" fill={`url(#l${id})`} />
      </svg>
    );
  if (pattern === "waves")
    return (
      <svg {...common} fill="none" stroke={ink} strokeWidth={3} style={{ opacity: 0.5 }}>
        {[20, 50, 80, 110].map((y) => (
          <path key={y} d={`M0 ${y}q25-14 50 0t50 0 50 0 50 0 50 0 50 0 50 0 50 0 50 0 50 0 50 0 50 0`} />
        ))}
      </svg>
    );
  if (pattern === "stars")
    return (
      <span aria-hidden className="pointer-events-none absolute inset-0">
        {Array.from({ length: 46 }, (_, i) => {
          const r = i % 5 ? 1 : 1.8;
          return <span key={i} className="absolute rounded-full" style={{ left: `${3 + ((i * 137) % 600) / 6.2}%`, top: `${8 + ((i * 71) % 132) / 1.57}%`, width: r * 2, height: r * 2, background: ink, opacity: 0.4 + (i % 3) * 0.2 }} />;
        })}
      </span>
    );
  return null;
}

/** "Match my picture": the characters' poster blue, an emoji's colour, a blurred copy of your photo, a soft green. */
function MatchArt({ avatar }: { avatar: Avatar | null }) {
  const photo = useEtudeSrc(avatar?.kind === "photo" ? `/media/${avatar.media}` : null);
  if (avatar?.kind === "photo")
    return (
      <div className="absolute inset-0 overflow-hidden bg-muted" data-banner-art="photo">
        {photo && <img src={photo} alt="" draggable={false} className="absolute -inset-[30px] size-[calc(100%+60px)] max-w-none object-cover opacity-90 [filter:blur(22px)_saturate(1.25)]" />}
      </div>
    );
  if (!avatar)
    return <div className="absolute inset-0 bg-[linear-gradient(120deg,color-mix(in_oklab,var(--primary)_16%,var(--card)),color-mix(in_oklab,var(--primary)_42%,var(--background)))] dark:bg-[linear-gradient(120deg,color-mix(in_oklab,var(--primary)_34%,var(--card)),color-mix(in_oklab,var(--primary)_62%,var(--background)))]" data-banner-art="initial" />;
  return (
    <div className="absolute inset-0" style={{ background: avatar.kind === "emoji" ? avatar.bg : "#3d5fb8" }} data-banner-art={avatar.kind}>
      <PatternSvg pattern="spark" ink="#fff" />
    </div>
  );
}

function ImageArt({ src, y }: { src: string | undefined; y: number }) {
  return (
    <div className="absolute inset-0 overflow-hidden bg-muted" data-banner-art="image">
      {src && <img src={src} alt="" draggable={false} data-banner-img className="pointer-events-none absolute inset-0 size-full object-cover select-none" style={{ objectPosition: `50% ${y}%` }} />}
    </div>
  );
}

function SavedImageArt({ media, y }: { media: string; y: number }) {
  const src = useEtudeSrc(`/media/${media}`);
  return <ImageArt src={src} y={y} />;
}

/** One banner, filling its box. */
export function BannerArt({ value, avatar }: { value: Draft; avatar: Avatar | null }) {
  if (!value) return <MatchArt avatar={avatar} />;
  if (value.kind === "image") return "blob" in value ? <ImageArt src={value.src} y={value.y} /> : <SavedImageArt media={value.media} y={value.y} />;
  const p = BANNER_PRESETS.find((x) => x.id === value.id) ?? BANNER_PRESETS[0];
  return (
    <div className="absolute inset-0" style={{ background: p.bg }} data-banner-art={`preset-${p.id}`}>
      <PatternSvg pattern={p.pattern} ink={p.ink} />
      {p.light && <span aria-hidden className="absolute inset-0 shadow-[inset_0_0_0_1px_var(--border)]" />}
    </div>
  );
}

/** What a banner looks like, as a key: two banners with the same key look the same. */
function artKey(v: Draft, avatar: Avatar | null): string {
  if (!v) return `match:${avatar ? JSON.stringify(avatar) : "initial"}`;
  if (v.kind === "image") return "blob" in v ? `draft:${v.src}` : `image:${v.media}`;
  return `preset:${v.id}`;
}

/**
 * Cross-fades to a new banner: the new one fades in over the old (~240 ms), then the old one goes. Only the art
 * changes; an image moving inside the same banner just moves. Reduced motion swaps at once.
 */
function BannerFade({ value, avatar, className }: { value: Draft; avatar: Avatar | null; className?: string }) {
  const key = artKey(value, avatar);
  const seq = useRef(0);
  const [layers, setLayers] = useState<{ key: string; n: number; value: Draft; avatar: Avatar | null; fresh: boolean }[]>(() => [{ key, n: 0, value, avatar, fresh: false }]);
  const top = layers[layers.length - 1];
  if (top.key !== key) {
    const next = { key, n: ++seq.current, value, avatar, fresh: true };
    setLayers(reduced() ? [{ ...next, fresh: false }] : [top, next]);
  } else if (top.value !== value || top.avatar !== avatar) {
    setLayers((ls) => ls.map((l, i) => (i === ls.length - 1 ? { ...l, value, avatar } : l)));
  }
  const done = (n: number) => setLayers((ls) => (ls[ls.length - 1].n === n ? [{ ...ls[ls.length - 1], fresh: false }] : ls));
  useEffect(() => {
    if (!top.fresh) return;
    const t = window.setTimeout(() => done(top.n), 400);
    return () => window.clearTimeout(t);
  }, [top.n, top.fresh]);
  return (
    <div className={cn("absolute inset-0 overflow-hidden", className)} data-banner>
      {layers.map((l) => (
        <div key={l.n} data-banner-layer className={cn("absolute inset-0", l.fresh && "bn-in")} onAnimationEnd={(e) => e.target === e.currentTarget && done(l.n)}>
          <BannerArt value={l.value} avatar={l.avatar} />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- the header

function syncedAgo(iso: string, now: number) {
  const m = Math.round((now - new Date(iso).getTime()) / 60000);
  if (m < 1) return "Synced just now";
  if (m < 60) return `Synced ${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `Synced ${h} h ago`;
  return `Synced ${new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

/** Scrolls to the account's sign-in form and puts the cursor in its email field. */
function goToSignIn() {
  const form = document.querySelector<HTMLElement>("[data-account-signin]");
  if (!form) return;
  form.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "center" });
  const row = form.closest("[data-settings-row]") ?? form;
  row.classList.remove("settings-flash");
  void (row as HTMLElement).offsetWidth;
  row.classList.add("settings-flash");
  form.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
}

export function ProfileHeader({ acct }: { acct: AccountStatus | null }) {
  const avatar = useAvatar();
  const banner = useBanner();
  const savedName = useMyName();
  const phone = usePhone();
  const signedIn = !!acct?.signedIn && !!acct.me;
  const email = acct?.me?.email ?? null;
  const fallback = (acct?.me?.displayName?.trim() || (typeof localStorage !== "undefined" ? localStorage.getItem("etude.shell.name") : "") || email || "").trim();
  const shown = savedName || fallback;
  const letter = shown.charAt(0).toUpperCase();

  // Sync's last run, kept current by the app's automatic syncs.
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let live = true;
    void syncStatus().then((s) => live && setLastSync(s?.lastSync ?? null));
    const h = (e: Event) => {
      const s = (e as CustomEvent<SyncSeen>).detail;
      if (s?.lastSync) setLastSync(s.lastSync);
    };
    window.addEventListener(STATUS_EVENT, h);
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => ((live = false), window.removeEventListener(STATUS_EVENT, h), window.clearInterval(t));
  }, []);

  // A small pop on the picture whenever the picture or the banner is saved (not on first paint).
  const pic = useRef<HTMLSpanElement>(null);
  const first = useRef(true);
  const popKey = `${JSON.stringify(avatar)}|${JSON.stringify(banner)}`;
  useLayoutEffect(() => {
    if (first.current) return void (first.current = false);
    const el = pic.current;
    if (!el || reduced()) return;
    el.classList.remove("ph-pop");
    void el.offsetWidth;
    el.classList.add("ph-pop");
  }, [popKey]);

  // The name, edited in place: Enter or leaving the field saves, Esc puts it back.
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(savedName);
  const input = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);
  const startEdit = () => {
    cancelled.current = false;
    setName(savedName);
    setEditing(true);
  };
  const commit = async () => {
    setEditing(false);
    if (cancelled.current) return;
    const n = name.replace(/\s+/g, " ").trim();
    if (n === savedName) return;
    try {
      await saveName(n);
      toast.success(n ? "Name saved" : "Name cleared");
    } catch (e) {
      toast.error("Couldn't save the name", { description: (e as Error).message });
    }
  };

  const [bannerOpen, setBannerOpen] = useState(false);

  return (
    <div data-profile-header data-settings-row className="@container/ph settings-card relative mt-5 mb-7 overflow-hidden rounded-[18px] border bg-card max-md:-mx-5 max-md:rounded-none max-md:border-x-0 max-md:border-t-0">
      <span data-settings-title className="sr-only">Your picture</span>
      <div className="relative h-[104px] max-md:h-[92px]" data-profile-cover>
        <BannerFade value={banner} avatar={avatar} />
        <button type="button" onClick={() => setBannerOpen(true)} aria-label="Change banner" data-banner-pill className="absolute top-2.5 right-2.5 inline-flex h-8 items-center gap-1.5 rounded-full bg-black/40 px-3 text-[12.5px] font-semibold text-white backdrop-blur-md transition-colors hover:bg-black/55 @min-[34rem]/ph:hidden">
          <ImageIcon className="size-3.5" /> Banner
        </button>
      </div>
      <div className="relative -mt-10 flex items-end gap-x-[18px] gap-y-3 px-5 pb-[18px] @max-[34rem]/ph:flex-wrap" data-profile-row>
        <button type="button" onClick={openAvatarDialog} aria-label="Change picture" data-profile-picture className="group/pic relative order-1 shrink-0 rounded-full outline-ring focus-visible:outline-3 focus-visible:outline-offset-3">
          <span ref={pic} className="block rounded-full shadow-[0_0_0_5px_var(--card)] transition-[filter] duration-150 group-hover/pic:brightness-95">
            <AvatarPic value={avatar} size={phone ? 80 : 88} initial={letter || undefined} className={avatar ? undefined : "shadow-[inset_0_0_0_1px_var(--border)]"} />
          </span>
          <span aria-hidden className="absolute right-[2%] bottom-[2%] grid size-[26px] place-items-center rounded-full bg-card text-foreground shadow-[0_0_0_3px_var(--card),inset_0_0_0_1px_var(--border),0_2px_6px_rgb(0_0_0/0.14)] dark:bg-muted transition-transform duration-150 group-hover/pic:scale-110 motion-reduce:transition-none" data-profile-camera>
            <Camera className="size-[14px]" strokeWidth={2} />
          </span>
        </button>
        <div className="order-2 mt-12 min-w-0 flex-1 pb-0.5 @max-[34rem]/ph:order-3 @max-[34rem]/ph:mt-0 @max-[34rem]/ph:basis-full" data-profile-who>
          <div className="score-serif score-display mb-2.5 min-w-0 text-[26px] leading-[1.15] text-foreground">
            {editing ? (
              <span className="ph-edit relative inline-flex max-w-full items-center gap-1.5 py-0.5" data-profile-name-edit>
                <span className="relative inline-grid min-w-0 max-w-full">
                  <span aria-hidden className="invisible col-start-1 row-start-1 overflow-hidden whitespace-pre pr-1">{name || fallback || "Add your name"}</span>
                  <input
                    ref={input}
                    autoFocus
                    onFocus={(e) => e.currentTarget.select()}
                    value={name}
                    maxLength={40}
                    onChange={(e) => setName(e.target.value)}
                    onBlur={() => void commit()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.preventDefault(), input.current?.blur());
                      else if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), (cancelled.current = true), input.current?.blur());
                    }}
                    placeholder={fallback || "Add your name"}
                    aria-label="Your name"
                    data-profile-name-input
                    className="col-start-1 row-start-1 w-full min-w-[4ch] border-0 bg-transparent p-0 font-[inherit] text-[length:inherit] leading-[inherit] tracking-[inherit] text-foreground caret-primary outline-none selection:bg-primary/25 placeholder:font-sans placeholder:text-[20px] placeholder:leading-[1.5] placeholder:font-medium placeholder:tracking-[-0.01em] placeholder:text-muted-foreground/60"
                  />
                  <span aria-hidden className="ph-line pointer-events-none absolute inset-x-0 -bottom-[5px] h-[2px] origin-left rounded-full bg-primary" />
                </span>
                <span className="ph-acts ml-1 inline-flex shrink-0 items-center gap-1">
                  <button type="button" aria-label="Save name" data-profile-name-save onMouseDown={(e) => e.preventDefault()} onClick={() => input.current?.blur()} className="grid size-7 place-items-center rounded-full bg-primary text-primary-foreground shadow-[0_1px_0_var(--primary-edge,rgb(0_0_0/0.18))] transition-transform hover:scale-105 active:scale-95">
                    <Check className="size-4" strokeWidth={2.6} />
                  </button>
                  <button type="button" aria-label="Cancel" data-profile-name-cancel onMouseDown={(e) => e.preventDefault()} onClick={() => ((cancelled.current = true), input.current?.blur())} className="grid size-7 place-items-center rounded-full bg-muted text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)] transition-[color,transform] hover:scale-105 hover:text-foreground active:scale-95">
                    <X className="size-4" strokeWidth={2.4} />
                  </button>
                </span>
              </span>
            ) : (
              <button type="button" onClick={startEdit} data-profile-name aria-label={`Your name: ${shown || "not set"}. Edit`} className="group/nm -mx-1.5 inline-flex max-w-[calc(100%+0.75rem)] items-center gap-2 rounded-lg px-1.5 py-0.5 text-left outline-ring transition-colors hover:bg-muted focus-visible:outline-2">
                <span className={cn("truncate", !shown && "font-sans text-[20px] leading-[1.5] font-medium tracking-[-0.01em] text-muted-foreground")}>{shown || "Add your name"}</span>
                <Pencil className="size-[15px] shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/nm:opacity-100 group-focus-visible/nm:opacity-100 [@media(pointer:coarse)]:opacity-70" />
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[14px] text-muted-foreground @max-[22rem]/ph:flex-col @max-[22rem]/ph:items-start" data-profile-sub>
            {signedIn ? (
              <>
                {lastSync && (
                  <>
                    <span className="inline-flex items-center gap-[7px]" data-profile-synced>
                      <span aria-hidden className="size-2 rounded-full bg-success" />
                      {syncedAgo(lastSync, now)}
                    </span>
                    <span aria-hidden data-dot className="text-muted-foreground/50 @max-[22rem]/ph:hidden">·</span>
                  </>
                )}
                <span className="min-w-0 [overflow-wrap:anywhere]" data-profile-email>{email}</span>
              </>
            ) : (
              <>
                <span>Only on this device</span>
                <span aria-hidden data-dot className="text-muted-foreground/50 @max-[22rem]/ph:hidden">·</span>
                <button type="button" onClick={goToSignIn} className="font-semibold text-primary underline-offset-2 hover:underline" data-profile-signin>Sign in to sync</button>
              </>
            )}
          </div>
        </div>
        <Button variant="outline" size="sm" className="order-3 mb-2.5 h-9 shrink-0 gap-1.5 @max-[34rem]/ph:hidden" onClick={() => setBannerOpen(true)} data-banner-change>
          <ImageIcon className="size-4 text-muted-foreground" /> Change banner
        </Button>
      </div>
      <span data-settings-title className="sr-only">Banner</span>
      <BannerDialog open={bannerOpen} onOpenChange={setBannerOpen} avatar={avatar} saved={banner} letter={letter} />
    </div>
  );
}

// ---------------------------------------------------------------- "Your banner"

function Tile({ on, onClick, label, children, wide, dashed, data }: { on: boolean; onClick(): void; label: string; children: React.ReactNode; wide?: boolean; dashed?: boolean; data?: Record<string, string> }) {
  return (
    <button type="button" role="radio" aria-checked={on} aria-label={label} onClick={onClick} {...data} className={cn("bn-tile relative h-[46px] rounded-[10px]", wide && "col-span-2", on && "is-on", dashed && "border-[1.5px] border-dashed border-foreground/25")}>
      <span className="absolute inset-0 overflow-hidden rounded-[10px] dark:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.22)]">{children}</span>
    </button>
  );
}

export function BannerDialog({ open, onOpenChange, avatar, saved, letter }: { open: boolean; onOpenChange(o: boolean): void; avatar: Avatar | null; saved: Banner | null; letter: string }) {
  const phone = usePhone();
  const [draft, setDraftState] = useState<Draft>(saved);
  // The last image you had here (saved or uploaded), so its tile can bring it back after trying a colour.
  const [image, setImage] = useState<Extract<Draft, { kind: "image" }> | null>(saved?.kind === "image" ? saved : null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const blobs = useRef<string[]>([]);
  useEffect(() => {
    if (!open) return;
    setDraftState(saved);
    setImage(saved?.kind === "image" ? saved : null);
  }, [open]);
  // Draft image URLs live until the dialog closes.
  useEffect(() => {
    if (open) return;
    const t = window.setTimeout(() => (blobs.current.forEach((u) => URL.revokeObjectURL(u)), (blobs.current = [])), 400);
    return () => window.clearTimeout(t);
  }, [open]);
  const setDraft = (d: Draft) => {
    setDraftState(d);
    if (d?.kind === "image") setImage(d);
  };
  const pick = async (f: File | undefined) => {
    if (!f) return;
    try {
      const { blob, src } = await readBannerImage(f);
      blobs.current.push(src);
      setDraft({ kind: "image", src, blob, y: 50 });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const unchanged = draft?.kind === "image" && "blob" in draft ? false : sameBanner(draft as Banner | null, saved);
  const save = async () => {
    setBusy(true);
    try {
      let b: Banner | null = draft as Banner | null;
      if (draft?.kind === "image" && "blob" in draft) b = { kind: "image", media: await uploadBannerImage(draft.blob), y: draft.y };
      await saveBanner(b);
      toast.success("Banner saved");
      onOpenChange(false);
    } catch (e) {
      toast.error("Couldn't save the banner", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  // Dragging an image up or down sets where it sits.
  const drag = useRef<{ y0: number; s0: number; h: number } | null>(null);
  const isImage = draft?.kind === "image";
  const sameDraft = (d: Draft) => artKey(d, avatar) === artKey(draft, avatar);

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent data-banner-dialog className="flex max-h-[86dvh] sm:max-h-[92dvh] flex-col gap-0 overflow-hidden p-0 pb-[env(safe-area-inset-bottom)] sm:max-w-[600px] sm:rounded-[22px] sm:p-0 sm:data-[state=closed]:slide-out-to-bottom-3 sm:data-[state=open]:slide-in-from-bottom-3">
        <div aria-hidden className="mx-auto mt-2 h-[5px] w-[38px] shrink-0 rounded-full bg-border sm:hidden" />
        <div className="shrink-0 px-5 pt-[3px] pb-3 pr-12 sm:px-[22px] sm:pt-[14px] sm:pr-14">
          <DialogTitle className="score-serif text-[22px] leading-tight font-semibold">Your banner</DialogTitle>
          <DialogDescription className="sr-only">The cover behind your picture at the top of Account & Sync.</DialogDescription>
        </div>
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-5 pb-1 sm:px-[22px]">
          <div
            data-banner-preview
            className={cn("relative mt-1 mb-[30px] h-[110px] touch-none rounded-[14px]", isImage && "cursor-ns-resize")}
            onPointerDown={(e) => {
              if (draft?.kind !== "image") return;
              drag.current = { y0: e.clientY, s0: draft.y, h: e.currentTarget.offsetHeight };
              try {
                e.currentTarget.setPointerCapture(e.pointerId);
              } catch {}
            }}
            onPointerMove={(e) => {
              const g = drag.current;
              if (!g || draft?.kind !== "image") return;
              const y = Math.round(Math.max(0, Math.min(100, g.s0 - ((e.clientY - g.y0) / g.h) * 120)) * 10) / 10;
              if (y !== draft.y) setDraft({ ...draft, y });
            }}
            onPointerUp={() => (drag.current = null)}
            onPointerCancel={() => (drag.current = null)}
          >
            <BannerFade value={draft} avatar={avatar} className="rounded-[14px]" />
            <span className="absolute -bottom-6 left-4 z-[1] rounded-full shadow-[0_0_0_4px_var(--background)]">
              <AvatarPic value={avatar} size={64} initial={letter || undefined} />
            </span>
            {isImage && <span className="pointer-events-none absolute top-2.5 right-2.5 rounded-full bg-black/45 px-2.5 py-1 text-[12px] font-semibold text-white" data-banner-drag>Drag to move</span>}
          </div>

          <div className="score-kicker mb-2">Made from your picture</div>
          <div role="radiogroup" aria-label="Made from your picture" className={cn("grid gap-2.5", phone ? "grid-cols-3" : "grid-cols-6")}>
            <Tile on={sameDraft(null)} onClick={() => setDraft(null)} label="Match my picture" wide data={{ "data-banner-tile": "match" }}>
              <MatchArt avatar={avatar} />
              <span aria-hidden className="absolute inset-0 bg-gradient-to-r from-black/35 via-black/10 to-transparent" />
              <span className="absolute inset-y-0 left-2 flex items-center gap-2 text-[12px] font-semibold whitespace-nowrap text-white [text-shadow:0_1px_3px_rgb(0_0_0/0.4)]">
                <span className="rounded-full shadow-[0_0_0_1.5px_rgb(255_255_255/0.85)]"><AvatarPic value={avatar} size={24} initial={letter || undefined} /></span>
                Match my picture
              </span>
            </Tile>
          </div>

          <div className="score-kicker mt-[18px] mb-2">Colours and patterns</div>
          <div role="radiogroup" aria-label="Colours and patterns" className={cn("grid gap-2.5", phone ? "grid-cols-3" : "grid-cols-6")}>
            {BANNER_PRESETS.map((p) => {
              const v: Banner = { kind: "preset", id: p.id };
              return (
                <Tile key={p.id} on={sameDraft(v)} onClick={() => setDraft(v)} label={p.id} data={{ "data-banner-tile": p.id }}>
                  <BannerArt value={v} avatar={avatar} />
                </Tile>
              );
            })}
          </div>

          <div className="score-kicker mt-[18px] mb-2 flex items-center gap-3">
            <span>Your own image</span>
            {image && (
              <button type="button" onClick={() => file.current?.click()} className="text-[12px] font-semibold tracking-normal text-primary normal-case hover:underline" data-banner-replace>
                Choose another
              </button>
            )}
          </div>
          <div className={cn("grid gap-2.5 pb-1", phone ? "grid-cols-3" : "grid-cols-6")}>
            <input ref={file} type="file" accept="image/*" hidden aria-label="Banner image" data-banner-file onChange={(e) => (void pick(e.target.files?.[0]), (e.target.value = ""))} />
            {image ? (
              <Tile on={isImage} onClick={() => (isImage ? file.current?.click() : setDraft(image))} label="Your image" wide data={{ "data-banner-tile": "image" }}>
                <BannerArt value={image} avatar={avatar} />
              </Tile>
            ) : (
              <Tile on={false} onClick={() => file.current?.click()} label="Upload an image" wide dashed data={{ "data-banner-tile": "upload" }}>
                <span className="absolute inset-0 flex items-center justify-center gap-2 text-[13.5px] font-semibold text-muted-foreground">
                  <ImageIcon className="size-4" /> Upload an image
                </span>
              </Tile>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 px-5 pt-4 pb-4 sm:px-[22px] sm:pb-[22px]">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy || unchanged} data-banner-save>{busy ? "Saving…" : "Save"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
