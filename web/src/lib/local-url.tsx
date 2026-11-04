// Images, video and downloads that point at the app's own URLs (/media/…, /api/market/cover/…,
// /api/export) load from the Etude server on the desktop. With no server (the web edition and the
// phone apps, see transport.ts) the browser can't fetch them, so they're answered by the core worker
// and handed to the page as blob: URLs.
import { useEffect, useState, type ComponentProps } from "react";
import { toast } from "sonner";
import { etudeFetch, isLocal } from "@/lib/transport";

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

/** `src` for an <img>, <video> or <audio>: the URL itself with a server, a blob: URL without one (undefined while it loads). */
export function useEtudeSrc(url: string | null | undefined): string | undefined {
  const path = isLocal() ? ownPath(url) : null;
  const [src, setSrc] = useState<{ path: string; url: string } | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    localBlobUrl(path).then(
      (u) => live && setSrc({ path, url: u }),
      () => live && setSrc(null),
    );
    return () => {
      live = false;
    };
  }, [path]);
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
export function EtudeImg({ src, ...rest }: ComponentProps<"img">) {
  return <img {...rest} src={useEtudeSrc(src)} />;
}
