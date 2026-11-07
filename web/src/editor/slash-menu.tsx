// The "/" menu: type / at the start of a block (or after a space) and pick what the block becomes.
// Arrow keys move, Enter picks, Esc closes, typing filters.
import { Extension, type Editor, type Range } from "@tiptap/core";
import Suggestion, { type SuggestionProps } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import { createRoot, type Root } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
// The block commands below are declared by these extensions.
import type {} from "@tiptap/starter-kit";
import type {} from "@tiptap/extension-task-list";
import type {} from "@tiptap/extension-code-block";
import type {} from "@tiptap/extension-table";
import type {} from "@tiptap/extension-details";
import type {} from "./note-math";
import type {} from "./note-callout";
import type {} from "./note-cards";
import type {} from "./note-card";
import type {} from "./note-canvas";
import type {} from "./note-style";

export interface SlashItem {
  id: string;
  title: string;
  hint: string;
  glyph: string;
  keys: string[];
  shortcut?: string;
  run(editor: Editor, range: Range): void;
}

export const SLASH_ITEMS: SlashItem[] = [
  { id: "text", title: "Text", hint: "Plain paragraph", glyph: "¶", keys: ["paragraph", "p"], run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run() },
  { id: "h1", title: "Heading 1", hint: "Big section title", glyph: "H1", keys: ["title", "#"], shortcut: "#", run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 1 }).run() },
  { id: "h2", title: "Heading 2", hint: "Medium title", glyph: "H2", keys: ["subtitle", "##"], shortcut: "##", run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 2 }).run() },
  { id: "h3", title: "Heading 3", hint: "Small title", glyph: "H3", keys: ["###"], shortcut: "###", run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 3 }).run() },
  { id: "bullet", title: "Bulleted list", hint: "A simple list", glyph: "•", keys: ["ul", "list", "-"], shortcut: "-", run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run() },
  { id: "number", title: "Numbered list", hint: "1, 2, 3", glyph: "1.", keys: ["ol", "ordered", "1."], shortcut: "1.", run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run() },
  { id: "todo", title: "To-do list", hint: "Checkboxes", glyph: "☐", keys: ["task", "check", "checkbox", "[]"], shortcut: "[]", run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run() },
  { id: "quote", title: "Quote", hint: "Set a passage apart", glyph: "❝", keys: ["blockquote", ">"], shortcut: ">", run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
  { id: "code", title: "Code", hint: "Code with highlighting", glyph: "</>", keys: ["codeblock", "```", "snippet"], shortcut: "```", run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run() },
  { id: "create-card", title: "Create card", hint: "Write a card here and answer it in the page", glyph: "＋", keys: ["create-card", "new card", "card", "flashcard", "cloze", "question"], run: (e, r) => e.chain().focus().deleteRange(r).insertCard().run() },
  { id: "cards", title: "Study cards", hint: "A deck or a search, studied here", glyph: "🃏", keys: ["cards", "study", "deck", "review", "flashcards", "anki"], run: (e, r) => e.chain().focus().deleteRange(r).insertCards().run() },
  { id: "canvas", title: "Canvas", hint: "A whiteboard to draw on, like Excalidraw", glyph: "🎨", keys: ["canvas", "draw", "drawing", "whiteboard", "excalidraw", "sketch", "diagram", "board"], run: (e, r) => e.chain().focus().deleteRange(r).insertCanvasEmbed().run() },
  { id: "math", title: "Equation", hint: "A LaTeX block (or $x$ inline)", glyph: "∑", keys: ["math", "latex", "katex", "formula", "$$"], shortcut: "$$", run: (e, r) => e.chain().focus().deleteRange(r).insertBlockMath().run() },
  { id: "inlinemath", title: "Inline equation", hint: "LaTeX in the line", glyph: "x²", keys: ["inline", "math", "$"], shortcut: "$x$", run: (e, r) => e.chain().focus().deleteRange(r).insertInlineMath().run() },
  { id: "columns2", title: "2 columns", hint: "Blocks side by side", glyph: "▥", keys: ["columns", "side", "layout", "split", "two"], run: (e, r) => e.chain().focus().deleteRange(r).insertColumns(2).run() },
  { id: "columns3", title: "3 columns", hint: "Three blocks side by side", glyph: "⫼", keys: ["columns", "three", "layout"], run: (e, r) => e.chain().focus().deleteRange(r).insertColumns(3).run() },
  { id: "table", title: "Table", hint: "Rows and columns", glyph: "▦", keys: ["grid", "columns"], run: (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { id: "callout", title: "Callout", hint: "A box that stands out", glyph: "💡", keys: ["note", "tip", "warning", "info", "box"], run: (e, r) => e.chain().focus().deleteRange(r).setCallout().run() },
  { id: "toggle", title: "Toggle", hint: "Content that folds", glyph: "▸", keys: ["details", "collapse", "fold", "accordion"], run: (e, r) => e.chain().focus().deleteRange(r).setDetails().run() },
  { id: "image", title: "Image", hint: "Upload a picture", glyph: "🖼", keys: ["picture", "photo", "img"], run: (e, r) => {
      e.chain().focus().deleteRange(r).run();
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.multiple = true;
      input.onchange = () => input.files && window.dispatchEvent(new CustomEvent("etude:note-images", { detail: [...input.files] }));
      input.click();
    } },
  { id: "divider", title: "Divider", hint: "A line across", glyph: "—", keys: ["hr", "line", "---", "separator"], shortcut: "---", run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
];

export function filterSlash(query: string): SlashItem[] {
  const q = query.toLowerCase().trim();
  if (!q) return SLASH_ITEMS;
  return SLASH_ITEMS.filter((i) => i.title.toLowerCase().includes(q) || i.keys.some((k) => k.startsWith(q))).sort(
    (a, b) => Number(!a.title.toLowerCase().startsWith(q)) - Number(!b.title.toLowerCase().startsWith(q)),
  );
}

interface MenuHandle {
  key(e: KeyboardEvent): boolean;
}

function Menu({ items, onPick, handle }: { items: SlashItem[]; onPick(i: SlashItem): void; handle: React.MutableRefObject<MenuHandle | null> }) {
  const [at, setAt] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => setAt(0), [items]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at]);
  handle.current = {
    key(e) {
      if (!items.length) return false;
      if (e.key === "ArrowDown") return setAt((a) => (a + 1) % items.length), true;
      if (e.key === "ArrowUp") return setAt((a) => (a - 1 + items.length) % items.length), true;
      if (e.key === "Enter" || e.key === "Tab") return onPick(items[at] ?? items[0]), true;
      return false;
    },
  };
  if (!items.length) return <div className="note-slash px-3 py-2.5 text-[13px] text-muted-foreground">Nothing called that</div>;
  return (
    <div ref={list} role="listbox" aria-label="Turn into" className="note-slash">
      <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-[650] tracking-wide text-muted-foreground uppercase">Blocks</div>
      {items.map((it, i) => (
        <button
          key={it.id}
          data-i={i}
          role="option"
          aria-selected={i === at}
          onMouseMove={() => setAt(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(it);
          }}
          className={cn("flex w-full items-center gap-3 rounded-[8px] px-2 py-1.5 text-left", i === at && "bg-accent")}
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-[7px] border bg-background font-mono text-[12px] text-muted-foreground">{it.glyph}</span>
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] leading-tight">{it.title}</span>
            <span className="block truncate text-[12px] text-muted-foreground">{it.hint}</span>
          </span>
          {it.shortcut && <kbd className="text-muted-foreground opacity-70">{it.shortcut}</kbd>}
        </button>
      ))}
    </div>
  );
}

export const SlashCommand = Extension.create({
  name: "slashCommand",
  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        pluginKey: new PluginKey("slashCommand"),
        char: "/",
        allowedPrefixes: [" "],
        // Not inside code, where / is just a character.
        allow: ({ state, range }: any) => !state.doc.resolve(range.from).parent.type.spec.code,
        items: ({ query }: { query: string }) => filterSlash(query),
        command: ({ editor, range, props }: { editor: Editor; range: Range; props: SlashItem }) => props.run(editor, range),
        render: () => {
          let host: HTMLDivElement | null = null;
          let root: Root | null = null;
          const handle: { current: MenuHandle | null } = { current: null };
          let props: SuggestionProps<SlashItem, SlashItem> | null = null;
          const place = () => {
            const r = props?.clientRect?.();
            if (!host || !r) return;
            const h = host.offsetHeight || 300;
            const below = r.bottom + 6 + h < window.innerHeight;
            host.style.left = `${Math.min(r.left, window.innerWidth - host.offsetWidth - 8)}px`;
            host.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - h - 6)}px`;
          };
          const draw = () => props && root?.render(<Menu items={props.items} onPick={(i) => props!.command(i)} handle={handle as any} />);
          return {
            onStart(p: SuggestionProps<SlashItem, SlashItem>) {
              props = p;
              host = document.createElement("div");
              host.className = "note-slash-host";
              document.body.appendChild(host);
              root = createRoot(host);
              draw();
              requestAnimationFrame(place);
            },
            onUpdate(p: SuggestionProps<SlashItem, SlashItem>) {
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
