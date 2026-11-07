// Notes' start page: what a New tab shows. A big search box (find a page, or type a title for a new one), the
// things you can make with their keys, then your pinned pages and what you opened last as cards that show the top
// of each page. Cards are built from the stored document (a few top-level blocks), never by mounting the editor;
// canvases and PDFs draw themselves once they scroll into view.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import { FileCode2, FilePlus2, FileText, Folder, FolderInput, FolderPlus, PenTool, Pin, Plus, Search } from "lucide-react";
import { api, type NoteDoc, type NotePreview, type NoteSummary } from "@/lib/api";
import { useEtudeSrc } from "@/lib/local-url";
import { useScheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { highlight } from "@/editor/highlight";
import { fileLanguage } from "@/editor/file-editor";
import { NoteIcon } from "@/editor/note-icon";
import { Preview as CanvasPreview } from "@/editor/note-canvas";
import { pdfFirstPage } from "@/editor/note-embed";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import "./note-start.css";

// ---------------------------------------------------------------- the tab itself

/** A start page's tab id: it isn't a note, it's a New tab (kept in the tab list like a page's id). */
export const START_PREFIX = "new:";
export const isStartTab = (id: string | null | undefined): id is string => typeof id === "string" && id.startsWith(START_PREFIX);
export const newStartTab = () => START_PREFIX + Math.random().toString(36).slice(2, 10);

/** The New tab's icon in the tab strip: an empty page with a dashed edge. */
export function StartTabIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" strokeDasharray="2.6 2.6" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = MAC ? "⌘" : "Ctrl";
const ALT = MAC ? "⌥" : "Alt";

/**
 * Ctrl/⌘+Alt+N/C/F (new page, canvas, file). On Windows Ctrl+Alt is AltGr on many layouts, where it types a
 * character, so AltGr is never taken. Returns which one the key is, or null.
 */
export function startShortcut(e: KeyboardEvent): "page" | "canvas" | "file" | null {
  if (!(e.ctrlKey || e.metaKey) || !e.altKey || e.shiftKey) return null;
  if (e.getModifierState?.("AltGraph")) return null;
  const k = e.code === "KeyN" || e.key.toLowerCase() === "n" ? "page" : e.code === "KeyC" || e.key.toLowerCase() === "c" ? "canvas" : e.code === "KeyF" || e.key.toLowerCase() === "f" ? "file" : null;
  return k;
}

// ---------------------------------------------------------------- helpers

const display = (n: { title: string; kind?: string }) =>
  n.title.trim() || (n.kind === "folder" ? "New folder" : n.kind === "canvas" ? "Untitled canvas" : n.kind === "pdf" ? "Untitled PDF" : n.kind === "file" ? "untitled.txt" : "Untitled");
const fallbackIcon = (n: { kind?: string }) => (n.kind === "canvas" ? "🎨" : n.kind === "pdf" ? "📕" : "📄");

function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 30) return `${d} days ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

function KindIcon({ n, size = 18 }: { n: NoteSummary; size?: number }) {
  if (n.kind === "folder" && !n.icon) return <Folder style={{ width: size - 2, height: size - 2 }} />;
  if (n.kind === "file" && !n.icon) return <FileCode2 style={{ width: size - 2, height: size - 2 }} />;
  return <NoteIcon icon={n.icon} size={size} fallback={fallbackIcon(n)} />;
}

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="ns-kb" aria-hidden>
      {keys.map((k) => (
        <kbd key={k}>{k}</kbd>
      ))}
    </span>
  );
}

/** Which letters of `title` match `q`, and how well (higher is better, below 0 is no match). Like the Ctrl K finder. */
function score(n: NoteSummary, q: string, path: string): { score: number; marks: [number, number] | null } {
  const t = display(n).toLowerCase();
  const at = t.indexOf(q);
  if (t === q) return { score: 1000, marks: [0, q.length] };
  if (at === 0) return { score: 900 - t.length / 10, marks: [0, q.length] };
  if (at > 0) return { score: 700 - at - t.length / 10, marks: [at, at + q.length] };
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every((w) => t.includes(w))) return { score: 500, marks: null };
  const hay = `${path.toLowerCase()} ${t}`;
  if (words.every((w) => hay.includes(w))) return { score: 300, marks: null };
  return { score: -1, marks: null };
}

function Marked({ text, marks }: { text: string; marks: [number, number] | null }) {
  if (!marks) return <>{text}</>;
  return (
    <>
      {text.slice(0, marks[0])}
      <mark className="ns-hit">{text.slice(marks[0], marks[1])}</mark>
      {text.slice(marks[1])}
    </>
  );
}

// ---------------------------------------------------------------- previews

function Math_({ latex, display: block }: { latex: string; display: boolean }) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(latex || "\\square", { displayMode: block, throwOnError: false, strict: "ignore", trust: false, maxSize: 30, maxExpand: 300 });
    } catch {
      return "";
    }
  }, [latex, block]);
  return <span className={block ? "ns-eq" : undefined} dangerouslySetInnerHTML={{ __html: html }} />;
}

function Inline({ nodes }: { nodes?: NoteDoc[] }) {
  return (
    <>
      {(nodes ?? []).map((n, i) => {
        if (n.type === "text") {
          let el: ReactNode = n.text ?? "";
          for (const m of n.marks ?? []) {
            if (m.type === "bold") el = <b>{el}</b>;
            else if (m.type === "italic") el = <i>{el}</i>;
            else if (m.type === "code") el = <code>{el}</code>;
            else if (m.type === "strike") el = <s>{el}</s>;
            else if (m.type === "underline") el = <u>{el}</u>;
            else if (m.type === "link") el = <span className="ns-a">{el}</span>;
          }
          return <span key={i}>{el}</span>;
        }
        if (n.type === "hardBreak") return <br key={i} />;
        if (n.type === "mathInline") return <Math_ key={i} latex={String(n.attrs?.latex ?? "")} display={false} />;
        if (n.type === "noteLink") return <span key={i} className="ns-a">{String(n.attrs?.label || n.attrs?.title || "")}</span>;
        return n.content ? <Inline key={i} nodes={n.content} /> : null;
      })}
    </>
  );
}

function CodePeek({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void highlight(code, lang).then((h) => live && setHtml(h), () => {});
    return () => void (live = false);
  }, [code, lang]);
  return html === null ? <pre className="ns-code">{code}</pre> : <pre className="ns-code" dangerouslySetInnerHTML={{ __html: html }} />;
}

function Img({ src }: { src: string }) {
  const url = useEtudeSrc(src.startsWith("files/") ? `/media/${src}` : src);
  return url ? <img className="ns-img" src={url} alt="" loading="lazy" /> : null;
}

/** One top-level block of a page, drawn read-only and small. */
function Block({ n }: { n: NoteDoc }) {
  const kids = n.content ?? [];
  switch (n.type) {
    case "paragraph":
      return kids.length ? <p><Inline nodes={kids} /></p> : null;
    case "heading":
      return <div className={cn("ns-h", `ns-h${Math.min(3, Number(n.attrs?.level ?? 2))}`)}><Inline nodes={kids} /></div>;
    case "bulletList":
    case "orderedList":
    case "taskList": {
      const L = n.type === "orderedList" ? "ol" : "ul";
      return (
        <L className={n.type === "taskList" ? "ns-tasks" : undefined}>
          {kids.slice(0, 6).map((li, i) => (
            <li key={i} className={n.type === "taskList" && li.attrs?.checked ? "is-done" : undefined}>
              {n.type === "taskList" && <span className="ns-box" aria-hidden />}
              <span className="ns-li-t"><Inline nodes={li.content?.[0]?.content} /></span>
            </li>
          ))}
        </L>
      );
    }
    case "blockquote":
      return <blockquote>{kids.slice(0, 2).map((k, i) => <Block key={i} n={k} />)}</blockquote>;
    case "codeBlock":
      return <CodePeek code={(kids.map((k) => k.text ?? "").join("") || " ").split("\n").slice(0, 8).join("\n")} lang={String(n.attrs?.language ?? "")} />;
    case "mathBlock":
      return <Math_ latex={String(n.attrs?.latex ?? "")} display />;
    case "callout":
      return <div className="ns-callout" data-kind={String(n.attrs?.kind ?? "note")}>{kids.slice(0, 2).map((k, i) => <Block key={i} n={k} />)}</div>;
    case "table":
      return (
        <table className="ns-table">
          <tbody>
            {kids.slice(0, 4).map((r, i) => (
              <tr key={i}>
                {(r.content ?? []).slice(0, 4).map((c, j) => {
                  const C = c.type === "tableHeader" ? "th" : "td";
                  return <C key={j}><Inline nodes={c.content?.[0]?.content} /></C>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "noteCard":
    case "noteCards":
      return (
        <div className="ns-cardblock">
          <small>{n.type === "noteCard" ? "Card" : "Cards"}</small>
          <div>{n.type === "noteCards" ? String(n.attrs?.deck || n.attrs?.q || "A few cards") : "Answer it in the page"}</div>
        </div>
      );
    case "image":
      return n.attrs?.src ? <Img src={String(n.attrs.src)} /> : null;
    case "columns":
      return <div className="ns-cols">{kids.slice(0, 3).map((c, i) => <div key={i}>{(c.content ?? []).slice(0, 2).map((k, j) => <Block key={j} n={k} />)}</div>)}</div>;
    case "details":
      return <p className="ns-details">▸ <Inline nodes={kids[0]?.content} /></p>;
    case "horizontalRule":
      return <hr />;
    case "canvasEmbed":
    case "htmlEmbed":
    case "noteVideo":
    case "notePdf":
      return <div className="ns-cardblock"><small>{n.type === "canvasEmbed" ? "Canvas" : n.type === "htmlEmbed" ? "Widget" : n.type === "noteVideo" ? "Video" : "PDF"}</small><div>{String(n.attrs?.title || n.attrs?.name || "")}</div></div>;
    default:
      return kids.length && kids.every((k) => k.type === "text") ? <p><Inline nodes={kids} /></p> : null;
  }
}

/** Calls back once the element has scrolled near the screen. */
function useSeen<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

function CanvasPeek({ id }: { id: string }) {
  const [ref, seen] = useSeen<HTMLDivElement>();
  const [scene, setScene] = useState<Parameters<typeof CanvasPreview>[0]["scene"] | null>(null);
  const dark = useScheme() === "dark";
  useEffect(() => {
    if (!seen) return;
    let live = true;
    void api.note(id).then((n) => live && n.scene && setScene(n.scene), () => {});
    return () => void (live = false);
  }, [seen, id]);
  return <div ref={ref} className="ns-canvas">{scene && <CanvasPreview scene={scene} dark={dark} />}</div>;
}

function PdfPeek({ id }: { id: string }) {
  const [ref, seen] = useSeen<HTMLDivElement>();
  const [file, setFile] = useState<string | null>(null);
  useEffect(() => {
    if (!seen) return;
    let live = true;
    void api.note(id).then((n) => live && setFile(n.file), () => {});
    return () => void (live = false);
  }, [seen, id]);
  const url = useEtudeSrc(file ? `/media/${file}` : null);
  useEffect(() => {
    if (!url) return;
    let live = true;
    const w = Math.max(160, ref.current?.clientWidth ?? 240);
    void pdfFirstPage(url, w).then((c) => live && ref.current?.replaceChildren(c), () => {});
    return () => void (live = false);
  }, [url]);
  return <div ref={ref} className="ns-pdf" />;
}

/** The top of the note, small and read-only: icon, title, then its first blocks (or a file's first lines). */
function Peek({ n, p }: { n: NoteSummary; p: NotePreview | undefined }) {
  if (n.kind === "canvas") return <CanvasPeek id={n.id} />;
  if (n.kind === "pdf") return <PdfPeek id={n.id} />;
  if (n.kind === "file")
    return (
      <div className="ns-top">
        <div className="ns-ttl ns-mono">{display(n)}</div>
        {p?.head != null && <CodePeek code={p.head.split("\n").slice(0, 8).join("\n") || " "} lang={fileLanguage(n.title)?.name ?? ""} />}
      </div>
    );
  return (
    <div className="ns-top">
      <span className="ns-pic"><KindIcon n={n} size={30} /></span>
      <div className="ns-ttl">{display(n)}</div>
      {n.kind === "folder" ? <p className="ns-muted">{n.children} {n.children === 1 ? "thing" : "things"} inside</p> : p?.blocks.map((b, i) => <Block key={i} n={b} />)}
    </div>
  );
}

// ---------------------------------------------------------------- the page

export interface StartActions {
  page(): void;
  canvas(): void;
  file(): void;
  folder(): void;
  pdf(): void;
  importMd(): void;
  importVault(): void;
}

export function NoteStart({ bar, list, phone, onOpen, onCreate, onPin, actions }: {
  /** The top bar (tabs and +), the same as a page's. */
  bar: ReactNode;
  list: NoteSummary[];
  phone?: boolean;
  /** Open in this tab, or in a new one ("new": go there; "background": stay). */
  onOpen(id: string, tab?: "new" | "background"): void;
  /** A new page with this title, here or in a new tab. */
  onCreate(title: string, newTab: boolean): void;
  onPin(n: NoteSummary, on: boolean): void;
  actions: StartActions;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const box = useRef<HTMLInputElement>(null);
  const resRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!phone) box.current?.focus({ preventScroll: true });
  }, [phone]);
  // Ctrl/⌘+K here is this box (elsewhere it's the deck and page finder, which sees the key already taken).
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k")) return;
      if (document.querySelector("[role=dialog], [role=alertdialog]")) return;
      e.preventDefault();
      box.current?.focus();
      box.current?.select();
    };
    document.addEventListener("keydown", h, true);
    return () => document.removeEventListener("keydown", h, true);
  }, []);

  const by = useMemo(() => new Map(list.map((n) => [n.id, n])), [list]);
  const pathOf = (n: NoteSummary) => {
    const out: string[] = [];
    for (let p = n.parentId ? by.get(n.parentId) : undefined; p; p = p.parentId ? by.get(p.parentId) : undefined) out.unshift(display(p));
    return out.join(" › ");
  };

  const query = q.trim();
  const hits = useMemo(() => {
    if (!query) return [];
    const ql = query.toLowerCase();
    return list
      .map((n) => ({ n, path: pathOf(n), ...score(n, ql, pathOf(n)) }))
      .filter((h) => h.score >= 0)
      .sort((a, b) => b.score - a.score || display(a.n).localeCompare(display(b.n)))
      .slice(0, 8);
  }, [list, query]);
  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    resRef.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);
  const count = query ? hits.length + 1 : 0;
  const choose = (i: number, newTab: boolean) => {
    if (i < hits.length) onOpen(hits[i].n.id, newTab ? "new" : undefined);
    else if (query) onCreate(query, newTab);
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      if (q) {
        e.preventDefault();
        e.stopPropagation();
        setQ("");
      }
      return;
    }
    if (!count) return;
    if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => (s + 1) % count));
    else if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => (s - 1 + count) % count));
    else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      choose(sel, e.ctrlKey || e.metaKey);
    }
  };

  // Pinned in pin order; Jump back in = the last four opened that aren't pinned; Earlier = the next six.
  const pinned = useMemo(() => list.filter((n) => n.pinned).sort((a, b) => a.pinned!.localeCompare(b.pinned!)), [list]);
  const opened = useMemo(() => list.filter((n) => n.opened && !n.pinned && n.kind !== "folder").sort((a, b) => b.opened!.localeCompare(a.opened!)), [list]);
  const jump = opened.slice(0, 4);
  const earlier = opened.slice(4, 10);
  const nothing = !pinned.length && !opened.length;

  // The previews for the cards on screen, in one request; asked again when one of them changes.
  const cardNotes = useMemo(() => [...pinned, ...jump], [pinned, jump]);
  const want = cardNotes.filter((n) => n.kind === "page" || n.kind === "file" || !n.kind);
  const key = want.map((n) => `${n.id}@${n.updated}`).join(",");
  const [previews, setPreviews] = useState<Map<string, NotePreview>>(new Map());
  useEffect(() => {
    if (!want.length) return;
    let live = true;
    void api.notePreviews(want.map((n) => n.id)).then((ps) => live && setPreviews(new Map(ps.map((p) => [p.id, p]))), () => {});
    return () => void (live = false);
  }, [key]);

  const card = (n: NoteSummary) => {
    const isPinned = !!n.pinned;
    // Where it lives: the folder or page it's in (the whole path is in the Earlier rows and the results).
    const parent = n.parentId ? by.get(n.parentId) : undefined;
    const where = parent ? display(parent) : "Notes";
    const when = ago(n.opened ?? n.updated);
    return (
      <div
        key={n.id}
        role="link"
        tabIndex={0}
        title={display(n)}
        className="ns-card"
        data-note={n.id}
        onClick={(e) => onOpen(n.id, e.ctrlKey || e.metaKey ? "new" : undefined)}
        onMouseDown={(e) => e.button === 1 && e.preventDefault()}
        onAuxClick={(e) => e.button === 1 && onOpen(n.id, "background")}
        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), onOpen(n.id, e.ctrlKey || e.metaKey ? "new" : undefined))}
      >
        <button
          type="button"
          className={cn("ns-pin", isPinned && "is-on")}
          aria-label={isPinned ? `Unpin ${display(n)}` : `Pin ${display(n)}`}
          aria-pressed={isPinned}
          title={isPinned ? "Unpin" : "Pin to the start page"}
          onClick={(e) => (e.stopPropagation(), onPin(n, !isPinned))}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <Pin className="size-[15px]" fill={isPinned ? "currentColor" : "none"} />
        </button>
        <div className="ns-pv">
          <Peek n={n} p={previews.get(n.id)} />
          {/* A drawing or a document has no title of its own on the card, so it gets a small one. */}
          {(n.kind === "canvas" || n.kind === "pdf") && (
            <div className="ns-kindttl">
              <KindIcon n={n} size={14} />
              <span className="truncate">{display(n)}</span>
            </div>
          )}
        </div>
        <div className="ns-foot">{when ? `${when} · ${where}` : where}</div>
      </div>
    );
  };

  const act = (label: string, icon: ReactNode, onClick: () => void, keys?: string[]) => (
    <button type="button" className="ns-act" onClick={onClick}>
      <span className="ns-act-ic" aria-hidden>{icon}</span>
      <span className="truncate">{label}</span>
      {keys && <Keys keys={keys} />}
    </button>
  );

  return (
    <article className="note-page ns-page">
      {bar}
      <div className="ns-scroll">
        <div className="ns-in">
          <label className={cn("ns-search", query && "is-typed")}>
            <Search className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            <input
              ref={box}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onKey}
              placeholder="Find a page, or type a title for a new one"
              aria-label="Find a page, or type a title for a new one"
              autoComplete="off"
              spellCheck={false}
              role="combobox"
              aria-expanded={!!query}
              aria-controls="ns-results"
              aria-activedescendant={query ? `ns-r-${sel}` : undefined}
            />
            <span className="ns-search-kb"><Keys keys={[MOD, "K"]} /></span>
            <span className="ns-search-ent" aria-hidden>↵ open</span>
          </label>

          {query ? (
            <div ref={resRef} id="ns-results" role="listbox" aria-label="Pages" className="ns-results">
              {hits.map((h, i) => (
                <div
                  key={h.n.id}
                  id={`ns-r-${i}`}
                  data-i={i}
                  role="option"
                  aria-selected={i === sel}
                  className={cn("ns-row", i === sel && "is-sel")}
                  onMouseMove={() => i !== sel && setSel(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => choose(i, e.ctrlKey || e.metaKey)}
                >
                  <span className="ns-row-ic"><KindIcon n={h.n} /></span>
                  <span className="ns-row-t"><Marked text={display(h.n)} marks={h.marks} /></span>
                  <span className="ns-row-p">{h.path}</span>
                  <span className="ns-row-w">{h.n.kind === "pdf" ? "PDF" : h.n.kind === "canvas" ? "Canvas" : h.n.kind === "folder" ? "Folder" : h.n.kind === "file" ? "File" : ""}</span>
                </div>
              ))}
              <div
                id={`ns-r-${hits.length}`}
                data-i={hits.length}
                role="option"
                aria-selected={sel === hits.length}
                className={cn("ns-row", sel === hits.length && "is-sel")}
                onMouseMove={() => sel !== hits.length && setSel(hits.length)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => choose(hits.length, e.ctrlKey || e.metaKey)}
              >
                <span className="ns-row-ic"><Plus className="size-4" /></span>
                <span className="ns-row-t">New page “{query}”</span>
                <span className="ns-row-p" />
                <span className="ns-row-w">{phone ? "" : "↵"}</span>
              </div>
            </div>
          ) : (
            <>
              <div className="ns-acts">
                {act("New page", <FilePlus2 className="size-4" />, actions.page, [MOD, ALT, "N"])}
                {act("New canvas", <PenTool className="size-4" />, actions.canvas, [MOD, ALT, "C"])}
                {act("New file", <FileCode2 className="size-4" />, actions.file, [MOD, ALT, "F"])}
                {act("New folder", <FolderPlus className="size-4" />, actions.folder)}
                {act("Add a PDF", <FileText className="size-4" />, actions.pdf)}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" className="ns-act">
                      <span className="ns-act-ic" aria-hidden><FolderInput className="size-4" /></span>
                      <span className="truncate">Import</span>
                      <span className="ns-act-more">Markdown, vault</span>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-64">
                    <DropdownMenuItem onSelect={actions.importMd}>Markdown, code or .excalidraw files…</DropdownMenuItem>
                    <DropdownMenuItem onSelect={actions.importVault}>A folder (Obsidian vault)…</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              {nothing ? (
                <p className="ns-none">Pages you open show up here.</p>
              ) : (
                <>
                  <section className="ns-sec" aria-label="Pinned">
                    <div className="ns-lbl">Pinned</div>
                    {pinned.length ? (
                      <div className="ns-shelf">{pinned.map(card)}</div>
                    ) : (
                      <div className="ns-pinnone">
                        <Pin className="size-[18px] shrink-0" aria-hidden />
                        Pin a page to keep it here: hover a card and press the pin, or right-click a page.
                      </div>
                    )}
                  </section>
                  {jump.length > 0 && (
                    <section className="ns-sec" aria-label="Jump back in">
                      <div className="ns-lbl">Jump back in</div>
                      <div className="ns-shelf">{jump.map(card)}</div>
                    </section>
                  )}
                  {earlier.length > 0 && (
                    <section className="ns-sec ns-earlier" aria-label="Earlier">
                      <div className="ns-lbl">Earlier</div>
                      <div className="ns-grid2">
                        {earlier.map((n) => (
                          <button
                            key={n.id}
                            type="button"
                            className="ns-row"
                            onClick={(e) => onOpen(n.id, e.ctrlKey || e.metaKey ? "new" : undefined)}
                            onMouseDown={(e) => e.button === 1 && e.preventDefault()}
                            onAuxClick={(e) => e.button === 1 && onOpen(n.id, "background")}
                          >
                            <span className="ns-row-ic"><KindIcon n={n} /></span>
                            <span className="ns-row-t">{display(n)}</span>
                            <span className="ns-row-p">{pathOf(n)}</span>
                            <span className="ns-row-w">{ago(n.opened)}</span>
                          </button>
                        ))}
                      </div>
                    </section>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </article>
  );
}
