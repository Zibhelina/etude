// A body drawn by four short clips instead of still frames: it reads (eyes along the lines, glances around),
// and when you're on it (hover, drag, chat, menu) it raises its eyes to you, keeps looking while you stay, then
// lowers them back to the book. A clip that's playing always finishes first, so it never jumps from one pose to
// another. Minimi's Christmas outfit uses his own clips; another agent profile's body can bring its own set
// (`clips` in src/core/agent-profiles.ts), with its body picture shown until the first frame is drawn.
// Clips are VP9 with alpha (WebM), which WebKit can't draw, so Safari/iPad and reduced motion keep the still
// frames or picture (`clipsOk`).
// Each clip comes in two heights, and it plays the one closest above its size on screen: a browser scales a
// video down with a plain bilinear filter, so a much bigger video drawn small comes out with jagged edges.
import { useEffect, useRef, useState } from "react";
import read248 from "@/assets/minimi/natal/read-loop-248.webm";
import read533 from "@/assets/minimi/natal/read-loop-533.webm";
import up248 from "@/assets/minimi/natal/look-up-248.webm";
import up533 from "@/assets/minimi/natal/look-up-533.webm";
import look248 from "@/assets/minimi/natal/look-loop-248.webm";
import look533 from "@/assets/minimi/natal/look-loop-533.webm";
import down248 from "@/assets/minimi/natal/look-down-248.webm";
import down533 from "@/assets/minimi/natal/look-down-533.webm";
import { EtudeImg, useEtudeSrc } from "@/lib/local-url";
import { mediaUrl } from "@/lib/agent-profiles";
import { clipSrc, type AgentClips } from "../../../src/core/agent-profiles.ts";
import { cn } from "@/lib/utils";

type Tier = 248 | 533;
type Clip = "read" | "up" | "look" | "down";
export type ClipSources = Record<Tier, Record<Clip, string | undefined>>;

const MINIMI: ClipSources = {
  248: { read: read248, up: up248, look: look248, down: down248 },
  533: { read: read533, up: up533, look: look533, down: down533 },
};
const CLIPS: Clip[] = ["read", "up", "look", "down"];
/** The smaller video while it's drawn at most 248 device pixels tall, the bigger one above that. */
const tierFor = (el: Element | null): Tier => ((el?.getBoundingClientRect().height ?? 0) * (window.devicePixelRatio || 1) > 248 ? 533 : 248);

export const clipsOk = () => {
  if (typeof navigator === "undefined" || typeof matchMedia !== "function") return false;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  const ua = navigator.userAgent;
  return /Chrome|Chromium|Firefox|Edg\//.test(ua) || !/AppleWebKit/.test(ua);
};

/** Minimi in his Christmas outfit, or any body given its clip URLs. `onShown` fires when the first frame is on screen. */
export function MinimiClips({ attention, srcs = MINIMI, onShown }: { attention: boolean; srcs?: ClipSources; onShown?: () => void }) {
  const els = useRef<Partial<Record<Clip, HTMLVideoElement>>>({});
  const cur = useRef<Clip | null>(null);
  const busy = useRef(false);
  const want = useRef(attention);
  const box = useRef<HTMLSpanElement>(null);
  const [tier, setTier] = useState<Tier>(248);
  const shown = useRef(onShown);
  shown.current = onShown;

  const show = (k: Clip, then?: () => void) => {
    const el = els.current[k];
    if (!el || !el.getAttribute("src")) return;
    busy.current = !!then;
    el.onended = then ? () => { busy.current = false; then(); } : null;
    el.currentTime = 0;
    void el.play().catch(() => {});
    const swap = () => {
      for (const [n, v] of Object.entries(els.current)) {
        v!.classList.toggle("on", n === k);
        if (n !== k) v!.pause();
      }
      cur.current = k;
      el.parentElement?.setAttribute("data-clip", k);
      shown.current?.();
    };
    if ("requestVideoFrameCallback" in el) el.requestVideoFrameCallback(swap);
    else swap();
  };
  const settle = () => {
    if (busy.current) return;
    if (want.current) {
      if (cur.current !== "look") show("up", () => (want.current ? show("look") : show("down", settle)));
    } else if (cur.current === "look") show("down", settle);
    else if (cur.current !== "read") show("read");
  };

  useEffect(() => {
    want.current = attention;
    settle();
  }, [attention]);
  useEffect(() => {
    show(want.current ? "look" : "read");
    const vis = () => {
      const v = cur.current && els.current[cur.current];
      if (!v) return;
      if (document.hidden) v.pause();
      else void v.play().catch(() => {});
    };
    document.addEventListener("visibilitychange", vis);
    return () => document.removeEventListener("visibilitychange", vis);
  }, []);
  // Its size changes with Resize, the window width (iPad scale) and the screen's pixel density.
  useEffect(() => {
    const parent = box.current?.parentElement ?? null;
    const check = () => setTier(tierFor(parent));
    check();
    const ro = new ResizeObserver(check);
    if (parent) ro.observe(parent);
    window.addEventListener("resize", check);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", check);
    };
  }, []);
  // A new size (or sources arriving, without a server) swaps the files; the clip it was on starts over from the new one.
  const key = CLIPS.map((k) => srcs[tier][k] ?? "").join("|");
  const first = useRef(true);
  useEffect(() => {
    if (first.current) return void (first.current = false);
    busy.current = false;
    const k = cur.current ?? (want.current ? "look" : "read");
    show(k === "up" ? "look" : k === "down" ? "read" : k);
  }, [key]);

  return (
    <>
      <span ref={box} hidden />
      {CLIPS.map((k) => (
        <video
          key={k}
          ref={(v) => {
            if (v) els.current[k] = v;
          }}
          src={srcs[tier][k]}
          data-clip-name={k}
          muted
          playsInline
          preload="auto"
          loop={k === "read" || k === "look"}
          disablePictureInPicture
          aria-hidden
          className="minimi-clip"
        />
      ))}
    </>
  );
}

/** An agent profile's body as clips: its picture until the first frame plays, then the clips. */
export function ProfileClips({ clips, poster, attention }: { clips: AgentClips; poster: string; attention: boolean }) {
  const [playing, setPlaying] = useState(false);
  const url = (k: keyof AgentClips, h: "248" | "533") => mediaUrl(clipSrc(clips[k], h));
  // A fixed number of hooks: four clips at two heights (the same file twice when a clip has one size).
  const srcs: ClipSources = {
    248: { read: useEtudeSrc(url("read", "248")), up: useEtudeSrc(url("lookUp", "248")), look: useEtudeSrc(url("look", "248")), down: useEtudeSrc(url("lookDown", "248")) },
    533: { read: useEtudeSrc(url("read", "533")), up: useEtudeSrc(url("lookUp", "533")), look: useEtudeSrc(url("look", "533")), down: useEtudeSrc(url("lookDown", "533")) },
  };
  return (
    <>
      <EtudeImg src={mediaUrl(poster)} alt="" draggable={false} className={cn("minimi-fr minimi-body", playing && "is-under")} />
      <MinimiClips attention={attention} srcs={srcs} onShown={() => setPlaying(true)} />
    </>
  );
}
