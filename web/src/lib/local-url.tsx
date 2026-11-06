// Images, video and downloads that point at the app's own URLs (/media/…, /api/market/cover/…,
// /api/export) load from the Etude server on the desktop. With no server (the web edition and the
// phone apps, see transport.ts) the browser can't fetch them, so they're answered by the core worker
// and handed to the page as blob: URLs.
import { useEffect, useState, type ComponentProps } from "react";
import { toast } from "sonner";
import { etudeFetch, isLocal } from "@/lib/transport";
import { MEDIA_EVENT } from "@/lib/sync";

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

/** `src` for an <img>, <video> or <audio>: the URL itself with a server, a blob: URL without one (undefined while it loads). */
export function useEtudeSrc(url: string | null | undefined): string | undefined {
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
  if (!path) return url ?? undefined;
  return src?.path === path ? src.url : undefined;
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
  // With a server, an image that failed to load is drawn again once media files arrive.
  const arrivals = useMediaArrivals();
  const [failedAt, setFailedAt] = useState<number | null>(null);
  return <img {...rest} key={failedAt === null ? "first" : arrivals} src={useEtudeSrc(src)} onError={(e) => (setFailedAt(arrivals), onError?.(e))} />;
}
