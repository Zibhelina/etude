// The custom accent picker: a hue/saturation wheel with a draggable pin, a brightness bar, a hex field and a
// live preview of what the accent paints. Opens from a slowly turning rainbow ring.
import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { accentText } from "../../../src/core/themes.ts";
import { cn } from "@/lib/utils";

type Hsv = { h: number; s: number; v: number };

function hsvToHex({ h, s, v }: Hsv): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  const x = (c: number) => Math.round(c * 255).toString(16).padStart(2, "0");
  return `#${x(f(5))}${x(f(3))}${x(f(1))}`;
}

function hexToHsv(hex: string): Hsv {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}

const HUES = `conic-gradient(from 0deg, ${Array.from({ length: 25 }, (_, i) => `hsl(${i * 15} 100% 50%)`).join(", ")})`;
const SOFT = "conic-gradient(from 0deg, #e5604f, #ec8a3c, #e2b53a, #3fae52, #2fb3a6, #5b93f0, #9b7bf0, #ec6aa0, #e5604f)";
const SIZE = 196;

/** Drags with the pointer anywhere after it went down on `el`. */
function useDrag(onMove: (x: number, y: number, rect: DOMRect) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const move = useRef(onMove);
  move.current = onMove;
  const down = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const go = (ev: PointerEvent | React.PointerEvent) => move.current(ev.clientX, ev.clientY, el.getBoundingClientRect());
    go(e);
    const mv = (ev: PointerEvent) => go(ev);
    const up = () => {
      el.removeEventListener("pointermove", mv);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", mv);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  return { ref, onPointerDown: down };
}

export function AccentWheel({ value, fallback, onChange, onCommit }: {
  /** The custom accent in use, or null when a preset or the theme's own is. */
  value: string | null;
  /** Where the wheel starts when no custom color is in use. */
  fallback: string;
  onChange(hex: string): void;
  /** "Use this color": save it now and close. */
  onCommit(hex: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value ?? fallback));
  const [text, setText] = useState(value ?? fallback);
  useEffect(() => {
    if (!open) return;
    const start = value ?? fallback;
    setHsv(hexToHsv(start));
    setText(start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const hex = hsvToHex(hsv);
  const set = (next: Hsv) => {
    setHsv(next);
    const h = hsvToHex(next);
    setText(h);
    onChange(h);
  };

  const wheel = useDrag((x, y, r) => {
    const dx = x - (r.left + r.width / 2), dy = y - (r.top + r.height / 2);
    const h = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
    const s = Math.min(1, Math.hypot(dx, dy) / (r.width / 2));
    set({ ...hsv, h, s, v: hsv.v < 0.25 ? 0.85 : hsv.v });
  });
  const bar = useDrag((x, _y, r) => set({ ...hsv, v: Math.max(0, Math.min(1, (x - r.left) / r.width)) }));

  const rad = (hsv.h * Math.PI) / 180;
  const pin = { x: SIZE / 2 + Math.sin(rad) * hsv.s * (SIZE / 2), y: SIZE / 2 - Math.cos(rad) * hsv.s * (SIZE / 2) };
  const fg = accentText(hex);
  const nudge = (e: React.KeyboardEvent, key: "h" | "s" | "v", step: number, mod = 0) => {
    const k = e.key;
    const d = k === "ArrowRight" || k === "ArrowUp" ? step : k === "ArrowLeft" || k === "ArrowDown" ? -step : 0;
    if (!d) return;
    e.preventDefault();
    const n = hsv[key] + d * (e.shiftKey ? 5 : 1);
    set({ ...hsv, [key]: mod ? (n + mod) % mod : Math.max(0, Math.min(1, n)) });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="radio"
          aria-checked={!!value}
          aria-label="Custom accent color"
          title="Pick any color"
          className={cn(
            "group/wheel relative flex size-9 items-center justify-center rounded-full outline-none transition-transform hover:scale-110 focus-visible:ring-[3px] focus-visible:ring-ring/50",
            value && "ring-2 ring-foreground ring-offset-2 ring-offset-card",
          )}
        >
          <span
            aria-hidden="true"
            className="accent-wheel-spin absolute inset-0 rounded-full blur-[6px] opacity-0 transition-opacity group-hover/wheel:opacity-70"
            style={{ background: SOFT }}
          />
          <span aria-hidden="true" className="accent-wheel-spin absolute inset-0 rounded-full" style={{ background: SOFT }} />
          <span
            aria-hidden="true"
            className="relative flex size-[22px] items-center justify-center rounded-full shadow-[0_1px_3px_rgb(0_0_0/0.3)] transition-transform group-hover/wheel:scale-110"
            style={{ background: value ?? "var(--card)" }}
          >
            {value ? (
              <Check className="size-3.5" style={{ color: accentText(value) }} strokeWidth={3} />
            ) : (
              <span className="size-2 rounded-full" style={{ background: "radial-gradient(circle at 35% 35%, #fff, #bbb)" }} />
            )}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={10} className="w-[244px] rounded-2xl p-[18px]">
        <div className="flex flex-col items-center gap-4">
          <div
            {...wheel}
            role="slider"
            tabIndex={0}
            aria-label="Hue"
            aria-valuemin={0}
            aria-valuemax={360}
            aria-valuenow={Math.round(hsv.h)}
            onKeyDown={(e) => nudge(e, "h", 3, 360)}
            className="relative cursor-crosshair touch-none rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            style={{ width: SIZE, height: SIZE }}
          >
            <div className="absolute inset-0 rounded-full" style={{ background: HUES }} />
            <div className="absolute inset-0 rounded-full" style={{ background: "radial-gradient(circle closest-side, #fff, rgb(255 255 255 / 0.6) 35%, transparent)" }} />
            <div className="absolute inset-0 rounded-full bg-black transition-opacity" style={{ opacity: 1 - hsv.v }} />
            <div className="absolute inset-0 rounded-full ring-1 ring-black/10 ring-inset" />
            <div
              className="pointer-events-none absolute size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white shadow-[0_2px_8px_rgb(0_0_0/0.35),inset_0_0_0_1px_rgb(0_0_0/0.15)]"
              style={{ left: pin.x, top: pin.y, background: hex }}
            />
          </div>

          <div
            {...bar}
            role="slider"
            tabIndex={0}
            aria-label="Brightness"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(hsv.v * 100)}
            onKeyDown={(e) => nudge(e, "v", 0.02)}
            className="relative h-3.5 w-full cursor-pointer touch-none rounded-full outline-none ring-1 ring-foreground/20 ring-inset focus-visible:ring-[3px] focus-visible:ring-ring/50"
            style={{ background: `linear-gradient(90deg, #000, ${hsvToHex({ ...hsv, v: 1 })})` }}
          >
            <div
              className="pointer-events-none absolute top-1/2 size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white shadow-[0_1px_5px_rgb(0_0_0/0.35)]"
              style={{ left: `${hsv.v * 100}%`, background: hex }}
            />
          </div>

          <div className="flex w-full flex-col gap-3">
            <input
              value={text}
              spellCheck={false}
              aria-label="Hex color"
              maxLength={7}
              className="h-9 w-full rounded-full bg-background px-3 ring-1 ring-border text-center font-mono text-[13px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              onChange={(e) => {
                const t = e.target.value.trim();
                setText(t);
                const h = (t.startsWith("#") ? t : `#${t}`).toLowerCase();
                if (/^#[0-9a-f]{6}$/.test(h)) {
                  setHsv(hexToHsv(h));
                  onChange(h);
                }
              }}
            />
            <button
              type="button"
              onClick={() => {
                onCommit(hex);
                setOpen(false);
              }}
              className="flex h-10 w-full shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-4 text-[13.5px] font-semibold shadow-[0_3px_0_var(--edge)] outline-none transition-[transform,box-shadow] hover:brightness-105 focus-visible:ring-[3px] focus-visible:ring-ring/50 active:translate-y-[3px] active:shadow-none"
              style={{ background: hex, color: fg, ["--edge" as string]: `color-mix(in oklab, ${hex} 72%, black)` }}
            >
              <Check className="size-3.5" strokeWidth={3} />Use this color
            </button>
          </div>
          <p className="-mt-1 w-full text-center text-[12px] text-muted-foreground">
            Drag the pin. Buttons, <span style={{ color: hex }} className="font-medium underline underline-offset-2 brightness-125">links</span> and charts follow.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
