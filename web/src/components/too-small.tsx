// When the window gets smaller than even the phone layout can hold, the app steps aside and Minimi's head takes
// the whole window, like a liquid poured into it: no hat, no body, just his face. A short, wide window spreads his
// eyes to the far edges and his glasses bridge stretches like gum until it snaps and each lens hangs on its own; a
// narrow one squeezes his face tall and angry. Each shape is a painting (made from a sketch of that shape) stretched
// to the window, and a spring makes him wobble into the new size. Fun mode off shows the same note without him.
import { useEffect, useRef, useState } from "react";
import gum from "@/assets/minimi/squish/gum.webp";
import snap from "@/assets/minimi/squish/snap.webp";
import tall from "@/assets/minimi/squish/tall.webp";
import { useFunMode } from "@/lib/fun";

const MIN_W = 280;
const MIN_H = 340;
// Width ÷ height past which the bridge gives way.
const SNAP_RATIO = 2.6;

const size = () => [window.innerWidth, window.innerHeight] as const;

export function useTooSmall() {
  const [s, setS] = useState(size);
  useEffect(() => {
    const h = () => setS(size());
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  const [w, h] = s;
  const on = w < MIN_W || h < MIN_H;
  const pose = w / h < 1 ? "tall" : w / h > SNAP_RATIO ? "snap" : "gum";
  return { on, w, h, pose } as const;
}

type Pose = ReturnType<typeof useTooSmall>["pose"];

/** The size the face is drawn at chases the real one with a little overshoot, so it settles like jelly. */
function useJelly(w: number, h: number) {
  const reduce = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const st = useRef({ x: w * 1.15, y: h * 0.85, vx: 0, vy: 0 });
  const [v, setV] = useState<[number, number]>(reduce ? [w, h] : [st.current.x, st.current.y]);
  useEffect(() => {
    if (reduce) return setV([w, h]);
    let raf = 0;
    const tick = () => {
      const s = st.current;
      s.vx = (s.vx + (w - s.x) * 0.13) * 0.8;
      s.vy = (s.vy + (h - s.y) * 0.13) * 0.8;
      s.x += s.vx;
      s.y += s.vy;
      if (Math.abs(w - s.x) + Math.abs(h - s.y) + Math.abs(s.vx) + Math.abs(s.vy) < 0.2) {
        Object.assign(s, { x: w, y: h, vx: 0, vy: 0 });
        setV([w, h]);
        return;
      }
      setV([s.x, s.y]);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [w, h, reduce]);
  return v;
}

const ART = { gum, snap, tall } as const;
// Width ÷ height each painting was made at.
const ART_RATIO = { gum: 900 / 600, snap: 900 / 333, tall: 600 / 900 } as const;
// How far a painting may stretch from its own shape before the window just crops it.
const MAX_STRETCH = 1.35;

/** His face, painted from the sketch for each shape, stretched to the window and wobbling when it changes. Past
 *  MAX_STRETCH it stops deforming: the face keeps that shape and the window crops it, centred. */
function Head({ w, h, pose }: { w: number; h: number; pose: Pose }) {
  const [jw, jh] = useJelly(w, h);
  const art = ART_RATIO[pose];
  const a = Math.min(art * MAX_STRETCH, Math.max(art / MAX_STRETCH, w / h));
  const [ew, eh] = w / h > a ? [w, w / a] : [h * a, h];
  return (
    <img
      src={ART[pose]}
      alt=""
      draggable={false}
      className="absolute max-w-none select-none object-fill"
      style={{ width: ew, height: eh, left: (w - ew) / 2, top: (h - eh) / 2, transform: `scale(${jw / w}, ${jh / h})` }}
    />
  );
}

export function TooSmall({ pose, w, h }: { pose: Pose; w: number; h: number }) {
  const fun = useFunMode();
  const line = pose === "snap" ? "You broke his glasses." : pose === "tall" ? "A little wider, please." : "It's getting tight in here.";
  return (
    <div className="too-small fixed inset-0 z-[200] overflow-hidden bg-background" role="alert">
      {fun && <Head w={w} h={h} pose={pose} />}
      <div className={fun ? "absolute inset-x-0 bottom-2 flex justify-center px-2" : "grid h-full place-items-center p-3"}>
        <div className="max-w-[calc(100%-1rem)] rounded-2xl bg-background/85 px-3 py-1.5 text-center shadow-sm backdrop-blur-md">
          <p className="browse-serif text-[14px] leading-tight text-foreground">{line}</p>
          {(!fun || h >= 260) && <p className="text-balance text-[11px] leading-tight text-muted-foreground">Make the window bigger to keep studying.</p>}
        </div>
      </div>
    </div>
  );
}
