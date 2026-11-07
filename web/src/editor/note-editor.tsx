// The note editor (beta): Tiptap (ProseMirror) with markdown shortcuts as you type (# heading, - list,
// [] to-do, > quote, ``` code, --- divider, **bold**, *italic*, `code`), the "/" menu, a bubble bar for a
// selection and code blocks coloured by language. The document is ProseMirror JSON, which is what's stored.
import { useEffect, useRef, useState } from "react";
import { EditorContent, NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type Editor, type NodeViewProps } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import CodeBlock from "@tiptap/extension-code-block";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Placeholder from "@tiptap/extension-placeholder";
import Image from "@tiptap/extension-image";
import { NoteLink, type NoteLinkOptions } from "./note-link";
import { MathBlock, MathInline } from "./note-math";
import { Callout } from "./note-callout";
import { CardMark, NoteCards } from "./note-cards";
import { NoteCard } from "./note-card";
import { CanvasEmbed } from "./note-canvas";
import { TableKit } from "@tiptap/extension-table";
import { Details, DetailsContent, DetailsSummary } from "@tiptap/extension-details";
import FileHandler from "@tiptap/extension-file-handler";
import { api } from "@/lib/api";
import { toast } from "sonner";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/avif"];

/** Stores pasted or dropped pictures in the collection's media and puts them in the page. */
async function insertImages(editor: Editor, files: File[], pos?: number) {
  for (const f of files) {
    try {
      const m = await api.uploadMedia(f);
      const node = { type: "image", attrs: { src: m.url, alt: f.name.replace(/\.[^.]+$/, "") } };
      if (pos === undefined) editor.chain().focus().insertContent(node).run();
      else editor.chain().focus().insertContentAt(pos, node).run();
    } catch (e) {
      toast.error(`Couldn't add ${f.name}: ${(e as Error).message}`);
    }
  }
}
import { Bold, Code, Italic, Link2, Strikethrough, Underline } from "lucide-react";
import { NoteCodeHighlight } from "./note-code-highlight";
import { NoteStyle } from "./note-style";
import { BlockHandle } from "./note-handle";
import { AlignButton, BlockMenu, StyleButton } from "./note-format";
import { TableControls } from "./note-table-ui";
import { SlashCommand } from "./slash-menu";
import { languageName } from "./highlight";
import type { NoteDoc } from "@/lib/api";
import { cn } from "@/lib/utils";

/** A code block with its language shown in the corner; click it to change. */
function CodeBlockView({ node, updateAttributes }: NodeViewProps) {
  const [edit, setEdit] = useState(false);
  const lang = String(node.attrs.language ?? "");
  return (
    <NodeViewWrapper as="div" className="note-code">
      <div className="note-code-lang" contentEditable={false}>
        {edit ? (
          <input
            autoFocus
            defaultValue={lang}
            placeholder="language"
            aria-label="Code language"
            onBlur={(e) => {
              updateAttributes({ language: e.currentTarget.value.trim().toLowerCase() || null });
              setEdit(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Escape") {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
          />
        ) : (
          <button type="button" onClick={() => setEdit(true)}>{lang ? languageName(lang) : "Plain text"}</button>
        )}
      </div>
      <pre>
        <NodeViewContent<"code"> as="code" />
      </pre>
    </NodeViewWrapper>
  );
}

const CodeBlockWithLang = CodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },
}).configure({ defaultLanguage: null, enableTabIndentation: true, tabSize: 2 } as any);

function Bubble({ editor, page }: { editor: Editor; page?: { id: string; title: string } }) {
  const btn = (on: boolean, label: string, run: () => void, Icon: typeof Bold) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={on}
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
      className={cn("flex size-8 items-center justify-center rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground", on && "bg-accent text-foreground")}
    >
      <Icon className="size-4" />
    </button>
  );
  return (
    <BubbleMenu
      editor={editor}
      shouldShow={({ editor: e, from, to }) => from !== to && !e.isActive("codeBlock") && !("node" in e.state.selection)}
      className="note-bubble"
    >
      {btn(editor.isActive("bold"), "Bold (Ctrl+B)", () => editor.chain().focus().toggleBold().run(), Bold)}
      {btn(editor.isActive("italic"), "Italic (Ctrl+I)", () => editor.chain().focus().toggleItalic().run(), Italic)}
      {btn(editor.isActive("underline"), "Underline (Ctrl+U)", () => editor.chain().focus().toggleUnderline().run(), Underline)}
      {btn(editor.isActive("strike"), "Strikethrough", () => editor.chain().focus().toggleStrike().run(), Strikethrough)}
      {btn(editor.isActive("code"), "Inline code (Ctrl+E)", () => editor.chain().focus().toggleCode().run(), Code)}
      {btn(editor.isActive("link"), "Link", () => {
        if (editor.isActive("link")) return void editor.chain().focus().unsetLink().run();
        const href = window.prompt("Link to", "https://");
        if (href && href !== "https://") editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
      }, Link2)}
      <span className="mx-0.5 my-1.5 w-px bg-border" aria-hidden />
      <StyleButton editor={editor} />
      <AlignButton editor={editor} />
    </BubbleMenu>
  );
}

/** Over a row of columns you're in: add or remove a column, or back to one. */
function ColumnsBar({ editor }: { editor: Editor }) {
  const b = (label: string, run: () => boolean) => (
    <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={run} className="h-8 rounded-[7px] px-2 text-[12.5px] text-muted-foreground hover:bg-accent hover:text-foreground">
      {label}
    </button>
  );
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="columnsBar"
      shouldShow={({ editor: e }) => e.isActive("columns") && e.state.selection.empty}
      options={{ placement: "top" }}
      getReferencedVirtualElement={() => {
        const { $from } = editor.state.selection;
        for (let d = $from.depth; d > 0; d--) {
          if ($from.node(d).type.name === "columns") {
            const el = editor.view.nodeDOM($from.before(d)) as HTMLElement | null;
            if (el) return { getBoundingClientRect: () => el.getBoundingClientRect(), getClientRects: () => el.getClientRects() } as any;
          }
        }
        return null;
      }}
      className="note-bubble"
    >
      {b("+ Column", () => editor.chain().focus().addColumn().run())}
      {b("− Column", () => editor.chain().focus().removeColumn().run())}
      {b("One column", () => editor.chain().focus().unwrapColumns().run())}
    </BubbleMenu>
  );
}

export interface NoteEditorHandle {
  focusStart(): void;
  /** The cursor at the end, on a new line when the page ends in a block you can't type after. */
  focusEnd(): void;
}

function focusEnd(editor: Editor) {
  // Like Notion: the cursor goes to an empty line at the end, made when the last block has something in it.
  // Focus at once (Tiptap's focus command waits a frame, and the first key typed would be lost).
  const end = editor.state.doc.lastChild;
  if (!end || end.type.name !== "paragraph" || end.content.size > 0) editor.commands.insertContentAt(editor.state.doc.content.size, { type: "paragraph" });
  editor.view.focus();
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  editor.commands.scrollIntoView();
}

export function NoteEditor({ doc, onChange, editorRef, onEscapeUp, links, page }: {
  doc: NoteDoc;
  /** The page being edited, for making cards from it. */
  page?: { id: string; title: string };
  /** Where [[links]] find, make and open pages. */
  links: NoteLinkOptions;
  onChange(doc: NoteDoc): void;
  editorRef?: React.MutableRefObject<NoteEditorHandle | null>;
  /** ArrowUp at the very start of the page: back to the title. */
  onEscapeUp?(): void;
}) {
  const change = useRef(onChange);
  change.current = onChange;
  const pageRef = useRef(page);
  pageRef.current = page;
  const linkRef = useRef(links);
  linkRef.current = links;
  const up = useRef(onEscapeUp);
  up.current = onEscapeUp;
  const editor = useEditor({
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        codeBlock: false,
        link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" } },
      }),
      CodeBlockWithLang,
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({
        includeChildren: false,
        placeholder: ({ node }) => (node.type.name === "heading" ? `Heading ${node.attrs.level}` : node.type.name === "detailsSummary" ? "Toggle" : node.type.name === "paragraph" ? "Write, or type / for blocks" : ""),
      }),
      NoteCodeHighlight,
      ...NoteStyle,
      BlockHandle,
      SlashCommand,
      MathInline,
      MathBlock,
      NoteCards,
      CardMark,
      NoteCard.configure({ page: () => pageRef.current ?? null }),
      CanvasEmbed.configure({ page: () => pageRef.current ?? null }),
      Callout,
      TableKit.configure({ table: { resizable: true, cellMinWidth: 80 } }),
      Details.configure({ persist: true, HTMLAttributes: { class: "note-toggle" } }),
      // Enter on a toggle's title opens it and goes into its content, like Notion.
      DetailsSummary.extend({
        addKeyboardShortcuts() {
          return {
            Enter: ({ editor: e }) => {
              const { $from } = e.state.selection;
              if ($from.parent.type.name !== "detailsSummary") return false;
              const details = $from.node($from.depth - 1);
              const at = $from.before($from.depth - 1);
              const contentPos = at + 1 + $from.parent.nodeSize;
              const content = details.child(1);
              if (!details.attrs.open) e.commands.command(({ tr }) => (tr.setNodeMarkup(at, undefined, { ...details.attrs, open: true }), true));
              const dom = e.view.nodeDOM(at) as HTMLElement | null;
              dom?.classList.add("is-open");
              if (content.firstChild?.type.name === "paragraph" && content.firstChild.content.size === 0) return e.commands.setTextSelection(contentPos + 2);
              return e.chain().insertContentAt(contentPos + 1, { type: "paragraph" }).setTextSelection(contentPos + 2).run();
            },
          };
        },
      }),
      DetailsContent,
      FileHandler.configure({
        allowedMimeTypes: IMAGE_TYPES,
        onPaste: (e: Editor, files: File[]) => void insertImages(e, files),
        onDrop: (e: Editor, files: File[], pos: number) => void insertImages(e, files, pos),
      }),
      // Only images in the collection's media or on the web, never data: or javascript: URLs.
      Image.extend({ addAttributes() { return { ...this.parent?.(), src: { default: null, parseHTML: (el: HTMLElement) => { const s = el.getAttribute("src") ?? ""; return /^(\/media\/files\/|https:\/\/)/.test(s) ? s : null; } } }; } }).configure({ inline: false }),
      NoteLink.configure({
        pages: (q: string) => linkRef.current.pages(q),
        create: (t: string) => linkRef.current.create(t),
        open: (id: string) => linkRef.current.open(id),
        titleOf: (id: string) => linkRef.current.titleOf(id),
      }),
    ],
    content: doc as any,
    editorProps: {
      attributes: { class: "note-prose", "aria-label": "Page", spellcheck: "true" },
      handleKeyDown(view, e) {
        // A selected canvas block is never replaced by typing: only Delete/Backspace/arrows/Enter act on it.
        const sel = view.state.selection as any;
        if (sel.node?.type?.name === "canvasEmbed" && e.key.length === 1 && !e.ctrlKey && !e.metaKey) return true;
        // A key pressed while drawing in an embedded canvas is the board's, never the page's.
        if ((e.target as HTMLElement | null)?.closest?.(".note-canvas-board") || document.activeElement?.closest?.(".note-canvas-board")) return true;
        if (e.key === "ArrowUp" && view.state.selection.from <= 1 && up.current) {
          up.current();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: e }) => change.current(e.getJSON() as NoteDoc),
  });
  // "/" → Image picks files outside the editor; they come back here.
  useEffect(() => {
    const h = (ev: Event) => editor && void insertImages(editor, (ev as CustomEvent<File[]>).detail);
    window.addEventListener("etude:note-images", h);
    return () => window.removeEventListener("etude:note-images", h);
  }, [editor]);
  useEffect(() => {
    if (!editorRef) return;
    // Focus at once (Tiptap's focus command waits a frame, and keys typed right after Enter in the title would land there).
    editorRef.current = {
      focusStart: () => {
        if (!editor) return;
        editor.view.focus();
        editor.commands.setTextSelection(1);
      },
      focusEnd: () => editor && focusEnd(editor),
    };
    return () => void (editorRef.current = null);
  }, [editor, editorRef]);
  if (!editor) return null;
  return (
    <>
      <Bubble editor={editor} page={page} />
      <TableControls editor={editor} />
      <ColumnsBar editor={editor} />
      <BlockMenu editor={editor} />
      <EditorContent
        editor={editor}
        className="note-editor"
        onMouseDown={(e) => {
          // A click in the empty space under the last block puts the cursor at the end (a new line when the
          // page ends in something you can't type after, like code or a picture), the way Notion does.
          const prose = editor.view.dom as HTMLElement;
          const last = prose.lastElementChild as HTMLElement | null;
          if (e.target !== prose && e.target !== e.currentTarget) return;
          if (last && e.clientY < last.getBoundingClientRect().bottom) return;
          e.preventDefault();
          focusEnd(editor);
        }}
      />
    </>
  );
}
