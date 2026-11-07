// First-run setup's "Who's studying?" step: a carousel of the 18 characters (swipe, arrow keys, the round arrows on
// its sides, or Surprise me, which spins like a slot machine), the name you want to be called, and "or · Emoji | Photo"
// for the other kinds. Self-contained, so the step can move within setup: it saves the picture and name itself and
// calls onNext.
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Dices, Upload } from "lucide-react";
import { toast } from "sonner";
import { AVATAR_EMOJI_BG, CHARACTERS, avatarNow, saveAvatar, saveProfile, useMyName, type Avatar } from "@/lib/avatar";
import { useNarrow } from "@/lib/device";
import { cn } from "@/lib/utils";
import { AvatarPic, EmojiPanel, PhotoPanel, finishPick, type AvatarPick, type PhotoDraft } from "@/components/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Foot, Primary, Title, fieldClass } from "@/components/onboarding-ui";

const N = CHARACTERS.length;
/** Signed distance from the centre on the ring of characters. */
const offset = (i: number, c: number) => {
  let d = i - c;
  if (d > N / 2) d -= N;
  if (d < -N / 2) d += N;
  return d;
};
const reduced = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
/** The longest name settings.name keeps. */
const NAME_MAX = 40;

export function AvatarStep({ onNext }: { onNext(): void }) {
  const phone = useNarrow();
  const start = avatarNow();
  const savedName = useMyName();
  const [name, setName] = useState(savedName);
  const [car, setCar] = useState(() => Math.max(0, CHARACTERS.findIndex((c) => start?.kind === "char" && c.id === start.id)));
  const [pick, setPick] = useState<AvatarPick>(start);
  const [spinning, setSpinning] = useState(false);
  const [spinMs, setSpinMs] = useState(120);
  const [landKey, setLandKey] = useState(0);
  const [sheet, setSheet] = useState<null | "emoji" | "photo">(null);
  const [busy, setBusy] = useState(false);
  const prevD = useRef(new Map<number, number>());
  const timer = useRef<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(520);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 520));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const move = (i: number) => !spinning && setCar(((i % N) + N) % N);
  const cur = CHARACTERS[car];

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
  const big = Math.min(phone ? 128 : 156, width * 0.34);
  const sizes = [1, 0.62, 0.42, 0.3].map((k) => big * k);
  const gap = phone ? 10 : 18;
  const places = [0];
  for (let k = 1; k < sizes.length; k++) places.push(places[k - 1] + sizes[k - 1] / 2 + gap + sizes[k] / 2);
  const fade = [1, 1, 0.6, 0.3];
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

  /** Saves the picture, and the name when one was typed (an empty box leaves the saved name as it is). */
  const save = async (a: Avatar | null) => {
    const n = name.trim().slice(0, NAME_MAX);
    if (n && n !== savedName) await saveProfile(a ?? avatarNow(), n);
    else if (a) await saveAvatar(a);
  };
  const finish = async (p: AvatarPick, draft?: PhotoDraft | null) => {
    setBusy(true);
    try {
      const a = await finishPick(p, draft ?? null);
      setPick(a);
      await save(a);
      setSheet(null);
      onNext();
    } catch (e) {
      toast.error("Couldn't save the picture", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Title eyebrow="Your profile" lead="Pick a face and tell us what to call you. You can change both any time.">Who's studying?</Title>
      <div ref={box} className="relative mt-5 w-full md:mt-[26px]" data-avatar-step>
        <div
          className={cn("av-car relative flex items-center justify-center overflow-hidden", phone ? "h-[150px]" : "h-[178px]", spinning && "is-spin")}
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
              aria-label={c.alt}
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
              <span key={ad === 0 ? landKey : 0} className={cn(ad === 0 && landKey > 0 && "av-land", "relative", ad === 0 && "ob-car-on")}>
                <img src={c.src} alt="" draggable={false} className="size-full rounded-full object-cover" />
              </span>
            </button>
          ))}
        </div>
        <button type="button" aria-label="Previous" onClick={() => move(car - 1)} disabled={spinning} className="ob-round absolute top-1/2 left-0 z-20 -translate-y-1/2" data-avatar-prev>
          <ChevronLeft className="size-[18px]" />
        </button>
        <button type="button" aria-label="Next" onClick={() => move(car + 1)} disabled={spinning} className="ob-round absolute top-1/2 right-0 z-20 -translate-y-1/2" data-avatar-next>
          <ChevronRight className="size-[18px]" />
        </button>
      </div>
      <div className="mx-auto mt-3 w-full max-w-[300px]">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, NAME_MAX))}
          maxLength={NAME_MAX}
          placeholder="Your name"
          aria-label="Your name"
          autoComplete="nickname"
          spellCheck={false}
          className={cn(fieldClass, "text-center text-[15.5px] font-semibold md:text-[15.5px]")}
          data-avatar-name
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
        <button type="button" disabled={spinning} onClick={surprise} className="ob-sbtn" data-avatar-surprise>
          <Dices className="size-4" /> Surprise me
        </button>
        <div className="flex h-9 items-center gap-0.5 rounded-full pr-[3px] pl-3 text-[13px] text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)] md:h-9" data-avatar-or>
          <span className="mr-1.5">or</span>
          <button type="button" onClick={() => setSheet("emoji")} className="inline-flex h-[30px] items-center rounded-full px-2.5 font-medium text-foreground transition-colors hover:bg-accent" data-avatar-sheet="emoji">
            Emoji
          </button>
          <i aria-hidden className="h-[18px] w-px bg-border" />
          <button type="button" onClick={() => setSheet("photo")} className="inline-flex h-[30px] items-center gap-[5px] rounded-full px-2.5 font-medium text-foreground transition-colors hover:bg-accent" data-avatar-sheet="photo">
            <Upload className="size-3.5" /> Photo
          </button>
        </div>
      </div>
      <Foot>
        <Primary onClick={() => void finish({ kind: "char", id: cur.id })} busy={busy} disabled={spinning}>
          Use this one
        </Primary>
      </Foot>
      <PickSheet kind={sheet} pick={pick} busy={busy} onClose={() => setSheet(null)} onUse={(p, draft) => void finish(p, draft)} onRemove={() => (setPick(null), setSheet(null))} />
    </>
  );
}

/** The emoji or photo sheet from "or". "Use this" saves it and moves on. */
function PickSheet({ kind, pick, busy, onClose, onUse, onRemove }: { kind: null | "emoji" | "photo"; pick: AvatarPick; busy: boolean; onClose(): void; onUse(p: AvatarPick, draft?: PhotoDraft | null): void; onRemove(): void }) {
  const [emoji, setEmoji] = useState({ e: pick?.kind === "emoji" ? pick.e : "🦊", bg: pick?.kind === "emoji" ? pick.bg : AVATAR_EMOJI_BG });
  const [draft, setDraft] = useState<PhotoDraft | null>(null);
  useEffect(() => {
    if (!kind) setDraft((d) => (d && URL.revokeObjectURL(d.src), null));
  }, [kind]);
  const value: AvatarPick = kind === "emoji" ? { kind: "emoji", ...emoji } : draft ? { kind: "draft" } : pick?.kind === "photo" ? pick : null;
  return (
    <Dialog open={!!kind} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent data-avatar-pick-sheet={kind ?? undefined} className="flex max-h-[92dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px] sm:rounded-[22px] sm:p-0">
        <div aria-hidden className="mx-auto mt-2 h-[5px] w-[38px] rounded-full bg-border desktop:hidden" />
        <div className="flex items-center gap-4 px-5 pt-3.5 pb-3 pr-12 sm:px-6 sm:pt-[22px]">
          <span key={JSON.stringify(value) + (draft?.src ?? "")} className="av-fade flex"><AvatarPic value={value} size={64} draft={draft} /></span>
          <div className="min-w-0 flex-1 text-left">
            <DialogTitle className="text-[19px] font-semibold">{kind === "photo" ? "Your photo" : "Emoji"}</DialogTitle>
            <DialogDescription className="mt-1 text-[13.5px]">{kind === "photo" ? "Cropped to a circle." : "On a colour of your choice."}</DialogDescription>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-1 pb-[18px] sm:px-6">
          {kind === "emoji" && <EmojiPanel emoji={emoji.e} bg={emoji.bg} picked onChange={(e, bg) => setEmoji({ e, bg })} />}
          {kind === "photo" && <PhotoPanel draft={draft} onDraft={(d) => setDraft((old) => (old && old.src !== d?.src && URL.revokeObjectURL(old.src), d))} saved={pick?.kind === "photo" ? pick : null} onRemove={onRemove} />}
        </div>
        <div className="flex items-center justify-end gap-2 border-t px-5 py-3.5 sm:px-6">
          <Button variant="outline" onClick={onClose} disabled={busy}>Back</Button>
          <Button onClick={() => onUse(value, draft)} disabled={busy || !value || (kind === "photo" && !draft && pick?.kind !== "photo")} data-avatar-sheet-use>{busy ? "Saving…" : "Use this"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
