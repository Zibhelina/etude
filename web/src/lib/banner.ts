// Your banner (the cover at the top of Settings → Account & Sync). The setting lives with the collection, so it
// syncs; a localStorage copy shows it without a flash on load. src/core/banner.ts checks and describes the values.
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { BANNER_PRESETS, type Banner } from "../../../src/core/banner.ts";

export type { Banner };
export { BANNER_PRESETS };

export const sameBanner = (a: Banner | null | undefined, b: Banner | null | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const KEY = "etude.banner";
const EVENT = "etude:banner";
let current: Banner | null = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "null");
  } catch {
    return null;
  }
})();

export function rememberBanner(b: Banner | null) {
  if (sameBanner(b, current)) return;
  current = b;
  try {
    localStorage.setItem(KEY, JSON.stringify(b));
  } catch {}
  window.dispatchEvent(new CustomEvent(EVENT));
}

export const bannerNow = () => current;

export function useBanner(): Banner | null {
  const [b, setB] = useState(current);
  useEffect(() => {
    const h = () => setB(current);
    window.addEventListener(EVENT, h);
    h();
    return () => window.removeEventListener(EVENT, h);
  }, []);
  return b;
}

/** Saves the banner to the collection (it syncs) and shows it at once. */
export async function saveBanner(b: Banner | null): Promise<Banner | null> {
  const s = (await api.saveSettings({ banner: b })) as { banner?: Banner | null };
  rememberBanner(s.banner ?? null);
  return s.banner ?? null;
}

export const BANNER_MAX_WIDTH = 1600;

/** Reads an image for the banner: downscaled to 1600 px wide at most, as WebP (PNG where the browser can't write WebP). */
export async function readBannerImage(file: File): Promise<{ blob: Blob; src: string }> {
  if (!/^image\//.test(file.type) && !/\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(file.name)) throw new Error("Choose a picture: JPG, PNG, WebP, GIF or AVIF.");
  if (file.size > 30 * 1024 * 1024) throw new Error("That picture is over 30 MB.");
  const url = URL.createObjectURL(file);
  try {
    const im = new Image();
    im.src = url;
    try {
      await im.decode();
    } catch {
      throw new Error("This browser can't open that picture. Try a JPG or PNG.");
    }
    const k = Math.min(1, BANNER_MAX_WIDTH / im.naturalWidth);
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(im.naturalWidth * k));
    c.height = Math.max(1, Math.round(im.naturalHeight * k));
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(im, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("Couldn't read the picture."))), "image/webp", 0.88));
    return { blob, src: URL.createObjectURL(blob) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Stores a banner image in the collection's media (so Sync carries it and cleanup keeps it). */
export async function uploadBannerImage(blob: Blob): Promise<string> {
  const ext = blob.type === "image/webp" ? "webp" : "png";
  const m = await api.uploadMedia(new File([blob], `banner.${ext}`, { type: blob.type }));
  if (m.kind !== "image") throw new Error("That file isn't a picture.");
  return m.file;
}
