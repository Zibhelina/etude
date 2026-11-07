// Callouts: a tinted box with an icon for a note, a tip, a warning or something important. Click the icon to
// change the kind. "/" → Callout, or "> [!tip]" from Obsidian when importing.
import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";

export const CALLOUTS = [
  { kind: "note", icon: "💡", label: "Note" },
  { kind: "tip", icon: "✅", label: "Tip" },
  { kind: "warning", icon: "⚠️", label: "Warning" },
  { kind: "danger", icon: "❗", label: "Important" },
  { kind: "question", icon: "❓", label: "Question" },
] as const;

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    noteCallout: { setCallout: (kind?: string) => ReturnType };
  }
}

function CalloutView({ node, updateAttributes }: NodeViewProps) {
  const kind = String(node.attrs.kind ?? "note");
  const at = Math.max(0, CALLOUTS.findIndex((c) => c.kind === kind));
  const c = CALLOUTS[at];
  return (
    <NodeViewWrapper className="note-callout" data-kind={c.kind}>
      <button
        type="button"
        contentEditable={false}
        className="note-callout-icon"
        title={`${c.label} · click to change`}
        aria-label={`${c.label} callout, change kind`}
        onMouseDown={(e) => {
          e.preventDefault();
          updateAttributes({ kind: CALLOUTS[(at + 1) % CALLOUTS.length].kind });
        }}
      >
        {c.icon}
      </button>
      <NodeViewContent className="note-callout-body" />
    </NodeViewWrapper>
  );
}

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return { kind: { default: "note" } };
  },
  parseHTML: () => [{ tag: "div[data-callout]", getAttrs: (el) => ({ kind: (el as HTMLElement).dataset.callout || "note" }) }],
  renderHTML: ({ node, HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-callout": node.attrs.kind }), 0],
  addNodeView() {
    return ReactNodeViewRenderer(CalloutView);
  },
  addCommands() {
    return {
      setCallout:
        (kind = "note") =>
        ({ commands }) =>
          commands.wrapIn(this.name, { kind }),
    };
  },
  addKeyboardShortcuts() {
    return {
      // Backspace at the start of an empty callout takes the box away and keeps the line.
      Backspace: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.parentOffset !== 0) return false;
        for (let d = $from.depth; d > 0; d--) {
          if ($from.node(d).type.name === this.name) {
            if ($from.index(d) !== 0) return false;
            return editor.commands.lift(this.name);
          }
        }
        return false;
      },
    };
  },
});
