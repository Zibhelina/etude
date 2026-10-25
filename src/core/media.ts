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

export function mediaType(name: string) {
  const ext = extname(name).toLowerCase();
  const type = TYPES[ext];
  return type ? { mime: type[0], kind: type[1], extension: type[2] ?? ext } : null;
}
