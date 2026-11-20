// Small, exact edits to a page's body for scripts and agents: find a page by its path, see the tree, add blocks
// under a heading, and replace a piece of text the way a code editor's find-and-replace does, without rewriting
// the blocks around it.
import type { DocNode, NoteSummary } from "./notes.ts";
import { docToMarkdown, markdownToDoc, type MdContext } from "./notes-md.ts";
import { EtudeError } from "./engine.ts";

// ---------------------------------------------------------------- paths and the tree

/** Each live note's path: its ancestors' titles and its own, joined by "/". */
export function notePaths(list: NoteSummary[]): Map<string, string> {
  const by = new Map(list.map((n) => [n.id, n]));
  const out = new Map<string, string>();
  const pathOf = (n: NoteSummary): string => {
    const known = out.get(n.id);
    if (known !== undefined) return known;
    const parent = n.parentId ? by.get(n.parentId) : undefined;
    const p = parent ? `${pathOf(parent)}/${n.title}` : n.title;
    out.set(n.id, p);
    return p;
  };
  for (const n of list) pathOf(n);
  return out;
}

/**
 * The notes a path names. Titles may hold "/" themselves ("Journal - 8/11/2026"), so the path is matched against
 * each level's titles instead of being split. Case-insensitive when nothing matches exactly.
 */
export function findByPath(list: NoteSummary[], ref: string): NoteSummary[] {
  const clean = ref.trim().replace(/^\/+|\/+$/g, "");
  const kids = new Map<string | null, NoteSummary[]>();
  for (const n of list) {
    const k = n.parentId ?? null;
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k)!.push(n);
  }
  const walk = (rest: string, parent: string | null, eq: (a: string, b: string) => boolean): NoteSummary[] => {
    const hits: NoteSummary[] = [];
    for (const c of kids.get(parent) ?? []) {
      if (eq(rest, c.title)) hits.push(c);
      const head = rest.slice(0, c.title.length);
      if (rest.length > c.title.length && rest[c.title.length] === "/" && eq(head, c.title)) hits.push(...walk(rest.slice(c.title.length + 1), c.id, eq));
    }
    return hits;
  };
  const exact = walk(clean, null, (a, b) => a === b);
  return exact.length ? exact : walk(clean, null, (a, b) => a.toLowerCase() === b.toLowerCase());
}

const KIND_MARK: Record<string, string> = { folder: "/", canvas: " (canvas)", pdf: " (pdf)", file: " (file)", web: " (web)", kanban: " (kanban)" };

/** The tree as indented lines, `title  id8` each, folders ending in "/". From `root` (its subtree) when given. */
export function treeText(list: NoteSummary[], opts: { root?: string | null; depth?: number } = {}): string {
  const kids = new Map<string | null, NoteSummary[]>();
  for (const n of list) {
    const k = n.parentId ?? null;
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k)!.push(n);
  }
  const lines: string[] = [];
  const max = opts.depth ?? Infinity;
  const walk = (parent: string | null, depth: number) => {
    if (depth >= max) return;
    for (const n of kids.get(parent) ?? []) {
      lines.push(`${"  ".repeat(depth)}${n.title}${KIND_MARK[n.kind] ?? ""}  ${n.id.slice(0, 8)}`);
      walk(n.id, depth + 1);
    }
  };
  if (opts.root) {
    const r = list.find((n) => n.id === opts.root);
    if (r) lines.push(`${r.title}${KIND_MARK[r.kind] ?? ""}  ${r.id.slice(0, 8)}`);
    walk(opts.root, 1);
  } else walk(null, 0);
  return lines.join("\n");
}

// ---------------------------------------------------------------- blocks as markdown

/** One top-level block as markdown ("" for an empty paragraph). */
export const blockToMarkdown = (b: DocNode): string => docToMarkdown({ type: "doc", content: [b] }).replace(/\n+$/, "");

/** Drops what an editor fills in by default (null attrs, colspan 1, unstyled textStyle), and orders keys, so two trees compare by meaning. */
function norm(x: any): any {
  if (Array.isArray(x)) return x.map(norm);
  if (!x || typeof x !== "object") return x;
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(x).sort()) {
    const v = x[k];
    if (v === null || v === undefined) continue;
    if (k === "attrs") {
      const a = norm(v);
      for (const d of ["colspan", "rowspan"]) if (a[d] === 1) delete a[d];
      if (Object.keys(a).length) o.attrs = a;
    } else if (k === "marks") {
      const m = (v as any[]).map(norm).filter((mk) => !(mk.type === "textStyle" && !mk.attrs));
      if (m.length) o.marks = m;
    } else if (k === "content") {
      if ((v as any[]).length) o.content = norm(v);
    } else o[k] = norm(v);
  }
  return o;
}

export type { MdContext };

/** Markdown back into blocks, with [[links]] pointing at the pages they name and pictures at their media. */
function parseBlocks(md: string, ctx?: MdContext): DocNode[] {
  return markdownToDoc(md, ctx).content ?? [];
}

/** Whether a block survives being written as markdown and read back (portals, columns, colours and toggles don't). */
export function roundTrips(b: DocNode, ctx?: MdContext): boolean {
  const md = blockToMarkdown(b);
  if (!md) return b.type === "paragraph" && !(b.content ?? []).length;
  const back = parseBlocks(md, ctx);
  return back.length === 1 && JSON.stringify(norm(back[0])) === JSON.stringify(norm(b));
}

// ---------------------------------------------------------------- replace

export interface PatchResult {
  doc: DocNode;
  /** How many places changed. */
  replaced: number;
  /** Top-level blocks that were rewritten, by number (0 = first). */
  blocks: number[];
  /** "markdown": the blocks were rewritten from markdown; "text": the text was swapped inside the block, keeping its formatting. */
  mode: "markdown" | "text" | "mixed";
  /** Set when the rewrite changed what kind of blocks they are (a list became a to-do list, one block became two). */
  notice?: string;
}

const count = (hay: string, needle: string) => {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
};

/** Swaps `old` for `new` inside one text node of a block, keeping the node's marks. Returns the count changed. */
function textSwap(b: DocNode, old: string, neu: string, all: boolean): number {
  let n = 0;
  const walk = (x: DocNode) => {
    if (!all && n) return;
    if (x.type === "text" && typeof x.text === "string" && x.text.includes(old)) {
      if (all) {
        n += count(x.text, old);
        x.text = x.text.split(old).join(neu);
      } else {
        x.text = x.text.replace(old, () => neu);
        n++;
      }
      return;
    }
    x.content?.forEach(walk);
  };
  walk(b);
  return n;
}

/**
 * Replaces `old` with `new` in a page's body, like a find-and-replace on its markdown (`note export` shows it).
 * `old` has to appear exactly once unless `all`. Only the blocks it touches are rewritten; the rest stay exactly as
 * they were. A block that markdown can't hold whole (a portal, columns, coloured text) isn't rewritten: the text is
 * swapped inside it when `old` sits within one run of text, and otherwise the edit is refused unless `force`.
 */
export function patchDoc(doc: DocNode, old: string, neu: string, opts: { all?: boolean; force?: boolean; ctx?: MdContext } = {}): PatchResult {
  if (!old) throw new EtudeError("--old is empty: say what text to replace");
  const blocks = (doc.content ?? []).map((b) => structuredClone(b));
  const md = blocks.map(blockToMarkdown);
  // The page as markdown with blocks separated by a blank line, and where each block starts in it.
  const starts: number[] = [];
  let joined = "";
  md.forEach((m, i) => {
    if (i) joined += "\n\n";
    starts.push(joined.length);
    joined += m;
  });
  const hits: number[] = [];
  for (let i = joined.indexOf(old); i >= 0; i = joined.indexOf(old, i + old.length)) hits.push(i);
  if (!hits.length) {
    // Maybe it's plain text the markdown escapes (a * or _ in the text): try the raw text runs.
    const raw = blocks.reduce((s, b) => s + countRaw(b, old), 0);
    if (!raw) throw new EtudeError(`"${short(old)}" isn't on the page. Run \`etude note export\` to see the page as markdown.`, 404);
    if (raw > 1 && !opts.all) throw new EtudeError(`"${short(old)}" appears ${raw} times: make it longer so it's unique, or add --all`, 409);
    const changed: number[] = [];
    let n = 0;
    blocks.forEach((b, i) => {
      const k = textSwap(b, old, neu, true);
      if (k) (n += k), changed.push(i);
    });
    return { doc: { ...doc, content: blocks }, replaced: n, blocks: changed, mode: "text" };
  }
  if (hits.length > 1 && !opts.all) throw new EtudeError(`"${short(old)}" appears ${hits.length} times: make it longer so it's unique, or add --all`, 409);
  const blockAt = (pos: number) => {
    let i = 0;
    while (i + 1 < starts.length && starts[i + 1] <= pos) i++;
    return i;
  };
  // Group the hits by the run of blocks each one spans; overlapping runs merge.
  const runs: { from: number; to: number; hits: number[] }[] = [];
  for (const h of hits) {
    const from = blockAt(h), to = blockAt(h + old.length - 1);
    const last = runs[runs.length - 1];
    if (last && from <= last.to) (last.to = Math.max(last.to, to)), last.hits.push(h);
    else runs.push({ from, to, hits: [h] });
  }
  const out: DocNode[] = [];
  const changed: number[] = [];
  let modes = new Set<"markdown" | "text">();
  const notices: string[] = [];
  let cursor = 0;
  for (const r of runs) {
    out.push(...blocks.slice(cursor, r.from));
    const span = blocks.slice(r.from, r.to + 1);
    const lossy = span.map((b, j) => (roundTrips(b, opts.ctx) ? -1 : r.from + j)).filter((j) => j >= 0);
    if (lossy.length && r.from === r.to && span[0] && countRaw(span[0], old) === r.hits.length) {
      // One block markdown can't hold whole, and the text sits inside its runs of text: swap it in place.
      textSwap(span[0], old, neu, true);
      out.push(span[0]);
      modes.add("text");
    } else {
      if (lossy.length && !opts.force) {
        const what = lossy.map((j) => `${j} (${blocks[j].type})`).join(", ");
        throw new EtudeError(`the text runs through block ${what}, which markdown can't hold whole (a portal, columns, colours or a toggle would be lost). Replace a smaller piece inside one run of text, or add --force to rewrite it anyway.`, 409);
      }
      const before = span.map((b) => b.type);
      const base = starts[r.from];
      const end = starts[r.to] + md[r.to].length;
      let text = joined.slice(base, end);
      // Replace from the last hit back so earlier offsets stay right.
      for (const h of [...r.hits].reverse()) text = text.slice(0, h - base) + neu + text.slice(h - base + old.length);
      const made = parseBlocks(text, opts.ctx);
      const after = made.map((b) => b.type);
      if (before.join() !== after.join()) notices.push(`block${before.length > 1 ? "s" : ""} ${r.from}${r.to > r.from ? `–${r.to}` : ""} (${before.join(", ")}) became ${after.length ? after.join(", ") : "nothing"}: check that's what you meant (list items need their indent to stay in a list)`);
      out.push(...made);
      modes.add("markdown");
    }
    for (let j = r.from; j <= r.to; j++) changed.push(j);
    cursor = r.to + 1;
  }
  out.push(...blocks.slice(cursor));
  const mode = modes.size > 1 ? "mixed" : [...modes][0];
  return { doc: { ...doc, content: out.length ? out : [{ type: "paragraph" }] }, replaced: hits.length, blocks: changed, mode, ...(notices.length ? { notice: notices.join("; ") } : {}) };
}

function countRaw(b: DocNode, old: string): number {
  let n = 0;
  const walk = (x: DocNode) => {
    if (x.type === "text" && typeof x.text === "string") n += count(x.text, old);
    x.content?.forEach(walk);
  };
  walk(b);
  return n;
}

const short = (s: string) => (s.length > 60 ? s.slice(0, 57) + "…" : s).replace(/\n/g, "⏎");

// ---------------------------------------------------------------- insert

const plain = (b: DocNode): string => {
  let s = "";
  const walk = (x: DocNode) => {
    if (x.type === "text") s += x.text ?? "";
    else if (x.type === "noteLink") s += String(x.attrs?.label || x.attrs?.title || "");
    x.content?.forEach(walk);
  };
  walk(b);
  return s.trim();
};

/** The heading a section starts with: exact text first, then case-insensitive, then the one heading that starts with it. */
function findHeading(blocks: DocNode[], name: string): number {
  const heads = blocks.map((b, i) => ({ i, b })).filter(({ b }) => b.type === "heading");
  const want = name.replace(/^#+\s*/, "").trim();
  for (const eq of [(a: string) => a === want, (a: string) => a.toLowerCase() === want.toLowerCase(), (a: string) => a.toLowerCase().startsWith(want.toLowerCase())]) {
    const m = heads.filter(({ b }) => eq(plain(b)));
    if (m.length === 1) return m[0].i;
    if (m.length > 1) throw new EtudeError(`${m.length} headings match "${want}": use --at`, 409);
  }
  throw new EtudeError(`no heading "${want}" on the page`, 404);
}

/**
 * Puts new blocks into a page: at the end, at the top, before top-level block `at`, or at the end of the section
 * under a heading (before the next heading of the same or a higher level).
 */
export function insertBlocks(doc: DocNode, add: DocNode[], where: { at?: number; under?: string; top?: boolean } = {}): { doc: DocNode; at: number } {
  const blocks = [...(doc.content ?? [])];
  // A page that is only an empty paragraph starts fresh.
  const blank = blocks.length === 1 && blocks[0].type === "paragraph" && !(blocks[0].content ?? []).length;
  let at: number;
  if (where.top) at = 0;
  else if (where.at !== undefined) {
    if (!Number.isInteger(where.at) || where.at < 0) throw new EtudeError("--at is a block number, 0 or more");
    at = Math.min(where.at, blocks.length);
  } else if (where.under !== undefined) {
    const h = findHeading(blocks, where.under);
    const level = Number(blocks[h].attrs?.level ?? 1);
    at = h + 1;
    while (at < blocks.length && !(blocks[at].type === "heading" && Number(blocks[at].attrs?.level ?? 1) <= level)) at++;
    // Keep the section's trailing empty lines after what's added.
    while (at > h + 1 && blocks[at - 1].type === "paragraph" && !(blocks[at - 1].content ?? []).length) at--;
  } else {
    at = blocks.length;
    while (at > 0 && blocks[at - 1].type === "paragraph" && !(blocks[at - 1].content ?? []).length) at--;
  }
  if (blank) return { doc: { ...doc, content: add }, at: 0 };
  blocks.splice(at, 0, ...add);
  return { doc: { ...doc, content: blocks }, at };
}

/** Markdown as blocks to add, with [[links]] pointing at their pages. */
export const blocksFromMarkdown = (md: string, ctx?: MdContext): DocNode[] => {
  const b = parseBlocks(md, ctx);
  if (!b.length) throw new EtudeError("nothing to add: the markdown is empty");
  return b;
};

/** A page's body as numbered top-level blocks, each as markdown, for picking `--at` or seeing what `patch` would touch. */
export function blockList(doc: DocNode, ctx?: MdContext): { n: number; type: string; markdown: string; exact: boolean }[] {
  return (doc.content ?? []).map((b, n) => ({ n, type: b.type, markdown: blockToMarkdown(b), exact: roundTrips(b, ctx) }));
}

// ---------------------------------------------------------------- blocks as JSON

/** Top-level block `n` of a page, checked. */
function blockAt(doc: DocNode, n: number): DocNode {
  const blocks = doc.content ?? [];
  if (!Number.isInteger(n) || n < 0 || n >= blocks.length) throw new EtudeError(`no block ${n}: the page has ${blocks.length} (0 to ${blocks.length - 1})`, 404);
  return blocks[n];
}

/** A block from outside: one node object, with a type, as `note block` prints it. */
export function checkBlock(v: unknown): DocNode {
  if (!v || typeof v !== "object" || Array.isArray(v) || typeof (v as DocNode).type !== "string") throw new EtudeError('a block is a node object like { "type": "paragraph", "content": [...] }');
  if ((v as DocNode).type === "doc") throw new EtudeError("give the block itself, not a whole doc");
  return v as DocNode;
}

/** Blocks from outside: one node, a list of them, or a doc (its content). */
export function checkBlocks(v: unknown): DocNode[] {
  if (Array.isArray(v)) return v.map(checkBlock);
  if (v && typeof v === "object" && (v as DocNode).type === "doc") return ((v as DocNode).content ?? []).map(checkBlock);
  return [checkBlock(v)];
}

export const getBlock = (doc: DocNode, n: number): DocNode => structuredClone(blockAt(doc, n));

/** Replaces block `n` with one or more blocks. */
export function setBlock(doc: DocNode, n: number, blocks: DocNode[]): DocNode {
  blockAt(doc, n);
  const out = [...(doc.content ?? [])];
  out.splice(n, 1, ...blocks);
  return { ...doc, content: out.length ? out : [{ type: "paragraph" }] };
}

/** Removes `count` blocks from `n`. */
export function deleteBlocks(doc: DocNode, n: number, count = 1): DocNode {
  blockAt(doc, n);
  if (!Number.isInteger(count) || count < 1) throw new EtudeError("--count is 1 or more");
  const out = [...(doc.content ?? [])];
  out.splice(n, count);
  return { ...doc, content: out.length ? out : [{ type: "paragraph" }] };
}

/** Moves `count` blocks from `n` so the first lands at position `to` of the page as it is now (before the move). */
export function moveBlocks(doc: DocNode, n: number, to: number, count = 1): DocNode {
  const blocks = doc.content ?? [];
  blockAt(doc, n);
  if (!Number.isInteger(count) || count < 1 || n + count > blocks.length) throw new EtudeError(`--count runs past the last block (${blocks.length - 1})`);
  if (!Number.isInteger(to) || to < 0 || to > blocks.length) throw new EtudeError(`--to is 0 to ${blocks.length}`);
  if (to >= n && to <= n + count) return doc;
  const out = [...blocks];
  const moved = out.splice(n, count);
  out.splice(to > n ? to - count : to, 0, ...moved);
  return { ...doc, content: out };
}

// ---------------------------------------------------------------- files and web files (plain text)

/** Find-and-replace in a file's text, exactly. */
export function patchText(content: string, old: string, neu: string, opts: { all?: boolean } = {}): { content: string; replaced: number; lines: number[] } {
  if (!old) throw new EtudeError("--old is empty: say what text to replace");
  const n = count(content, old);
  if (!n) throw new EtudeError(`"${short(old)}" isn't in the file. Run \`etude note read\` to see it.`, 404);
  if (n > 1 && !opts.all) throw new EtudeError(`"${short(old)}" appears ${n} times: make it longer so it's unique, or add --all`, 409);
  const lines: number[] = [];
  for (let i = content.indexOf(old); i >= 0; i = content.indexOf(old, i + old.length)) lines.push(content.slice(0, i).split("\n").length);
  const out = opts.all ? content.split(old).join(neu) : content.replace(old, () => neu);
  return { content: out, replaced: opts.all ? n : 1, lines };
}

/** Adds text to a file: at the end, at the top, or before line `at` (1 = first). */
export function insertText(content: string, add: string, where: { at?: number; top?: boolean } = {}): { content: string; line: number } {
  const lines = content.split("\n");
  const piece = add.endsWith("\n") ? add.slice(0, -1) : add;
  let at: number;
  if (where.top) at = 0;
  else if (where.at !== undefined) {
    if (!Number.isInteger(where.at) || where.at < 1) throw new EtudeError("--at is a line number, 1 or more");
    at = Math.min(where.at - 1, lines.length);
  } else {
    // At the end, after the last line (keeping one trailing newline if the file had one).
    if (!content) return { content: piece + (add.endsWith("\n") ? "\n" : ""), line: 1 };
    const trailing = content.endsWith("\n");
    const body = trailing ? content.slice(0, -1) : content;
    return { content: body + "\n" + piece + (trailing ? "\n" : ""), line: body.split("\n").length + 1 };
  }
  lines.splice(at, 0, ...piece.split("\n"));
  return { content: lines.join("\n"), line: at + 1 };
}

/** A file with line numbers, like `cat -n`, for picking --at. */
export const numberedText = (content: string) => content.split("\n").map((l, i) => `${String(i + 1).padStart(4)}  ${l}`).join("\n");
