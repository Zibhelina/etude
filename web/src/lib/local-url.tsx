// Images, video and downloads that point at the app's own URLs (/media/…, /api/market/cover/…,
// /api/export) load from the Etude server on the desktop. With no server (the web edition and the
// phone apps, see transport.ts) the browser can't fetch them, so they're answered by the core worker
// and handed to the page as blob: URLs.
import { useEffect, useState, type ComponentProps } from "react";
import { toast } from "sonner";
import { ArrowDownToLine } from "lucide-react";
import { etudeFetch, isLocal } from "@/lib/transport";
import { MEDIA_EVENT, MEDIA_STATE_EVENT, mediaPending } from "@/lib/sync";
import { cn } from "@/lib/utils";

const OWN = /^\/(api|media|type-assets)\//;

/** The path of one of the app's own resources ("/media/x.png"), or null for anything else. */
export function ownPath(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url, location.href);
    return u.origin === location.origin && OWN.test(u.pathname) ? u.pathname + u.search : null;
  } catch {
    return null;
  }
}

const blobs = new Map<string, Promise<string>>();

/** A blob: URL with the resource's bytes, fetched from the core once per path. */
export function localBlobUrl(path: string): Promise<string> {
  let p = blobs.get(path);
  if (!p) {
    p = etudeFetch(path).then(async (r) => {
      if (!r.ok) throw new Error(`${path}: ${r.status}`);
      return URL.createObjectURL(await r.blob());
    });
    p.catch(() => blobs.delete(path));
    blobs.set(path, p);
  }
  return p;
}

/** Counts media files arriving from another device (MEDIA_EVENT), so a missing image can ask again. */
export function useMediaArrivals(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const h = () => setN((k) => k + 1);
    window.addEventListener(MEDIA_EVENT, h);
    return () => window.removeEventListener(MEDIA_EVENT, h);
  }, []);
  return n;
}

/** Whether media files are still on their way from the sync. */
export function useMediaPending(): boolean {
  const [pending, setPending] = useState(mediaPending);
  useEffect(() => {
    const h = () => setPending(mediaPending());
    window.addEventListener(MEDIA_STATE_EVENT, h);
    h();
    return () => window.removeEventListener(MEDIA_STATE_EVENT, h);
  }, []);
  return pending;
}

/** `src` for an <img>, <video> or <audio>: the URL itself with a server, a blob: URL without one (undefined while it loads). */
export function useEtudeSrc(url: string | null | undefined): string | undefined {
  return useEtudeMedia(url).src;
}

/** `useEtudeSrc`, and whether the core said the file isn't here (without a server). */
function useEtudeMedia(url: string | null | undefined): { src: string | undefined; missing: boolean } {
  const path = isLocal() ? ownPath(url) : null;
  const [src, setSrc] = useState<{ path: string; url: string } | null>(null);
  // A file that wasn't here may arrive with the media sync: then it's asked for again.
  const [missing, setMissing] = useState(false);
  const arrivals = useMediaArrivals();
  useEffect(() => {
    if (!path) return;
    let live = true;
    localBlobUrl(path).then(
      (u) => live && (setSrc({ path, url: u }), setMissing(false)),
      () => live && (setSrc(null), setMissing(true)),
    );
    return () => {
      live = false;
    };
  }, [path, missing ? arrivals : 0]);
  if (!path) return { src: url ?? undefined, missing: false };
  return { src: src?.path === path ? src.url : undefined, missing };
}

/** HTML from Markdown with the app's own image URLs parked in data-etude-src, so the browser doesn't request them; `loadLocalMedia` fills them in. */
export function parkLocalMedia(html: string): string {
  if (!isLocal()) return html;
  return html.replace(/(<(?:img|video|audio|source)\b[^>]*?\s)src=("|')([^"']*)\2/gi, (m, head: string, q: string, url: string) => (ownPath(url) ? `${head}data-etude-src=${q}${url}${q}` : m));
}

/** Gives every [data-etude-src] element under `root` its blob: URL. */
export function loadLocalMedia(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>("[data-etude-src]").forEach((el) => {
    const path = ownPath(el.getAttribute("data-etude-src"));
    if (!path) return;
    localBlobUrl(path).then((u) => el.setAttribute("src", u), () => {});
  });
}

/**
 * onClick for a download link to one of the app's own URLs (<a href="/api/export" download>).
 * Without a server it fetches the file from the core and saves it; with one the link works as is.
 */
export function etudeDownload(e: React.MouseEvent<HTMLAnchorElement>) {
  if (!isLocal()) return;
  const a = e.currentTarget;
  const path = ownPath(a.getAttribute("href"));
  if (!path) return;
  e.preventDefault();
  void etudeFetch(path).then(async (r) => {
    if (!r.ok) throw new Error(`${r.status}`);
    const url = URL.createObjectURL(await r.blob());
    const tmp = document.createElement("a");
    tmp.href = url;
    tmp.download = a.getAttribute("download") || path.split("/").pop() || "download";
    document.body.appendChild(tmp);
    tmp.click();
    tmp.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }).catch((err) => toast.error(`Couldn't save the file: ${err instanceof Error ? err.message : err}`));
}

/** <img> that also loads the app's own URLs when there's no server. */
export function EtudeImg({ src, onError, ...rest }: ComponentProps<"img">) {
  // A collection image that isn't here yet says it's on its way while media files sync, and is drawn again when they arrive.
  const arrivals = useMediaArrivals();
  const pending = useMediaPending();
  const [failedAt, setFailedAt] = useState<number | null>(null);
  const media = useEtudeMedia(src);
  const collection = /^\/media\//.test(ownPath(src) ?? "");
  if (collection && pending && (media.missing || failedAt === arrivals)) return <ImageOnItsWay className={rest.className} width={rest.width} height={rest.height} />;
  return <img {...rest} key={failedAt === null ? "first" : arrivals} src={media.src} onError={(e) => (setFailedAt(arrivals), onError?.(e))} />;
}

function ImageOnItsWay({ className, width, height }: { className?: string; width?: number | string; height?: number | string }) {
  return (
    <span role="img" aria-label="Image on its way, still syncing" className={cn("inline-flex min-h-24 min-w-40 flex-col items-center justify-center gap-1 rounded-lg border border-dashed bg-muted/40 px-4 py-3 text-center text-xs text-muted-foreground", className, "bg-muted/40")} style={{ width, height }}>
      <ArrowDownToLine className="size-5" aria-hidden />
      <span className="font-medium text-foreground/80">Image on its way</span>
      <span>Still syncing</span>
    </span>
  );
}
