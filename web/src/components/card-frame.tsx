// Hosts a card in a sandboxed iframe. The card's code runs with an opaque origin and talks to
// the app only through postMessage, so a shared deck can't touch your data.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { api, type Grade } from "@/lib/api";
import { pageScheme, THEME_EVENT, useScheme } from "@/lib/theme";
import { etudeFetch, isLocal } from "@/lib/transport";
import { MEDIA_EVENT, MEDIA_STATE_EVENT, mediaPending } from "@/lib/sync";

// Where the serverless builds keep the editor kit, from this bundle file (assets/…). A variable, so
// the bundler leaves it alone: the kit is built after the app.
const KIT = "../kit/kit.js";

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
  /** Show the graded result. The card animates from its answer to it unless `morph` is false. */
  showResult(result: CardResult, opts?: { morph?: boolean }): void;
  focus(): void;
  /** Where the card's pieces are now, to hand to another frame as `morphFrom` (null when there's nothing to animate). */
  snapshot(): Promise<unknown[] | null>;
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
  /** Tell the card how much screen height it can fill below its top (`etude.screen`), e.g. in focus mode. */
  fitScreen?: boolean;
  /** Pixels kept free under the card when fitting the screen (default 16), e.g. for a button. */
  fitMargin?: number;
  /** Height to start at instead of `minHeight`, e.g. the frame this one replaces. */
  initialHeight?: number;
  /** A `snapshot()` of the frame this one replaces: the card animates from it once mounted. */
  morphFrom?: unknown[] | null;
  onMounted?(): void;
  onSize?(height: number): void;
  /** The card animated into its result; `leaving` when some pieces went away (new ones then wait a beat). */
  onMorph?(leaving: boolean): void;
  onSubmit?(answer: unknown): void;
  onReady?(ready: boolean): void;
  onKey?(key: string): void;
  onError?(message: string): void;
}

// A type's saved preferences (etude.prefs), fetched once per type and kept current as cards save them.
const prefCache = new Map<string, Promise<Record<string, unknown>>>();
const typeOfSrc = (src?: string) => {
  const m = src?.match(/^\/frame\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
};
/** Drops a type's cached preferences, e.g. after they were reset in Settings. */
export function forgetTypePrefs(type: string) {
  prefCache.delete(type);
}
function prefsFor(type: string | null): Promise<Record<string, unknown>> {
  if (!type) return Promise.resolve({});
  if (!prefCache.has(type)) prefCache.set(type, api.typePrefs(type).catch(() => ({})));
  return prefCache.get(type)!;
}

// The serverless builds' page runs only scripts carrying its nonce (src/browser/csp-boot.js), and a
// srcdoc frame inherits that policy: the frame's scripts get the nonce where the worker left this
// placeholder (src/browser/frame-local.ts, FRAME_NONCE).
const NONCE_PLACEHOLDER = 'nonce="%ETUDE_NONCE%"';
const withPageNonce = (html: string) => html.replaceAll(NONCE_PLACEHOLDER, `nonce="${(globalThis as { __etudeFrameNonce?: string }).__etudeFrameNonce ?? ""}"`);

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
  // Inside a card, --highlight is the card accent (pink in Snow and Night), not the app's green.
  const cardHl = cs.getPropertyValue("--card-highlight").trim();
  if (cardHl) vars["--highlight"] = cardHl;
  return { scheme: pageScheme(), vars };
}

export const CardFrame = forwardRef<CardFrameHandle, Props>(function CardFrame(props, ref) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(props.initialHeight ?? props.minHeight ?? 120);
  const snaps = useRef(new Map<number, (leaves: unknown[] | null) => void>());
  const [loaded, setLoaded] = useState(false);
  const latest = useRef(props);
  latest.current = props;

  const post = useCallback((msg: Record<string, unknown>, transfer: Transferable[] = []) => {
    iframe.current?.contentWindow?.postMessage({ etude: 1, ...msg }, "*", transfer);
  }, []);

  // The height left on screen from the frame's top to the bottom of the window (less a margin), or null.
  const screenHeight = useCallback(() => {
    const el = iframe.current;
    if (!latest.current.fitScreen || !el) return null;
    return Math.max(200, Math.floor(window.innerHeight - (el.getBoundingClientRect().top + window.scrollY) - (latest.current.fitMargin ?? 16)));
  }, []);
  useEffect(() => {
    if (!loaded) return;
    const send = () => post({ type: "screen", height: screenHeight() });
    send();
    if (!props.fitScreen) return;
    window.addEventListener("resize", send);
    return () => window.removeEventListener("resize", send);
  }, [loaded, props.fitScreen, post, screenHeight]);

  // With no server (the core runs in this tab), a served frame can't be loaded by URL: fetch its
  // HTML from the core and show it as srcdoc. The frame then asks for media over postMessage. (A
  // sandboxed frame loaded by URL wouldn't work offline: the service worker doesn't serve it.)
  const local = isLocal() && !props.html && !!props.src;
  const [localHtml, setLocalHtml] = useState<string | null>(null);
  useEffect(() => {
    if (!local) return;
    let live = true;
    setLocalHtml(null);
    etudeFetch(props.src!)
      .then((r) => r.text())
      .then((html) => live && setLocalHtml(html))
      .catch((e) => latest.current.onError?.(String(e?.message ?? e)));
    return () => {
      live = false;
    };
  }, [local, props.src, props.frameKey]);

  // With a server, unsaved HTML (type editor, Market previews) is posted once and loaded by URL:
  // a srcdoc frame inherits the app page's Content-Security-Policy, which blocks a card's inline code.
  const served = !isLocal() && props.html !== undefined;
  const [docUrl, setDocUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!served) return;
    let live = true;
    setDocUrl(null);
    api
      .frameDoc(props.html!)
      .then((j) => live && setDocUrl(j.url))
      .catch((e) => latest.current.onError?.(String(e?.message ?? e)));
    return () => {
      live = false;
    };
  }, [served, props.html, props.frameKey]);

  useImperativeHandle(ref, () => ({
    collect: () => post({ type: "collect" }),
    showResult: (result, opts) => post({ type: "result", result, morph: opts?.morph }),
    focus: () => {
      iframe.current?.focus();
      post({ type: "focus" });
    },
    snapshot: () => new Promise((resolve) => {
      const req = Math.random();
      const done = (leaves: unknown[] | null) => { snaps.current.delete(req); resolve(leaves); };
      snaps.current.set(req, done);
      post({ type: "snapshot", req });
      setTimeout(() => done(null), 200);
    }),
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
          prefsFor(typeOfSrc(p.src)).then((prefs) => post({ type: "init", view: p.view, mode: p.mode ?? "answer", answer: p.answer ?? null, result: p.result ?? null, theme: theme(), screen: { height: screenHeight() }, prefs, morphFrom: p.morphFrom ?? null, mediaPending: mediaPending(), focus: p.autoFocus !== false }));
          break;
        case "set-pref": {
          // Previews of unsaved types (raw HTML) have nowhere to keep preferences.
          const type = typeOfSrc(p.src);
          if (!type || typeof msg.key !== "string") break;
          const saved = api.setTypePref(type, msg.key, msg.value ?? null);
          prefCache.set(type, saved.catch(() => prefsFor(type)));
          saved.catch((e) => p.onError?.(`couldn't save the card's preference: ${e?.message ?? e}`));
          break;
        }
        case "mounted":
          setLoaded(true);
          p.onMounted?.();
          if ((p.mode ?? "answer") === "answer" && p.autoFocus !== false) {
            iframe.current?.focus();
            post({ type: "focus" });
          }
          break;
        case "size":
          if (typeof msg.height === "number") {
            const h = Math.max(p.minHeight ?? 60, Math.min(msg.height + 4, 6000));
            setHeight(h);
            p.onSize?.(h);
          }
          break;
        case "morph":
          p.onMorph?.(!!msg.leaving);
          break;
        case "snapshot":
          snaps.current.get(msg.req)?.(Array.isArray(msg.leaves) ? msg.leaves : null);
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
        case "get": {
          // Local mode only: the frame wants the bytes of a media file or a type asset.
          const req = msg.req;
          let path = "";
          try {
            const u = new URL(String(msg.url), location.href);
            path = u.pathname + u.search;
          } catch {}
          // The editor kit is one of the app's own files, next to its assets/ (see build:browser).
          if (isLocal() && path === "/runtime/kit/kit.js") {
            fetch(new URL(KIT, import.meta.url))
              .then(async (r) => {
                const body = await r.arrayBuffer();
                post({ type: "bytes", req, status: r.status, contentType: "text/javascript", body }, [body]);
              })
              .catch((e) => post({ type: "bytes", req, error: String(e?.message ?? e) }));
            break;
          }
          if (!isLocal() || !/^\/(media|type-assets)\//.test(path)) {
            post({ type: "bytes", req, error: "not allowed" });
            break;
          }
          // A card reads its own type's assets, not another type's (an unsaved preview has no type to hold it to).
          const assetType = /^\/type-assets\/([^/?#]+)\//.exec(path)?.[1];
          const own = typeOfSrc(p.src);
          if (assetType && own && decodeURIComponent(assetType) !== own) {
            post({ type: "bytes", req, error: "not allowed" });
            break;
          }
          etudeFetch(path)
            .then(async (r) => {
              const body = await r.arrayBuffer();
              post({ type: "bytes", req, status: r.status, contentType: r.headers.get("content-type") ?? "", body }, [body]);
            })
            .catch((e) => post({ type: "bytes", req, error: String(e?.message ?? e) }));
          break;
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [props.frameKey, post]);

  const localDoc = (html: string | undefined) => (html !== undefined && isLocal() ? withPageNonce(html) : html);

  // A theme change (or a live preview in Settings) restyles cards already on screen.
  const scheme = useScheme();
  useEffect(() => {
    const onTheme = () => post({ type: "theme", theme: theme() });
    window.addEventListener(THEME_EVENT, onTheme);
    return () => window.removeEventListener(THEME_EVENT, onTheme);
  }, [post]);
  // Media files from another device arrived: the card asks again for the images and sounds it lacked. While
  // files are on their way, a missing image shows that instead of a broken one.
  useEffect(() => {
    const onMedia = () => post({ type: "media" });
    const onState = () => post({ type: "media-state", pending: mediaPending() });
    window.addEventListener(MEDIA_EVENT, onMedia);
    window.addEventListener(MEDIA_STATE_EVENT, onState);
    return () => {
      window.removeEventListener(MEDIA_EVENT, onMedia);
      window.removeEventListener(MEDIA_STATE_EVENT, onState);
    };
  }, [post]);

  return (
    <iframe
      key={props.frameKey}
      ref={iframe}
      title="card"
      sandbox="allow-scripts"
      src={served ? (docUrl ?? undefined) : props.html !== undefined || local ? undefined : props.src}
      srcDoc={served ? undefined : localDoc(props.html ?? (local ? (localHtml ?? "") : undefined))}
      // No opacity fade: on macOS WebKit the faded-in card frame could stop painting.
      className={cn("block w-full border-0 bg-transparent", props.className)}
      style={{ height, colorScheme: scheme }}
    />
  );
});
