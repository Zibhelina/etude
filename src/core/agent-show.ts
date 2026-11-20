// What a reply in Ask can show besides text: widgets, charts, cards, note blocks, stickers and files from
// this computer (pictures, audio, video, PDFs). The reply stays plain text; the app reads these marks out of
// it (web/src/components/agent-rich.tsx). This side tells the agent what it can write, and keeps the local
// files a reply pointed at, so the chat still shows them after the original moved or was overwritten.
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { extname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

/** File types a reply may show from this computer, with the type they're served as. */
export const SHOW_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".pdf": "application/pdf",
  ".html": "text/plain; charset=utf-8",
  ".htm": "text/plain; charset=utf-8",
};

/** The biggest file kept with the chat; a bigger one shows only while the original is where it was. */
export const SHOW_MAX_KEEP = 100 * 1024 * 1024;

const OWN = /^\/(api|media|type-assets|embed|runtime)\//;

/** A path as written in a reply ("~/x.png", "file:///x.png", "/x.png") as a path on this computer, or null. */
export function localPath(raw: string): string | null {
  const s = raw.trim();
  if (!s || s.includes("\0")) return null;
  if (s.startsWith("file://")) {
    try {
      return fileURLToPath(s);
    } catch {
      return null;
    }
  }
  if (s === "~" || s.startsWith("~/")) return join(homedir(), s.slice(1));
  if (s.startsWith("/") && !s.startsWith("//") && !OWN.test(s)) return s;
  return null;
}

/** The places a reply can name a file: MEDIA: lines, Markdown targets, file="…"/src="…" and "file": "…". */
const REFS = [/^[ \t]*MEDIA:[ \t]*(.+?)[ \t]*$/gm, /\]\(<?([^)\s>]+)>?\)/g, /\b(?:file|src)\s*=\s*"([^"]+)"/g, /"(?:file|src)"\s*:\s*"((?:[^"\\]|\\.)+)"/g];

/** Every local file a reply points at, as written (each once). */
export function shownRefs(text: string): string[] {
  const out = new Set<string>();
  for (const re of REFS) {
    for (const m of text.matchAll(re)) {
      const raw = m[1].trim();
      const p = localPath(raw);
      if (p && SHOW_MIME[extname(p).toLowerCase()]) out.add(raw);
    }
  }
  return [...out];
}

/** Copies the files a reply points at into `dir` and returns written path → kept file name. */
export function keepShown(text: string, dir: string): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const raw of shownRefs(text)) {
    const p = localPath(raw)!;
    try {
      const st = statSync(p);
      if (!st.isFile() || st.size > SHOW_MAX_KEEP) continue;
      const name = `${createHash("sha1").update(`${p}\n${st.mtimeMs}\n${st.size}`).digest("hex").slice(0, 16)}${extname(p).toLowerCase()}`;
      mkdirSync(dir, { recursive: true });
      if (!existsSync(join(dir, name))) copyFileSync(p, join(dir, name));
      kept[raw] = name;
    } catch {}
  }
  return kept;
}

/** What the agent is told it can put in a reply. `files`: it runs on this computer and can name local files. */
export function showGuide(files: boolean): string {
  return [
    "What this chat shows besides Markdown, tables, code, $math$ and pictures (![alt](URL)). Each goes on its own line, outside any other fence:",
    ...(files ? ["- A file on this computer: MEDIA:/absolute/path alone on a line. Pictures show, audio becomes a voice player, video plays, a PDF opens in place, an .html file runs as a widget."] : []),
    '- A widget: a ```widget fence holding HTML (CSS and JS run sandboxed; it gets the app\'s colours as var(--foreground), var(--muted-foreground), var(--card), var(--border), var(--primary) and the app font, on a transparent background; buttons, fields and headings already look like the app\'s, and class="primary" makes the one main button green). In it, etude.send("text"), or data-etude-send="text" on a button, sends that text back to you as the user\'s next message. Instead of HTML the fence can hold {"url": "https://…", "height": 360}' + (files ? ' or {"file": "/path/page.html"}' : "") + '. A widget sits on the chat with no card, as part of the reply (a {"url"} page keeps one); ```widget card or "frame": "card" puts it in a card. For anything heavily laid out (an article, an explainer with figures), write a page and embed it instead of stacking rows and asides.',
    '- A chart: a ```chart fence with JSON {"type": "line" | "bar" | "area" | "pie" | "donut" | "scatter", "title"?, "x": [labels], "series": [{"name", "data": [numbers]}], "unit"?, "stacked"?, "frame"?: "card"}.',
    '- Flashcards answered right in the chat (real reviews): ::card{id=<card id>} or ::cards{deck="A::B" n=5} (q="a search" instead of deck).',
    "- Anything a note page holds (columns, callouts, toggles, video, PDF, a canvas or board): a ```note fence with a JSON array of note blocks, the shapes `note block` prints.",
    '- A sticker, a picture with no bubble: ::sticker{file="' + (files ? "/path or URL" : "URL") + '"}.',
    '- A note opened in a pane beside this chat: ::open{note="<note id>" side="right"} (left, right, top or bottom) on its own line; it opens once, when the reply first shows. Make the note first (a PDF note for a PDF) if it doesn\'t exist.',
    '- Your own typography on any words: <span lang="TOKENS">text</span>, tokens combinable. Fonts hand marker serif cm goth type script loud mono; sizes xs s l xl xxl huge; b thin i u strike caps smallcaps wide; colours pink red blue green gold purple dim glow; motion shake wobble pulse tilt. For anything else, style="" with colour, background-color, font-family, font-size (up to 4em), weight, style, decoration, letter-spacing, line-height. Headings # ## ### get real sizes.',
    "- Side by side: a line :::row (or :::row{widths=\"2 3\"}), the first column, a line :::col, the next column, a line ::: to close. A column holds anything a reply does (text, pictures, a widget or chart fence); they stack when the chat is narrow. Use it when a picture or widget reads better beside its text.",
    "- An infobox the text wraps around, like an encyclopedia: a line :::aside (or :::aside{width=\"35%\" side=\"left\"}), the box (picture, key-value table, widget), a line :::, then the text; it wraps until a line :::clear or the end. Better than :::row when the box is taller than the text beside it. Rows and asides nest (an aside in a column, a row in an aside); each ::: closes the innermost one.",
    'Sources: when an answer rests on web pages or documents, cite them inline right after the claim as [1](https://… "Page title"), numbered from 1 in order of first use and reusing a number for the same page. The chat turns each into a small numbered link and lists them under the reply as Sources. Ordinary [text](url) links stay links.',
  ].join("\n");
}
