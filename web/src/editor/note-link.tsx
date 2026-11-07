// [[Page links]]: an inline node that points at another page by id and keeps the title it was written with,
// so a link to a page that doesn't exist yet resolves once a page gets that name. Typing [[ opens a page
// picker (filter by typing, Enter picks, or makes a new page with that title). Clicking a link opens it.
import { NoteIcon } from "./note-icon";
import { Node, mergeAttributes, type Editor, type Range } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import Suggestion, { type SuggestionProps } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import { createRoot, type Root } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface PageRef {
  id: string;
  title: string;
  icon: string | null;
  /** Where it sits ("CMPT 307 › Week 1"). */
  path: string;
}

export interface NoteLinkOptions {
  /** Pages to offer for a query (filtered and ranked). */
  pages(query: string): PageRef[];
  /** Makes a page with this title and returns it. */
  create(title: string): Promise<PageRef>;
  /** Opens a page. */
  open(id: string): void;
  /** The current title of a page, so links follow renames. */
  titleOf(id: string): string | null;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    noteLink: { insertNoteLink: (attrs: { id: string | null; title: string; label?: string | null }) => ReturnType };
  }
}

function LinkView({ node, extension }: NodeViewProps) {
  const opts = extension.options as NoteLinkOptions;
  const id = node.attrs.id as string | null;
  const current = id ? opts.titleOf(id) : null;
  const label = (node.attrs.label as string | null) || current || (node.attrs.title as string);
  const missing = !id || current === null;
  return (
    <NodeViewWrapper as="span" className={cn("note-link", missing && "is-missing")} data-note-link="" title={missing ? `No page called “${node.attrs.title}” yet: click to make it` : undefined}>
      <span
        role="link"
        tabIndex={-1}
        onMouseDown={(e) => {
          // A plain click follows the link; Alt/Shift-click puts the cursor there instead.
          if (e.button !== 0 || e.altKey || e.shiftKey) return;
          e.preventDefault();
          if (id && current !== null) opts.open(id);
          else void opts.create(String(node.attrs.title)).then((p) => opts.open(p.id));
        }}
      >
        {label}
      </span>
    </NodeViewWrapper>
  );
}

interface PickerHandle {
  key(e: KeyboardEvent): boolean;
}
type Row = { kind: "page"; page: PageRef } | { kind: "new"; title: string };

function Picker({ rows, query, onPick, handle }: { rows: Row[]; query: string; onPick(r: Row): void; handle: React.MutableRefObject<PickerHandle | null> }) {
  const [at, setAt] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => setAt(0), [rows]);
  useEffect(() => list.current?.querySelector<HTMLElement>(`[data-i="${at}"]`)?.scrollIntoView({ block: "nearest" }), [at]);
  handle.current = {
    key(e) {
      if (!rows.length) return false;
      if (e.key === "ArrowDown") return setAt((a) => (a + 1) % rows.length), true;
      if (e.key === "ArrowUp") return setAt((a) => (a - 1 + rows.length) % rows.length), true;
      if (e.key === "Enter" || e.key === "Tab") return onPick(rows[at] ?? rows[0]), true;
      return false;
    },
  };
  return (
    <div ref={list} role="listbox" aria-label="Link to a page" className="note-slash">
      <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-[650] tracking-wide text-muted-foreground uppercase">{query ? "Link to" : "Recent pages"}</div>
      {!rows.length && <div className="px-2.5 py-2 text-[13px] text-muted-foreground">Type a page's name</div>}
      {rows.map((r, i) => (
        <button
          key={r.kind === "page" ? r.page.id : "new"}
          data-i={i}
          role="option"
          aria-selected={i === at}
          onMouseMove={() => setAt(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(r);
          }}
          className={cn("flex w-full items-center gap-2.5 rounded-[8px] px-2 py-1.5 text-left", i === at && "bg-accent")}
        >
          {r.kind === "page" ? (
            <>
              <span className="flex w-5 shrink-0 justify-center" aria-hidden><NoteIcon icon={r.page.icon} size={18} /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px]">{r.page.title || "Untitled"}</span>
                {r.page.path && <span className="block truncate text-[12px] text-muted-foreground">{r.page.path}</span>}
              </span>
            </>
          ) : (
            <>
              <span className="w-5 shrink-0 text-center text-muted-foreground" aria-hidden>+</span>
              <span className="min-w-0 flex-1 truncate text-[14px]">New page “{r.title}”</span>
            </>
          )}
        </button>
      ))}
    </div>
  );
}

export const NoteLink = Node.create<NoteLinkOptions>({
  name: "noteLink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addOptions() {
    return { pages: () => [], create: async (t) => ({ id: "", title: t, icon: null, path: "" }), open: () => {}, titleOf: () => null };
  },
  addAttributes() {
    return {
      id: { default: null },
      title: { default: "" },
      label: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: "a[data-note-link]", getAttrs: (el) => ({ id: (el as HTMLElement).dataset.id || null, title: (el as HTMLElement).dataset.title ?? (el as HTMLElement).textContent ?? "" }) }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["a", mergeAttributes(HTMLAttributes, { "data-note-link": "", "data-id": node.attrs.id ?? "", "data-title": node.attrs.title }), node.attrs.label || node.attrs.title];
  },
  renderText({ node }) {
    return `[[${node.attrs.title}]]`;
  },
  addNodeView() {
    return ReactNodeViewRenderer(LinkView, { as: "span" });
  },
  addCommands() {
    return {
      insertNoteLink:
        (attrs) =>
        ({ chain }) =>
          chain().insertContent([{ type: this.name, attrs }, { type: "text", text: " " }]).run(),
    };
  },
  addProseMirrorPlugins() {
    const opts = this.options;
    return [
      Suggestion<Row, Row>({
        editor: this.editor,
        pluginKey: new PluginKey("noteLinkSuggest"),
        char: "[[",
        allowSpaces: true,
        allowedPrefixes: null,
        allow: ({ state, range }: any) => !state.doc.resolve(range.from).parent.type.spec.code,
        items: ({ query }: { query: string }) => {
          const q = query.replace(/\]+$/, "").trim();
          const pages = opts.pages(q).slice(0, 8);
          const rows: Row[] = pages.map((page) => ({ kind: "page", page }));
          if (q && !pages.some((p) => p.title.toLowerCase() === q.toLowerCase())) rows.push({ kind: "new", title: q });
          return rows;
        },
        command: ({ editor, range, props }: { editor: Editor; range: Range; props: Row }) => {
          // Swallow a "]]" the person may have typed already.
          const after = editor.state.doc.textBetween(range.to, Math.min(range.to + 2, editor.state.doc.content.size));
          const r = after === "]]" ? { from: range.from, to: range.to + 2 } : range;
          if (props.kind === "page") editor.chain().focus().deleteRange(r).insertNoteLink({ id: props.page.id, title: props.page.title }).run();
          else {
            editor.chain().focus().deleteRange(r).insertNoteLink({ id: null, title: props.title }).run();
            void opts.create(props.title).then((p) => {
              // Point the link we just wrote at the new page.
              const { state } = editor;
              let tr = state.tr;
              state.doc.descendants((n, pos) => {
                if (n.type.name === "noteLink" && !n.attrs.id && n.attrs.title === props.title) tr = tr.setNodeMarkup(pos, undefined, { ...n.attrs, id: p.id });
              });
              editor.view.dispatch(tr);
            });
          }
        },
        render: () => {
          let host: HTMLDivElement | null = null;
          let root: Root | null = null;
          const handle: { current: PickerHandle | null } = { current: null };
          let props: SuggestionProps<Row, Row> | null = null;
          const place = () => {
            const r = props?.clientRect?.();
            if (!host || !r) return;
            const h = host.offsetHeight || 300;
            const below = r.bottom + 6 + h < window.innerHeight;
            host.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - host.offsetWidth - 8))}px`;
            host.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - h - 6)}px`;
          };
          const draw = () => props && root?.render(<Picker rows={props.items} query={props.query} onPick={(r) => props!.command(r)} handle={handle as any} />);
          return {
            onStart(p: SuggestionProps<Row, Row>) {
              props = p;
              host = document.createElement("div");
              host.className = "note-slash-host";
              document.body.appendChild(host);
              root = createRoot(host);
              draw();
              requestAnimationFrame(place);
            },
            onUpdate(p: SuggestionProps<Row, Row>) {
              props = p;
              draw();
              requestAnimationFrame(place);
            },
            onKeyDown({ event }: { event: KeyboardEvent }) {
              if (event.key === "Escape") {
                host?.remove();
                return true;
              }
              return handle.current?.key(event) ?? false;
            },
            onExit() {
              const r = root;
              root = null;
              setTimeout(() => r?.unmount());
              host?.remove();
              host = null;
            },
          };
        },
      } as any),
    ];
  },
});
