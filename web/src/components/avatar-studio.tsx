// First-run setup's "Who's studying?" step: a carousel of the 18 characters (swipe, arrow keys, or Surprise me, which
// spins like a slot machine), and "or use · An emoji | Your photo" for the other kinds. Self-contained, so the step
// can move within setup: it saves the picture itself and calls onNext.
import { useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Dices, Loader2, Smile, Upload } from "lucide-react";
import { toast } from "sonner";
import { AVATAR_EMOJI_BG, CHARACTERS, avatarNow, saveAvatar, type Avatar } from "@/lib/avatar";
import { usePhone } from "@/lib/phone";
import { useFunMode } from "@/lib/fun";
import { cn } from "@/lib/utils";
import { AvatarPic, EmojiPanel, PhotoPanel, finishPick, type AvatarPick, type PhotoDraft } from "@/components/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import minimiLook from "@/assets/minimi/look.webp";

const N = CHARACTERS.length;
/** Signed distance from the centre on the ring of characters. */
const offset = (i: number, c: number) => {
  let d = i - c;
  if (d > N / 2) d -= N;
  if (d < -N / 2) d += N;
  return d;
};
const reduced = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function bubble(id: string, mine: boolean, pick: AvatarPick) {
  if (pick?.kind === "emoji") return "Minimalist. I respect it.";
  if (pick?.kind === "photo") return "Ooh, the real you.";
  if (mine) return "Good choice. Very scholarly.";
  if (id === "bear") return "Bramble isn't a morning bear either.";
  return "Take your time. I went with the hat.";
}

export function AvatarStep({ onNext, title }: { onNext(): void; title?: React.ReactNode }) {
  const phone = usePhone();
  const fun = useFunMode();
  const start = avatarNow();
  const [car, setCar] = useState(() => Math.max(0, CHARACTERS.findIndex((c) => start?.kind === "char" && c.id === start.id)));
  const [pick, setPick] = useState<AvatarPick>(start);
  const [spinning, setSpinning] = useState(false);
  const [spinMs, setSpinMs] = useState(120);
  const [landKey, setLandKey] = useState(0);
  const [sheet, setSheet] = useState<null | "emoji" | "photo">(null);
  const [busy, setBusy] = useState(false);
  const prevD = useRef(new Map<number, number>());
  const timer = useRef<number | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const move = (i: number) => !spinning && setCar(((i % N) + N) % N);
  const cur = CHARACTERS[car];
  const mine = pick?.kind === "char" && pick.id === cur.id;

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (sheet || document.querySelector("[role=dialog]") || (e.target as HTMLElement)?.closest?.("input,textarea")) return;
      if (e.key === "ArrowLeft") (e.preventDefault(), move(car - 1));
      if (e.key === "ArrowRight") (e.preventDefault(), move(car + 1));
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  // Surprise me: at least one full lap, ticks slowing on an ease-out curve (~5 s), then a bounce where it lands.
  const surprise = () => {
    if (spinning) return;
    const extra = 1 + Math.floor(Math.random() * 9);
    if (reduced()) return void setCar((c) => (c + extra) % N);
    const steps = N + extra;
    let k = 0;
    setSpinning(true);
    const tick = () => {
      k++;
      const t = k / steps;
      const d = Math.round(60 + Math.pow(t, 3) * 560);
      setSpinMs(Math.min(d * 0.95, 700));
      setCar((c) => (c + 1) % N);
      if (k < steps) timer.current = window.setTimeout(tick, d);
      else
        timer.current = window.setTimeout(() => {
          setSpinning(false);
          setLandKey((n) => n + 1);
        }, 420);
    };
    tick();
  };

  // Swipe: a horizontal drag of 40 px or more moves one place.
  const swipe = useRef<{ x: number } | null>(null);
  const swiped = useRef(false);

  // Sizes by distance from the centre, and each place's offset so neighbouring tiles keep the same gap.
  const big = phone ? 168 : 196;
  const sizes = [1, 0.62, 0.42, 0.3].map((k) => big * k);
  const gap = phone ? 10 : 22;
  const places = [0];
  for (let k = 1; k < sizes.length; k++) places.push(places[k - 1] + sizes[k - 1] / 2 + gap + sizes[k] / 2);
  const fade = phone ? [1, 1, 0.45, 0] : [1, 1, 0.7, 0.4];
  const tiles = CHARACTERS.map((c, i) => {
    const d = offset(i, car);
    const ad = Math.abs(d);
    const sz = sizes[Math.min(ad, 3)];
    // Tiles further out wait, hidden, at the last place, so nothing sits outside the carousel.
    const x = Math.sign(d) * places[Math.min(ad, 3)];
    const was = prevD.current.get(i);
    // A tile wrapping from one end to the other jumps instead of flying across.
    const jump = was !== undefined && Math.sign(was) !== Math.sign(d) && Math.abs(was) >= 3;
    return { c, i, d, ad, sz, x, jump, op: ad > 3 ? 0 : fade[ad] };
  });
  useEffect(() => {
    for (const t of tiles) prevD.current.set(t.i, t.d);
  });

  const keep = async (p: AvatarPick, draft?: PhotoDraft | null) => {
    setBusy(true);
    try {
      const a = await finishPick(p, draft ?? null);
      setPick(a);
      setSheet(null);
    } catch (e) {
      toast.error("Couldn't use that picture", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const next = async () => {
    setBusy(true);
    try {
      if (pick && pick.kind !== "draft") await saveAvatar(pick as Avatar);
      onNext();
    } catch (e) {
      toast.error("Couldn't save the picture", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex flex-1 flex-col items-center justify-center gap-[18px] pb-4 text-center md:flex-none md:gap-3.5 md:pt-2" data-avatar-step>
      <div>
        <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.02em] md:text-[30px]">{title ?? "Who's studying?"}</h1>
        <p className="mt-1.5 text-[14.5px] text-balance text-muted-foreground">Pick a face for your profile. You can change it any time.</p>
      </div>
      <div
        className={cn("av-car relative flex overflow-hidden items-center justify-center", phone ? "-mx-5 h-[196px] w-[calc(100%+2.5rem)]" : "h-[212px] w-full max-w-[820px]", spinning && "is-spin")}
        style={{ ["--sd" as string]: `${spinMs}ms` }}
        data-avatar-carousel
        onPointerDown={(e) => (swipe.current = { x: e.clientX })}
        onPointerUp={(e) => {
          const s = swipe.current;
          swipe.current = null;
          if (!s) return;
          const dx = e.clientX - s.x;
          if (Math.abs(dx) > 40) {
            swiped.current = true;
            move(car + (dx < 0 ? 1 : -1));
            setTimeout(() => (swiped.current = false), 50);
          }
        }}
      >
        {tiles.map(({ c, i, ad, sz, x, jump, op }) => (
          <button
            key={c.id}
            type="button"
            aria-label={c.name}
            aria-current={ad === 0 || undefined}
            tabIndex={ad === 0 ? 0 : -1}
            data-car={i}
            onClick={() => !swiped.current && move(i)}
            className="av-car-it"
            style={{
              width: sz,
              height: sz,
              transform: `translate(calc(-50% + ${x}px), -50%)`,
              opacity: op,
              zIndex: 10 - Math.min(ad, 9),
              filter: ad ? "saturate(.7)" : "none",
              pointerEvents: op === 0 ? "none" : undefined,
              transition: jump ? "none" : undefined,
            }}
          >
            <span key={ad === 0 ? landKey : 0} className={cn(ad === 0 && landKey > 0 && "av-land", "relative", ad === 0 && mine && "is-on")}>
              <img src={c.src} alt="" draggable={false} className="size-full rounded-full object-cover" />
            </span>
          </button>
        ))}
      </div>
      <div key={car} className="av-name-in min-h-5 text-[17px] leading-none font-semibold" data-avatar-carname>{cur.name}</div>
      <div className="flex items-center gap-3">
        <button type="button" aria-label="Previous" onClick={() => move(car - 1)} disabled={spinning} className="grid size-[42px] place-items-center rounded-full border bg-background transition-colors hover:bg-accent disabled:opacity-50"><ChevronLeft className="size-[18px]" /></button>
        <span className="min-w-[52px] text-[13px] text-muted-foreground tabular-nums" data-avatar-count>{car + 1} / {N}</span>
        <button type="button" aria-label="Next" onClick={() => move(car + 1)} disabled={spinning} className="grid size-[42px] place-items-center rounded-full border bg-background transition-colors hover:bg-accent disabled:opacity-50"><ChevronRight className="size-[18px]" /></button>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button className="h-10 gap-1.5 px-4" disabled={spinning} onClick={() => setPick({ kind: "char", id: cur.id })} data-avatar-use>
          {mine ? <><Check className="size-4" strokeWidth={2.6} /> This is me</> : <>Use {cur.name}</>}
        </Button>
        <Button variant="outline" className="h-10 gap-1.5 px-4" disabled={spinning} onClick={surprise} data-avatar-surprise><Dices className="size-4" /> Surprise me</Button>
      </div>
      <div className="mt-1 flex h-9 items-center gap-0.5 rounded-full border pr-[3px] pl-3 text-[13px] text-muted-foreground" data-avatar-or>
        <span className="mr-1.5">or use</span>
        <button type="button" onClick={() => setSheet("emoji")} className={cn("inline-flex h-[30px] items-center gap-1.5 rounded-full px-2.5 font-medium text-foreground transition-colors hover:bg-accent", pick?.kind === "emoji" && "bg-accent")} data-avatar-sheet="emoji">
          {pick?.kind === "emoji" ? <AvatarPic value={pick} size={18} /> : <Smile className="size-[15px]" />} An emoji
        </button>
        <i aria-hidden className="h-[18px] w-px bg-border" />
        <button type="button" onClick={() => setSheet("photo")} className={cn("inline-flex h-[30px] items-center gap-1.5 rounded-full px-2.5 font-medium text-foreground transition-colors hover:bg-accent", pick?.kind === "photo" && "bg-accent")} data-avatar-sheet="photo">
          {pick?.kind === "photo" ? <AvatarPic value={pick} size={18} /> : <Upload className="size-[15px]" />} Your photo
        </button>
      </div>
      <button onClick={() => void next()} disabled={busy || spinning} data-avatar-continue className="mt-3 flex h-12 w-full max-w-[420px] shrink-0 items-center justify-center gap-2 rounded-full bg-primary text-[15px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40 md:mt-4">
        {busy && <Loader2 className="size-4 animate-spin" />}
        Continue
      </button>
      {fun && !phone && (
        <div aria-hidden className="pointer-events-none fixed bottom-0 left-7 hidden items-end gap-2.5 lg:flex">
          <img src={minimiLook} alt="" className="w-16" />
          <div key={`${car}-${JSON.stringify(pick)}`} className="av-pop mb-[30px] max-w-[250px] rounded-[16px_16px_16px_4px] bg-muted px-3 py-2 text-left text-[13.5px] leading-snug text-foreground">{bubble(cur.id, mine, pick)}</div>
        </div>
      )}
      <PickSheet kind={sheet} pick={pick} busy={busy} onClose={() => setSheet(null)} onUse={keep} />
    </div>
  );
}

/** The emoji or photo sheet from "or use". */
function PickSheet({ kind, pick, busy, onClose, onUse }: { kind: null | "emoji" | "photo"; pick: AvatarPick; busy: boolean; onClose(): void; onUse(p: AvatarPick, draft?: PhotoDraft | null): void }) {
  const [emoji, setEmoji] = useState({ e: pick?.kind === "emoji" ? pick.e : "🦊", bg: pick?.kind === "emoji" ? pick.bg : AVATAR_EMOJI_BG });
  const [draft, setDraft] = useState<PhotoDraft | null>(null);
  useEffect(() => {
    if (!kind) setDraft((d) => (d && URL.revokeObjectURL(d.src), null));
  }, [kind]);
  const value: AvatarPick = kind === "emoji" ? { kind: "emoji", ...emoji } : draft ? { kind: "draft" } : pick?.kind === "photo" ? pick : null;
  return (
    <Dialog open={!!kind} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent data-avatar-pick-sheet={kind ?? undefined} className="flex max-h-[92dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px] sm:rounded-[22px] sm:p-0">
        <div aria-hidden className="mx-auto mt-2 h-[5px] w-[38px] rounded-full bg-border sm:hidden" />
        <div className="flex items-center gap-4 px-5 pt-3.5 pb-3 pr-12 sm:px-6 sm:pt-[22px]">
          <span key={JSON.stringify(value) + (draft?.src ?? "")} className="av-pop flex"><AvatarPic value={value} size={64} draft={draft} /></span>
          <div className="min-w-0 flex-1 text-left">
            <DialogTitle className="text-[19px] font-semibold">{kind === "photo" ? "Your photo" : "Emoji"}</DialogTitle>
            <DialogDescription className="mt-1 text-[13.5px]">{kind === "photo" ? "Cropped to a circle." : "On a colour of your choice."}</DialogDescription>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-1 pb-[18px] sm:px-6">
          {kind === "emoji" && <EmojiPanel emoji={emoji.e} bg={emoji.bg} picked onChange={(e, bg) => setEmoji({ e, bg })} />}
          {kind === "photo" && <PhotoPanel draft={draft} onDraft={(d) => setDraft((old) => (old && old.src !== d?.src && URL.revokeObjectURL(old.src), d))} saved={pick?.kind === "photo" ? pick : null} onRemove={() => onUse(null)} />}
        </div>
        <div className="flex items-center justify-end gap-2 border-t px-5 py-3.5 sm:px-6">
          <Button variant="outline" onClick={onClose} disabled={busy}>Back</Button>
          <Button onClick={() => onUse(value, draft)} disabled={busy || !value || (kind === "photo" && !draft && pick?.kind !== "photo")} data-avatar-sheet-use>{busy ? "Saving…" : "Use this"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
