import { extname } from "node:path";

export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
export type MediaKind = "image" | "audio" | "video";

const TYPES: Record<string, [string, MediaKind, string?]> = {
  ".png": ["image/png", "image"], ".jpg": ["image/jpeg", "image"], ".jpeg": ["image/jpeg", "image", ".jpg"],
  ".gif": ["image/gif", "image"], ".webp": ["image/webp", "image"], ".avif": ["image/avif", "image"],
  ".svg": ["image/svg+xml", "image"], ".bmp": ["image/bmp", "image"], ".ico": ["image/x-icon", "image"],
  ".mp3": ["audio/mpeg", "audio"], ".wav": ["audio/wav", "audio"], ".ogg": ["audio/ogg", "audio"],
  ".oga": ["audio/ogg", "audio", ".ogg"], ".opus": ["audio/ogg", "audio", ".ogg"], ".flac": ["audio/flac", "audio"],
  ".m4a": ["audio/mp4", "audio"], ".aac": ["audio/aac", "audio"],
  ".mp4": ["video/mp4", "video"], ".m4v": ["video/mp4", "video", ".mp4"], ".webm": ["video/webm", "video"],
  ".ogv": ["video/ogg", "video"], ".mov": ["video/quicktime", "video"],
};

// Where a file name mentioned in text can start: after a quote, bracket, slash, colon or equals sign.
const NAME_START = new Set(['"', "'", "<", ">", "/", "\\", ":", "=", "\n", "\r", "\t"]);
// A name may also start after one of these inside such a run ("see my file.mp3" names "file.mp3" too).
const NAME_SPLIT = /[ ,;|*`()\[\]{}]/g;

/**
 * Adds every file name `text` mentions that ends in one of `exts` (lowercase, no dot), lowercased and
 * URL-decoded: "/media/anki/my%20file.mp3", "[sound:my file.mp3]" and "url(file.mp3)" all count. It errs
 * towards finding too many names, so a file it misses is one nothing names.
 */
export function collectFileNames(text: string, exts: Set<string>, into: Set<string>) {
  // Decode before locating extensions, including an encoded dot or uppercase Unicode letters.
  text = text.replace(/(?:%[0-9a-f]{2})+/gi, (s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
  const ext = /\.([A-Za-z0-9]{1,8})(?![A-Za-z0-9])/g;
  for (let m: RegExpExecArray | null; (m = ext.exec(text)); ) {
    if (!exts.has(m[1].toLowerCase())) continue;
    const end = m.index + m[0].length;
    let start = m.index;
    while (start > 0 && end - start < 300 && !NAME_START.has(text[start - 1])) start--;
    const run = text.slice(start, end);
    for (const name of [run, ...[...run.matchAll(NAME_SPLIT)].map((s) => run.slice(s.index + 1))]) {
      const n = name.trim().toLowerCase();
      if (!n) continue;
      into.add(n);
      into.add(n.replace(/&amp;/g, "&"));
      try {
        into.add(decodeURIComponent(n));
      } catch {}
    }
  }
}

export function mediaType(name: string) {
  const ext = extname(name).toLowerCase();
  const type = TYPES[ext];
  return type ? { mime: type[0], kind: type[1], extension: type[2] ?? ext } : null;
}
