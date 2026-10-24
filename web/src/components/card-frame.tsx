// Hosts a card in a sandboxed iframe. The card's code runs with an opaque origin and talks to
// the app only through postMessage, so a shared deck can't touch your data.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { Grade } from "@/lib/api";
import { pageScheme, THEME_EVENT, useScheme } from "@/lib/theme";

export interface CardResult {
  grade: Grade;
  key: Record<string, unknown>;
  answer: unknown;
  /** Showing the key for inspection, not grading a real answer. */
  preview?: boolean;
}

export interface CardFrameHandle {
  /** Ask the card for its current answer; it replies through `onSubmit`. */
  collect(): void;
  showResult(result: CardResult): void;
  focus(): void;
}

interface Props {
  /** Served frame (`/frame/<type>`), or raw HTML for previews of unsaved types. */
  src?: string;
  html?: string;
  /** Changing this remounts the frame. */
  frameKey: string;
  view: Record<string, unknown>;
  mode?: "answer" | "result" | "preview";
  answer?: unknown;
  result?: CardResult | null;
  className?: string;
  minHeight?: number;
  /** Focus the card when it mounts. Off for embeds that shouldn't steal focus from their host. */
  autoFocus?: boolean;
  onSubmit?(answer: unknown): void;
  onReady?(ready: boolean): void;
  onKey?(key: string): void;
  onError?(message: string): void;
}

const THEME_VARS = [
  "--background", "--foreground", "--card", "--card-foreground", "--popover", "--popover-foreground", "--muted",
  "--muted-foreground", "--secondary", "--secondary-foreground", "--border", "--input", "--primary", "--primary-foreground",
  "--accent", "--accent-foreground", "--ring", "--destructive", "--success", "--warning", "--danger", "--highlight",
  "--again", "--hard", "--good", "--easy", "--new", "--learn", "--review", "--radius", "--font-sans", "--font-mono",
];

function theme() {
  const cs = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (const v of THEME_VARS) {
    const val = cs.getPropertyValue(v).trim();
    if (val) vars[v] = val;
  }
  vars["--danger"] ||= cs.getPropertyValue("--destructive").trim();
  return { scheme: pageScheme(), vars };
}

export const CardFrame = forwardRef<CardFrameHandle, Props>(function CardFrame(props, ref) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(props.minHeight ?? 120);
  const [loaded, setLoaded] = useState(false);
  const latest = useRef(props);
  latest.current = props;

  const post = useCallback((msg: Record<string, unknown>) => {
    iframe.current?.contentWindow?.postMessage({ etude: 1, ...msg }, "*");
  }, []);

  useImperativeHandle(ref, () => ({
    collect: () => post({ type: "collect" }),
    showResult: (result) => post({ type: "result", result }),
    focus: () => {
      iframe.current?.focus();
      post({ type: "focus" });
    },
  }), [post]);

  useEffect(() => {
    setLoaded(false);
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframe.current?.contentWindow) return;
      const msg = e.data;
      if (!msg || msg.etude !== 1) return;
      const p = latest.current;
      switch (msg.type) {
        case "loaded":
          post({ type: "init", view: p.view, mode: p.mode ?? "answer", answer: p.answer ?? null, result: p.result ?? null, theme: theme() });
          break;
        case "mounted":
          setLoaded(true);
          if ((p.mode ?? "answer") === "answer" && p.autoFocus !== false) {
            iframe.current?.focus();
            post({ type: "focus" });
          }
          break;
        case "size":
          if (typeof msg.height === "number") setHeight(Math.max(p.minHeight ?? 60, Math.min(msg.height + 4, 6000)));
          break;
        case "submit":
          p.onSubmit?.(msg.answer);
          break;
        case "ready-state":
          p.onReady?.(!!msg.ready);
          break;
        case "key":
          p.onKey?.(String(msg.key));
          break;
        case "error":
          p.onError?.(String(msg.message));
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [props.frameKey, post]);

  // A theme change (or a live preview in Settings) restyles cards already on screen.
  const scheme = useScheme();
  useEffect(() => {
    const onTheme = () => post({ type: "theme", theme: theme() });
    window.addEventListener(THEME_EVENT, onTheme);
    return () => window.removeEventListener(THEME_EVENT, onTheme);
  }, [post]);

  return (
    <iframe
      key={props.frameKey}
      ref={iframe}
      title="card"
      sandbox="allow-scripts"
      src={props.html ? undefined : props.src}
      srcDoc={props.html}
      // No opacity fade: on macOS WebKit the faded-in card frame could stop painting.
      className={cn("block w-full border-0 bg-transparent", props.className)}
      style={{ height, colorScheme: scheme }}
    />
  );
});
