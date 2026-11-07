// Equations in notes, rendered with the app's KaTeX: inline ($x^2$) and block ($$ on its own line).
// Typing $…$ makes an inline equation; $$ then Enter, or "/" → Equation, makes a block. Clicking an
// equation opens its LaTeX with a live preview; Enter (Shift+Enter in a block) or clicking away closes it.
import { InputRule, Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useEffect, useMemo, useRef, useState } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import { cn } from "@/lib/utils";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    noteMath: {
      insertInlineMath: (latex?: string) => ReturnType;
      insertBlockMath: (latex?: string) => ReturnType;
    };
  }
}

function render(latex: string, display: boolean): { html: string; error: string | null } {
  try {
    return { html: katex.renderToString(latex || "\\square", { displayMode: display, throwOnError: true, strict: "ignore", trust: false, maxSize: 50, maxExpand: 500 }), error: null };
  } catch (e) {
    return { html: katex.renderToString(latex || "\\square", { displayMode: display, throwOnError: false, strict: "ignore", trust: false }), error: (e as Error).message.replace(/^KaTeX parse error: /, "") };
  }
}

function MathView({ node, updateAttributes, selected, editor, getPos, deleteNode }: NodeViewProps) {
  const block = node.type.name === "mathBlock";
  const latex = String(node.attrs.latex ?? "");
  const [editing, setEditing] = useState(!latex);
  const [draft, setDraft] = useState(latex);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setDraft(latex), [latex]);
  useEffect(() => {
    if (editing) requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(box.current.value.length, box.current.value.length);
    });
  }, [editing]);
  const shown = useMemo(() => render(editing ? draft : latex, block), [editing, draft, latex, block]);
  const done = (move: "after" | "stay" = "after") => {
    if (!draft.trim()) {
      deleteNode();
      editor.commands.focus();
      return;
    }
    updateAttributes({ latex: draft });
    setEditing(false);
    if (move === "after" && typeof getPos === "function") {
      const pos = getPos();
      if (typeof pos === "number") editor.chain().focus().setTextSelection(pos + node.nodeSize).run();
    }
  };
  return (
    <NodeViewWrapper as={block ? "div" : "span"} className={cn(block ? "note-math-block" : "note-math-inline", (selected || editing) && "is-on")} data-latex={latex}>
      <span
        className={cn("note-math-out", shown.error && editing && "has-error")}
        contentEditable={false}
        onMouseDown={(e) => {
          e.preventDefault();
          setEditing(true);
        }}
        dangerouslySetInnerHTML={{ __html: shown.html }}
      />
      {editing && (
        <span className="note-math-edit" contentEditable={false}>
          <textarea
            ref={box}
            value={draft}
            rows={block ? Math.min(8, Math.max(2, draft.split("\n").length)) : 1}
            spellCheck={false}
            placeholder={block ? "\\int_0^1 x^2 \\, dx" : "x^2"}
            aria-label="LaTeX"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => done("stay")}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape" || (e.key === "Enter" && (!block || !e.shiftKey) && !(block && e.altKey))) {
                if (block && e.key === "Enter" && e.shiftKey) return;
                e.preventDefault();
                done();
              }
            }}
          />
          <span className="note-math-hint">{shown.error ? <span className="text-[var(--danger)]">{shown.error}</span> : block ? "Enter to finish · Shift+Enter new line" : "Enter to finish"}</span>
        </span>
      )}
    </NodeViewWrapper>
  );
}

const common = {
  atom: true,
  selectable: true,
  addAttributes() {
    return { latex: { default: "" } };
  },
  addNodeView() {
    return ReactNodeViewRenderer(MathView);
  },
};

export const MathInline = Node.create({
  ...common,
  name: "mathInline",
  group: "inline",
  inline: true,
  parseHTML: () => [{ tag: "span[data-math-inline]", getAttrs: (el) => ({ latex: (el as HTMLElement).dataset.latex ?? "" }) }],
  renderHTML: ({ node, HTMLAttributes }) => ["span", mergeAttributes(HTMLAttributes, { "data-math-inline": "", "data-latex": node.attrs.latex }), `$${node.attrs.latex}$`],
  renderText: ({ node }) => `$${node.attrs.latex}$`,
  addCommands() {
    return { insertInlineMath: (latex = "") => ({ commands }) => commands.insertContent({ type: "mathInline", attrs: { latex } }) };
  },
  addInputRules() {
    // $x^2$ → an equation. Not $$, and not a price like "$5 and $6".
    return [
      new InputRule({
        find: /(?<![$\w])\$([^$\s][^$]*?[^$\s]|[^$\s])\$$/,
        handler: ({ state, range, match }) => {
          state.tr.replaceWith(range.from, range.to, this.type.create({ latex: match[1] }));
        },
      }),
    ];
  },
});

export const MathBlock = Node.create({
  ...common,
  name: "mathBlock",
  group: "block",
  parseHTML: () => [{ tag: "div[data-math-block]", getAttrs: (el) => ({ latex: (el as HTMLElement).dataset.latex ?? "" }) }],
  renderHTML: ({ node, HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-math-block": "", "data-latex": node.attrs.latex }), `$$${node.attrs.latex}$$`],
  renderText: ({ node }) => `$$${node.attrs.latex}$$`,
  addCommands() {
    return { insertBlockMath: (latex = "") => ({ commands }) => commands.insertContent({ type: "mathBlock", attrs: { latex } }) };
  },
  addInputRules() {
    return [
      new InputRule({
        find: /^\$\$\s$/,
        handler: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          state.tr.replaceWith($from.before(), $from.after(), this.type.create({ latex: "" }));
        },
      }),
    ];
  },
});
