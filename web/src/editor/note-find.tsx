// Find and replace in a page: Ctrl/⌘+F finds, Ctrl+H (⌘+Shift+H on a Mac) opens it with Replace. Matches are
// decorations, so nothing in the page changes until you replace; Replace all is one undo step.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { ArrowDown, ArrowUp, CaseSensitive, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";

type Hit = { from: number; to: number };
type FindState = { query: string; caseSensitive: boolean; hits: Hit[]; index: number; deco: DecorationSet };
/** What a transaction asks of the search. `at`: the current match becomes the first one starting there or after. */
type FindMeta = { query?: string; caseSensitive?: boolean; index?: number; at?: number };

const key = new PluginKey<FindState>("noteFind");
const MAX_HITS = 5000;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every match of `query` in the page's text, block by block (a match never crosses from one block into another). */
function search(doc: PMNode, query: string, caseSensitive: boolean): Hit[] {
  if (!query) return [];
  const re = new RegExp(escape(query), caseSensitive ? "gu" : "giu");
  const hits: Hit[] = [];
  doc.descendants((node, pos) => {
    if (hits.length >= MAX_HITS) return false;
    if (!node.isTextblock) return true;
    // The block's text, with a stand-in for each inline thing that isn't text (math, a mention), and where each character is.
    let text = "";
    const at: number[] = [];
    node.forEach((child, off) => {
      const start = pos + 1 + off;
      if (child.isText) {
        for (let i = 0; i < child.text!.length; i++) at.push(start + i);
        text += child.text;
      } else {
        at.push(start);
        text += "￼";
      }
    });
    for (let m = re.exec(text); m && hits.length < MAX_HITS; m = re.exec(text)) {
      if (!m[0].length) { re.lastIndex++; continue; }
      hits.push({ from: at[m.index], to: at[m.index + m[0].length - 1] + 1 });
    }
    re.lastIndex = 0;
    return false;
  });
  return hits;
}

const firstFrom = (hits: Hit[], pos: number) => {
  const i = hits.findIndex((h) => h.from >= pos);
  return i < 0 ? 0 : i;
};

function decorate(doc: PMNode, hits: Hit[], index: number) {
  return DecorationSet.create(doc, hits.map((h, i) => Decoration.inline(h.from, h.to, { class: i === index ? "note-find-hit is-current" : "note-find-hit" })));
}

export const NoteFind = Extension.create({
  name: "noteFind",
  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key,
        state: {
          init: () => ({ query: "", caseSensitive: false, hits: [], index: 0, deco: DecorationSet.empty }),
          apply(tr, prev) {
            const meta = tr.getMeta(key) as FindMeta | undefined;
            if (!meta && (!tr.docChanged || !prev.query)) return prev;
            const query = meta?.query ?? prev.query;
            const caseSensitive = meta?.caseSensitive ?? prev.caseSensitive;
            const hits = meta?.query !== undefined || meta?.caseSensitive !== undefined || tr.docChanged ? search(tr.doc, query, caseSensitive) : prev.hits;
            let index: number;
            if (meta?.index !== undefined) index = ((meta.index % (hits.length || 1)) + (hits.length || 1)) % (hits.length || 1);
            else if (meta?.at !== undefined) index = firstFrom(hits, meta.at);
            // Typing a new search: the first match from the cursor on.
            else if (meta?.query !== undefined || meta?.caseSensitive !== undefined) index = firstFrom(hits, tr.selection.from);
            // The page changed (typed, or edited elsewhere): the current match stays the one it was, or the next.
            else index = prev.hits[prev.index] ? firstFrom(hits, tr.mapping.map(prev.hits[prev.index].from, -1)) : 0;
            return { query, caseSensitive, hits, index, deco: query ? decorate(tr.doc, hits, index) : DecorationSet.empty };
          },
        },
        props: { decorations: (state) => key.getState(state)?.deco },
      }),
    ];
  },
});

const findState = (s: EditorState) => key.getState(s)!;
const setFind = (editor: Editor, meta: FindMeta) => editor.view.dispatch(editor.state.tr.setMeta(key, meta).setMeta("addToHistory", false));

/** The match swapped for `text`, keeping the formatting its first letter had. */
function replaceHit(editor: Editor, tr: import("@tiptap/pm/state").Transaction, h: Hit, text: string) {
  if (!text) return tr.delete(h.from, h.to);
  const marks = tr.doc.nodeAt(h.from)?.marks ?? [];
  return tr.replaceWith(h.from, h.to, editor.schema.text(text, marks));
}

/** Which find a key asks for: Ctrl/⌘+F finds, Ctrl+H or Ctrl/⌘+Shift+H (⌘+H hides the app on a Mac) also replaces. */
export function findShortcut(e: KeyboardEvent): "find" | "replace" | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const k = e.code === "KeyF" ? "f" : e.code === "KeyH" ? "h" : e.key.toLowerCase();
  if (k === "f" && !e.shiftKey) return "find";
  if (k === "h" && (e.shiftKey || !/Mac|iPhone|iPad/.test(navigator.platform))) return "replace";
  return null;
}

/** The bar at the top right of the page. `mode` says what it opened with; a new `ask` opens it again (focus, select). */
export function FindBar({ editor, dock, mode, ask, onClose }: {
  editor: Editor;
  dock: HTMLElement;
  mode: "find" | "replace";
  ask: number;
  onClose(): void;
}) {
  const [query, setQuery] = useState(() => findState(editor.state).query || lastQuery);
  const [replacing, setReplacing] = useState(mode === "replace");
  const [replacement, setReplacement] = useState(lastReplacement);
  const [, tick] = useState(0);
  const findInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const editable = editor.isEditable;
  const s = findState(editor.state);
  // The field to put the cursor in once it's on screen (before the next key, so none lands in the page).
  const want = useRef<"find" | "replace" | null>(null);
  useLayoutEffect(() => {
    const input = want.current === "replace" ? replaceInput.current : want.current === "find" ? findInput.current : null;
    if (!input) return;
    want.current = null;
    input.focus();
    input.select();
  });

  // Each ask: the selection (one line of it) becomes the search, and the field is ready to type over.
  useLayoutEffect(() => {
    const { from, to, empty } = editor.state.selection;
    const picked = empty ? "" : editor.state.doc.textBetween(from, to, "\n");
    const q = picked && !picked.includes("\n") && picked.length <= 200 ? picked : query;
    if (q !== query) setQuery(q);
    setFind(editor, { query: q, at: from });
    if (mode === "replace" && editable) setReplacing(true);
    want.current = mode === "replace" && editable && q ? "replace" : "find";
    tick((n) => n + 1);
    show();
  }, [ask]);
  useEffect(() => {
    const h = () => tick((n) => n + 1);
    editor.on("transaction", h);
    return () => void editor.off("transaction", h);
  }, [editor]);
  // Gone with the bar: the highlights.
  useEffect(() => () => void (!editor.isDestroyed && setFind(editor, { query: "" })), [editor]);
  useEffect(() => void (lastQuery = query), [query]);
  useEffect(() => void (lastReplacement = replacement), [replacement]);

  const show = () => requestAnimationFrame(() => editor.view.dom.querySelector(".note-find-hit.is-current")?.scrollIntoView({ block: "center" }));
  const go = (step: number) => {
    if (!s.hits.length) return;
    setFind(editor, { index: s.index + step });
    show();
  };
  const close = (select: boolean) => {
    const h = s.hits[s.index];
    onClose();
    if (select && h) editor.chain().setTextSelection(h).focus().run();
    else editor.commands.focus();
  };
  const replaceOne = () => {
    const h = s.hits[s.index];
    if (!h || !editable) return;
    editor.view.dispatch(replaceHit(editor, editor.state.tr, h, replacement).setMeta(key, { at: h.from + replacement.length }));
    show();
  };
  const replaceAll = () => {
    if (!s.hits.length || !editable) return;
    let tr = editor.state.tr;
    for (const h of [...s.hits].reverse()) tr = replaceHit(editor, tr, h, replacement);
    editor.view.dispatch(tr);
  };
  const keys = (e: React.KeyboardEvent, enter: () => void) => {
    if (e.key === "Escape") return void (e.preventDefault(), close(true));
    if (e.key === "Enter") return void (e.preventDefault(), enter());
    const which = findShortcut(e.nativeEvent);
    if (which) {
      e.preventDefault();
      e.stopPropagation();
      want.current = which === "replace" && editable ? "replace" : "find";
      if (want.current === "replace") setReplacing(true);
      tick((n) => n + 1);
    }
  };
  const count = !query ? "" : s.hits.length ? `${s.index + 1} of ${s.hits.length}${s.hits.length >= MAX_HITS ? "+" : ""}` : "No results";

  return createPortal(
    <div className="note-find" role="search" aria-label="Find in the page" onMouseDown={(e) => e.target instanceof HTMLInputElement || e.preventDefault()}>
      <div className="note-find-row">
        {editable ? (
          <button type="button" className="note-find-btn" aria-label={replacing ? "Hide replace" : "Show replace"} aria-expanded={replacing} onClick={() => setReplacing((r) => !r)}>
            <ChevronRight className={cn("size-3.5 transition-transform", replacing && "rotate-90")} />
          </button>
        ) : <span className="w-1" />}
        <input
          ref={findInput}
          className="note-find-input"
          placeholder="Find"
          aria-label="Find"
          value={query}
          spellCheck={false}
          onChange={(e) => (setQuery(e.target.value), setFind(editor, { query: e.target.value }), show())}
          onKeyDown={(e) => keys(e, () => go(e.shiftKey ? -1 : 1))}
        />
        <span className={cn("note-find-count", query && !s.hits.length && "is-none")} aria-live="polite">{count}</span>
        <button type="button" className={cn("note-find-btn", s.caseSensitive && "is-on")} aria-pressed={s.caseSensitive} aria-label="Match case" title="Match case" onClick={() => (setFind(editor, { caseSensitive: !s.caseSensitive }), show())}>
          <CaseSensitive className="size-4" />
        </button>
        <button type="button" className="note-find-btn" aria-label="Previous match" title="Previous (Shift+Enter)" disabled={!s.hits.length} onClick={() => go(-1)}><ArrowUp className="size-3.5" /></button>
        <button type="button" className="note-find-btn" aria-label="Next match" title="Next (Enter)" disabled={!s.hits.length} onClick={() => go(1)}><ArrowDown className="size-3.5" /></button>
        <button type="button" className="note-find-btn" aria-label="Close" title="Close (Esc)" onClick={() => close(false)}><X className="size-3.5" /></button>
      </div>
      {replacing && editable && (
        <div className="note-find-row">
          <span className="w-[26px] shrink-0" />
          <input
            ref={replaceInput}
            className="note-find-input"
            placeholder="Replace with"
            aria-label="Replace with"
            value={replacement}
            spellCheck={false}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => keys(e, () => ((e.ctrlKey || e.metaKey) && e.altKey ? replaceAll() : replaceOne()))}
          />
          <button type="button" className="note-find-text" disabled={!s.hits.length} title="Replace this one (Enter)" onClick={replaceOne}>Replace</button>
          <button type="button" className="note-find-text" disabled={!s.hits.length} title={`Replace all (${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘+⌥" : "Ctrl+Alt"}+Enter)`} onClick={replaceAll}>All</button>
        </div>
      )}
    </div>,
    dock,
  );
}

// The last search and replacement, for the next time the bar opens (any page).
let lastQuery = "";
let lastReplacement = "";
