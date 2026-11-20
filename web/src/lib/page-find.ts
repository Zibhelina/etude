// Finding Notebook pages from Ctrl/⌘K: by title the way decks are found (the whole name, its start, a piece of
// it, words that start words of its path, then letters in order), blind to accents and case. Pure, so the finder
// and the tests share it.

export interface FindablePage {
  id: string;
  title: string;
  parentId: string | null;
  archived?: boolean;
  opened?: string | null;
}
export interface PageHit<P extends FindablePage = FindablePage> {
  n: P;
  score: number;
  /** Character positions in the title to bold. */
  marks: number[];
  /** The folders and pages it sits in, outermost first ("Algorithms › Week 3"). */
  path: string;
  /** For a page found by its text: the words around the match. */
  snippet?: string;
}

/** Lowercased and without accents, one character for each character of `s`, so positions stay the title's. */
export const fold = (s: string) => [...s].map((c) => c.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() || c).map((c) => [...c][0] ?? "").join("");
const range = (start: number, n: number) => Array.from({ length: n }, (_, i) => start + i);
const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SEP = /[\s\-_/.():›,]+/;

function subsequence(s: string, q: string): number[] | null {
  const out: number[] = [];
  let from = 0;
  for (const ch of q) {
    let i = -1;
    for (let j = from; j < s.length; j++) {
      if (s[j] === ch && (j === 0 || /[\s\-_:./()]/.test(s[j - 1]))) {
        i = j;
        break;
      }
    }
    if (i < 0) i = s.indexOf(ch, from);
    if (i < 0) return null;
    out.push(i);
    from = i + 1;
  }
  return out;
}

/** Each page's path of parents, outermost first, joined with " › ". */
export function pagePaths<P extends FindablePage>(pages: P[]): Map<string, string> {
  const by = new Map(pages.map((p) => [p.id, p]));
  const out = new Map<string, string>();
  for (const p of pages) {
    const up: string[] = [];
    const seen = new Set<string>([p.id]);
    for (let a = p.parentId ? by.get(p.parentId) : undefined; a && !seen.has(a.id); a = a.parentId ? by.get(a.parentId) : undefined) {
      seen.add(a.id);
      up.unshift(a.title.trim() || "Untitled");
    }
    out.set(p.id, up.join(" › "));
  }
  return out;
}

/** How well a page's title (and the path above it) answers what was typed; null when it doesn't. */
export function matchPage<P extends FindablePage>(n: P, path: string, raw: string): PageHit<P> | null {
  const q = fold(raw.trim()).replace(/\s+/g, " ");
  if (!q) return null;
  const title = n.title.trim() || "Untitled";
  const name = fold(title);
  const full = fold(`${path} ${title}`);
  const hit = (score: number, marks: number[]): PageHit<P> => ({ n, score, marks, path });
  if (name === q) return hit(1000, range(0, q.length));
  if (name.startsWith(q)) return hit(900 - name.length / 10, range(0, q.length));
  const at = name.indexOf(q);
  if (at >= 0) return hit(700 - at - name.length / 10, range(at, q.length));
  // Words: each has to start a word of the title or of a folder above it ("307 greedy").
  const words = q.split(" ").filter(Boolean);
  const tokens = full.split(SEP).filter(Boolean);
  if (words.length && words.every((w) => tokens.some((t) => t.startsWith(w)))) {
    const own = name.split(SEP).filter(Boolean);
    const exact = words.filter((w) => tokens.includes(w)).length;
    const inTitle = words.filter((w) => own.some((t) => t.startsWith(w))).length;
    const marks = words.flatMap((w) => {
      const i = name.search(new RegExp(`(^|[\\s\\-_/.():,])${esc(w)}`));
      return i >= 0 ? range(i === 0 && name.startsWith(w) ? 0 : i + 1, w.length) : [];
    });
    return hit(500 + exact * 40 + inTitle * 30 - full.length / 20, marks);
  }
  // Letters in order, in the title only, and only when they sit close together ("grdy" → Greedy).
  const sub = q.length >= 2 ? subsequence(name, q.replace(/ /g, "")) : null;
  if (sub) {
    const spread = sub[sub.length - 1] - sub[0];
    if (spread <= q.length * 3) return hit(300 - spread - name.length / 10, sub);
  }
  return null;
}

/** The pages that answer what was typed, best first. Archived pages are left out. */
export function findPages<P extends FindablePage>(pages: P[], raw: string, limit = 30): PageHit<P>[] {
  if (!raw.trim()) return [];
  const paths = pagePaths(pages);
  return pages
    .filter((p) => !p.archived)
    .map((p) => matchPage(p, paths.get(p.id) ?? "", raw))
    .filter((h): h is PageHit<P> => !!h)
    .sort((a, b) => b.score - a.score || a.n.title.localeCompare(b.n.title))
    .slice(0, limit);
}

/** Before anything is typed: the pages opened last, newest first. */
export function recentPages<P extends FindablePage & { kind?: string }>(pages: P[], limit = 5): PageHit<P>[] {
  const paths = pagePaths(pages);
  return pages
    .filter((p) => !p.archived && p.opened && p.kind !== "folder")
    .sort((a, b) => String(b.opened).localeCompare(String(a.opened)))
    .slice(0, limit)
    .map((n) => ({ n, score: 0, marks: [], path: paths.get(n.id) ?? "" }));
}
