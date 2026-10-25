import { api, type StoredMedia } from "./api";

export type MediaFormat = "markdown" | "html" | "url";
type Source = { file: File } | { path: string };
export interface MediaPaste { sources: Source[]; template?: string; references?: string[] }

const extensions = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|mp3|wav|ogg|oga|opus|flac|m4a|aac|mp4|m4v|webm|ogv|mov)$/i;
const mimeExtensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "image/svg+xml": "svg", "image/bmp": "bmp", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg", "audio/mp4": "m4a", "video/mp4": "mp4", "video/webm": "webm", "video/ogg": "ogv" };
const localPath = (text: string) => !text.startsWith("/media/") && /^(file:|\/|~\/|[a-z]:[\\/])/i.test(text) && extensions.test(text.startsWith("file:") ? new URL(text).pathname : text);
const unquote = (text: string) => text.replace(/^(["'])([\s\S]*)\1$/, "$2");

function dataFile(text: string): File | null {
  const m = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(text);
  const ext = m && mimeExtensions[m[1].toLowerCase()];
  if (!m || !ext) return null;
  const bytes = Uint8Array.from(atob(m[2].replace(/\s/g, "")), (c) => c.charCodeAt(0));
  return new File([bytes], `pasted-media.${ext}`, { type: m[1] });
}

/** Capture clipboard data during the event, before the browser clears it. */
export function readMediaPaste(data: DataTransfer): MediaPaste | null {
  const files = Array.from(data.files).filter((f) => /^(image|audio|video)\//.test(f.type) || extensions.test(f.name));
  if (files.length) return { sources: files.map((f) => ({ file: extensions.test(f.name) || !mimeExtensions[f.type] ? f : new File([f], `${f.name || "pasted-media"}.${mimeExtensions[f.type]}`, { type: f.type }) })) };
  const html = data.getData("text/html");
  const fragment = /<!--StartFragment-->([\s\S]*?)<!--EndFragment-->/.exec(html)?.[1] ?? html;
  const references = [...fragment.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]).filter((ref) => ref.startsWith("file:") || ref.startsWith("data:"));
  if (references.length) {
    const sources = references.map((ref): Source | null => {
      const decoded = ref.replace(/&amp;/g, "&");
      const file = dataFile(decoded);
      return file ? { file } : localPath(decoded) ? { path: decoded } : null;
    });
    if (sources.every((s) => s !== null)) return { sources, template: fragment, references };
  }
  const text = (data.getData("text/uri-list") || data.getData("x-special/gnome-copied-files") || data.getData("text/plain")).trim();
  const file = dataFile(text);
  if (file) return { sources: [{ file }] };
  const paths = text.split(/\r?\n/).map((line) => unquote(line.trim())).filter((line) => line && !line.startsWith("#") && line !== "copy" && line !== "cut");
  return paths.length && paths.every(localPath) ? { sources: paths.map((path) => ({ path })) } : null;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function embed(media: StoredMedia, format: MediaFormat) {
  if (format === "url") return media.url;
  const name = escapeHtml(media.name);
  if (media.kind === "image") return format === "html" ? `<img src="${media.url}" alt="${name}">` : `![${media.name.replace(/[\\[\]\r\n]/g, "\\$&")}](${media.url})`;
  return `<${media.kind} controls preload="none" src="${media.url}"></${media.kind}>`;
}

export async function copyMediaPaste(paste: MediaPaste, format: MediaFormat): Promise<string> {
  const files = await Promise.all(paste.sources.map((s) => "file" in s ? api.uploadMedia(s.file) : api.importMedia(s.path)));
  if (paste.template && paste.references && format !== "url") {
    let html = paste.template;
    paste.references.forEach((ref, i) => { html = html.split(ref).join(files[i].url); });
    return html;
  }
  return files.map((file) => embed(file, format)).join("\n");
}
