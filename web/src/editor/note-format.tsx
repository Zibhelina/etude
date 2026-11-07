// Formatting UI for notes: the "Aa" picker in the selection bar (text colour, highlight, font, size), the
// alignment buttons, and the block menu that the ⋮⋮ grip opens (turn into, colour the whole block, align,
// duplicate, delete).
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, ChevronDown, Columns2, Copy, Trash2 } from "lucide-react";
import { COLORS, FONTS, SIZES } from "./note-style";
import { BLOCK_MENU_EVENT, type BlockMenuDetail } from "./note-handle";
import { cn } from "@/lib/utils";

const stop = (e: React.MouseEvent) => e.preventDefault();

/** The current text style at the selection (the first value found). */
function current(editor: Editor) {
  const a = editor.getAttributes("textStyle") as Record<string, string | undefined>;
  const id = (re: RegExp, v?: string) => (v && re.exec(v)?.[1]) || null;
  return {
    color: id(/^var\(--nc-(\w+)\)$/, a.color),
    bg: id(/^var\(--nc-(\w+)-bg\)$/, a.backgroundColor),
    font: FONTS.find((f) => f.css === a.fontFamily)?.id ?? null,
    size: SIZES.find((s) => s.css === a.fontSize)?.id ?? null,
  };
}

function Swatches({ editor, onDone }: { editor: Editor; onDone?(): void }) {
  const cur = current(editor);
  const chip = (on: boolean, label: string, run: () => void, child: React.ReactNode) => (
    <button key={label} type="button" title={label} aria-label={label} aria-pressed={on} onMouseDown={stop} onClick={() => (run(), onDone?.())} className={cn("note-swatch", on && "is-on")}>
      {child}
    </button>
  );
  return (
    <div className="note-fmt-pop" onMouseDown={stop}>
      <div className="note-fmt-head">Text colour</div>
      <div className="note-swatches">
        {chip(!cur.color, "Default colour", () => editor.chain().focus().setTextColor(null).run(), <span className="note-swatch-a">A</span>)}
        {COLORS.map((c) => chip(cur.color === c.id, `${c.label} text`, () => editor.chain().focus().setTextColor(c.id).run(), <span className="note-swatch-a" style={{ color: `var(--nc-${c.id})` }}>A</span>))}
      </div>
      <div className="note-fmt-head">Highlight</div>
      <div className="note-swatches">
        {chip(!cur.bg, "No highlight", () => editor.chain().focus().setHighlightColor(null).run(), <span className="note-swatch-bg is-none" />)}
        {COLORS.map((c) => chip(cur.bg === c.id, `${c.label} highlight`, () => editor.chain().focus().setHighlightColor(c.id).run(), <span className="note-swatch-bg" style={{ background: `var(--nc-${c.id}-bg)` }} />))}
      </div>
      <div className="note-fmt-head">Font</div>
      <div className="note-fmt-row">
        {chip(!cur.font, "Page font", () => editor.chain().focus().setNoteFont(null).run(), <span className="note-fmt-word">Page</span>)}
        {FONTS.map((f) => chip(cur.font === f.id, `${f.label} font`, () => editor.chain().focus().setNoteFont(f.id).run(), <span className="note-fmt-word" style={{ fontFamily: f.css }}>{f.label}</span>))}
      </div>
      <div className="note-fmt-head">Size</div>
      <div className="note-fmt-row">
        {chip(!cur.size, "Normal size", () => editor.chain().focus().setNoteSize(null).run(), <span className="note-fmt-word">Normal</span>)}
        {SIZES.map((s) => chip(cur.size === s.id, `${s.label} text`, () => editor.chain().focus().setNoteSize(s.id).run(), <span className="note-fmt-word">{s.label}</span>))}
      </div>
    </div>
  );
}

/** Re-renders on every editor change, so selected states follow what was just picked. */
function useTick(editor: Editor) {
  const [, set] = useState(0);
  useEffect(() => {
    const f = () => set((n) => n + 1);
    editor.on("transaction", f);
    return () => void editor.off("transaction", f);
  }, [editor]);
}

/** "Aa ▾" in the selection bar: opens the colour, highlight, font and size picker above it (below near the top). */
export function StyleButton({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(true);
  const btn = useRef<HTMLButtonElement>(null);
  useTick(editor);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !(e.target as HTMLElement).closest(".note-fmt-anchor") && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    const off = () => setOpen(false);
    editor.on("blur", off);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
      editor.off("blur", off);
    };
  }, [open, editor]);
  const cur = current(editor);
  return (
    <span className="note-fmt-anchor">
      <button
        ref={btn}
        type="button"
        aria-label="Colour, font and size"
        title="Colour, font and size"
        aria-expanded={open}
        onMouseDown={stop}
        onClick={() => {
          // Above the bar when there's room, so the picker doesn't sit on the words being styled.
          setUp((btn.current?.getBoundingClientRect().top ?? 0) > 400);
          setOpen((o) => !o);
        }}
        className={cn("flex h-8 items-center gap-0.5 rounded-[7px] px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground", open && "bg-accent text-foreground")}
      >
        <span className="text-[14px] font-[650] leading-none" style={{ color: cur.color ? `var(--nc-${cur.color})` : undefined, background: cur.bg ? `var(--nc-${cur.bg}-bg)` : undefined, padding: "1px 2px", borderRadius: 3 }}>Aa</span>
        <ChevronDown className="size-3" />
      </button>
      {open && (
        <div className={cn("note-fmt-wrap", up ? "is-up" : "is-down")}>
          <Swatches editor={editor} />
        </div>
      )}
    </span>
  );
}

const ALIGNS = [
  { id: "left", label: "Align left", Icon: AlignLeft },
  { id: "center", label: "Centre", Icon: AlignCenter },
  { id: "right", label: "Align right", Icon: AlignRight },
  { id: "justify", label: "Justify", Icon: AlignJustify },
] as const;

/** The alignment of the block the selection starts in. */
function alignOf(editor: Editor): string {
  return String(editor.getAttributes("paragraph").textAlign ?? editor.getAttributes("heading").textAlign ?? "left");
}

export function AlignButton({ editor }: { editor: Editor }) {
  useTick(editor);
  const now = alignOf(editor);
  const at = Math.max(0, ALIGNS.findIndex((a) => a.id === now));
  const A = ALIGNS[at];
  const next = ALIGNS[(at + 1) % ALIGNS.length];
  return (
    <button type="button" aria-label={`${A.label} · click for ${next.label.toLowerCase()}`} title={`${A.label} · click for ${next.label.toLowerCase()}`} onMouseDown={stop} onClick={() => editor.chain().focus().setTextAlign(next.id).run()} className="flex size-8 items-center justify-center rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground">
      <A.Icon className="size-4" />
    </button>
  );
}

// ---------------------------------------------------------------- the block menu

type PMNode = NonNullable<ReturnType<Editor["state"]["doc"]["nodeAt"]>>;
const TURN_INTO: { id: string; label: string; glyph: string; run(e: Editor): void; on(n: PMNode): boolean }[] = [
  { id: "p", label: "Text", glyph: "¶", run: (e) => e.chain().focus().setParagraph().run(), on: (n) => n.type.name === "paragraph" },
  { id: "h1", label: "Heading 1", glyph: "H1", run: (e) => e.chain().focus().setHeading({ level: 1 }).run(), on: (n) => n.type.name === "heading" && n.attrs.level === 1 },
  { id: "h2", label: "Heading 2", glyph: "H2", run: (e) => e.chain().focus().setHeading({ level: 2 }).run(), on: (n) => n.type.name === "heading" && n.attrs.level === 2 },
  { id: "h3", label: "Heading 3", glyph: "H3", run: (e) => e.chain().focus().setHeading({ level: 3 }).run(), on: (n) => n.type.name === "heading" && n.attrs.level === 3 },
  { id: "ul", label: "Bulleted list", glyph: "•", run: (e) => e.chain().focus().toggleBulletList().run(), on: (n) => n.type.name === "bulletList" },
  { id: "ol", label: "Numbered list", glyph: "1.", run: (e) => e.chain().focus().toggleOrderedList().run(), on: (n) => n.type.name === "orderedList" },
  { id: "todo", label: "To-do list", glyph: "☐", run: (e) => e.chain().focus().toggleTaskList().run(), on: (n) => n.type.name === "taskList" },
  { id: "quote", label: "Quote", glyph: "❝", run: (e) => e.chain().focus().toggleBlockquote().run(), on: (n) => n.type.name === "blockquote" },
  { id: "code", label: "Code", glyph: "</>", run: (e) => e.chain().focus().toggleCodeBlock().run(), on: (n) => n.type.name === "codeBlock" },
];

/** Puts the cursor inside the block at `pos` (text blocks) so the turn-into commands act on it. */
function selectInside(editor: Editor, pos: number) {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return;
  if (node.isTextblock) editor.commands.setTextSelection({ from: pos + 1, to: pos + node.nodeSize - 1 });
  else {
    // A list or a quote: select its first text line.
    let inner = -1;
    node.descendants((n, p) => {
      if (inner < 0 && n.isTextblock) inner = pos + 1 + p;
      return inner < 0;
    });
    if (inner >= 0) {
      const t = editor.state.doc.nodeAt(inner)!;
      editor.commands.setTextSelection({ from: inner + 1, to: inner + t.nodeSize - 1 });
    }
  }
}

export function BlockMenu({ editor }: { editor: Editor }) {
  const [at, setAt] = useState<{ pos: number; x: number; y: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (ev: Event) => {
      const d = (ev as CustomEvent<BlockMenuDetail>).detail;
      if (d.view !== editor.view) return;
      setAt({ pos: d.pos, x: d.rect.left, y: d.rect.bottom + 6 });
    };
    window.addEventListener(BLOCK_MENU_EVENT, h);
    return () => window.removeEventListener(BLOCK_MENU_EVENT, h);
  }, [editor]);
  useEffect(() => {
    if (!at) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as globalThis.Node) && setAt(null);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setAt(null);
      editor.commands.focus();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [at, editor]);
  // Keep it on screen.
  useEffect(() => {
    const el = box.current;
    if (!el || !at) return;
    const r = el.getBoundingClientRect();
    if (r.bottom > innerHeight - 8) el.style.top = `${Math.max(8, innerHeight - 8 - r.height)}px`;
  }, [at]);
  if (!at) return null;
  const node = editor.state.doc.nodeAt(at.pos);
  if (!node) return null;
  const textish = (node.isTextblock && node.type.name !== "codeBlock") || ["bulletList", "orderedList", "taskList", "blockquote"].includes(node.type.name);
  const inColumns = editor.state.doc.resolve(at.pos).parent.type.name === "column";
  const done = () => setAt(null);
  const run = (f: () => void) => () => {
    f();
    done();
  };
  const item = (label: string, Icon: React.ComponentType<{ className?: string }>, f: () => void, danger = false) => (
    <button type="button" onMouseDown={stop} onClick={run(f)} className={cn("note-bm-item", danger && "is-danger")}>
      <Icon className="size-4" /> {label}
    </button>
  );
  return createPortal(
    <div ref={box} className="note-bm" style={{ left: at.x, top: at.y }} role="menu" aria-label="Block options">
      {textish && (
        <>
          <div className="note-fmt-head">Turn into</div>
          <div className="note-bm-grid">
            {TURN_INTO.map((t) => {
              const on = t.on(node);
              return (
                <button key={t.id} type="button" title={t.label} aria-pressed={on} onMouseDown={stop} onClick={run(() => (selectInside(editor, at.pos), on ? undefined : t.run(editor)))} className={cn("note-bm-turn", on && "is-on")}>
                  <span className="note-bm-glyph">{t.glyph}</span>
                  <span className="truncate">{t.label}</span>
                </button>
              );
            })}
          </div>
          <div className="note-fmt-head">Colour</div>
          <div className="note-swatches">
            <button type="button" title="Default" aria-label="Default colour" onMouseDown={stop} onClick={run(() => (selectInside(editor, at.pos), editor.chain().focus().setTextColor(null).setHighlightColor(null).run()))} className="note-swatch">
              <span className="note-swatch-a">A</span>
            </button>
            {COLORS.map((c) => (
              <button key={c.id} type="button" title={c.label} aria-label={`${c.label} text`} onMouseDown={stop} onClick={run(() => (selectInside(editor, at.pos), editor.chain().focus().setTextColor(c.id).run()))} className="note-swatch">
                <span className="note-swatch-a" style={{ color: `var(--nc-${c.id})` }}>A</span>
              </button>
            ))}
          </div>
          <div className="note-fmt-head">Highlight</div>
          <div className="note-swatches">
            <button type="button" title="No highlight" aria-label="No highlight" onMouseDown={stop} onClick={run(() => (selectInside(editor, at.pos), editor.chain().focus().setHighlightColor(null).run()))} className="note-swatch">
              <span className="note-swatch-bg is-none" />
            </button>
            {COLORS.map((c) => (
              <button key={c.id} type="button" title={`${c.label} highlight`} aria-label={`${c.label} highlight`} onMouseDown={stop} onClick={run(() => (selectInside(editor, at.pos), editor.chain().focus().setHighlightColor(c.id).run()))} className="note-swatch">
                <span className="note-swatch-bg" style={{ background: `var(--nc-${c.id}-bg)` }} />
              </button>
            ))}
          </div>
          {node.isTextblock && (
            <>
            <div className="note-fmt-head">Align</div>
            <div className="note-bm-aligns">
              {ALIGNS.map((a) => (
                <button key={a.id} type="button" title={a.label} aria-label={a.label} aria-pressed={(node.attrs.textAlign ?? "left") === a.id} onMouseDown={stop} onClick={run(() => (selectInside(editor, at.pos), editor.chain().focus().setTextAlign(a.id).run()))} className={cn("note-bm-align", (node.attrs.textAlign ?? "left") === a.id && "is-on")}>
                  <a.Icon className="size-4" />
                </button>
              ))}
            </div>
            </>
          )}
          <div className="note-bm-sep" />
        </>
      )}
      {!inColumns && node.type.name !== "columns" &&
        item("Put in two columns", Columns2, () => {
          const tr = editor.state.tr;
          const s = editor.state.schema;
          const empty = s.nodes.column.create(null, s.nodes.paragraph.create());
          tr.replaceWith(at.pos, at.pos + node.nodeSize, s.nodes.columns.create(null, [s.nodes.column.create(null, node), empty]));
          editor.view.dispatch(tr);
          editor.commands.focus();
        })}
      {item("Duplicate", Copy, () => {
        const tr = editor.state.tr.insert(at.pos + node.nodeSize, node.copy(node.content));
        tr.setSelection(NodeSelection.create(tr.doc, at.pos + node.nodeSize));
        editor.view.dispatch(tr);
        editor.commands.focus();
      })}
      {item(
        "Delete",
        Trash2,
        () => {
          const tr = editor.state.tr.delete(at.pos, at.pos + node.nodeSize);
          const p = Math.min(at.pos, tr.doc.content.size);
          try {
            tr.setSelection(TextSelection.near(tr.doc.resolve(p)));
          } catch {}
          editor.view.dispatch(tr);
          editor.commands.focus();
        },
        true,
      )}
    </div>,
    document.body,
  );
}
