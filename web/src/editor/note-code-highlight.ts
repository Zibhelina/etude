// Syntax colours inside the note editor's code blocks: ProseMirror decorations made from the same
// lezer highlighter the rest of the app uses (tok-* classes). Languages load on demand; when one
// arrives the blocks using it are coloured on the next pass.
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { classHighlighter, highlightCode } from "@lezer/highlight";
import type { LanguageSupport } from "@codemirror/language";
import { loadLanguage } from "./highlight";

const key = new PluginKey<DecorationSet>("noteCodeHighlight");
const ready = new Map<string, LanguageSupport | null>();

function decorate(doc: PMNode, request: (lang: string) => void): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "codeBlock") return;
    const lang = String(node.attrs.language ?? "").toLowerCase();
    if (!lang) return false;
    if (!ready.has(lang)) {
      request(lang);
      return false;
    }
    const support = ready.get(lang);
    if (!support) return false;
    const code = node.textContent;
    let at = pos + 1;
    highlightCode(
      code,
      support.language.parser.parse(code),
      classHighlighter,
      (text, classes) => {
        if (classes && text) decos.push(Decoration.inline(at, at + text.length, { class: classes }));
        at += text.length;
      },
      () => {
        at += 1;
      },
    );
    return false;
  });
  return DecorationSet.create(doc, decos);
}

export const NoteCodeHighlight = Extension.create({
  name: "noteCodeHighlight",
  addProseMirrorPlugins() {
    let view: { dispatch: (tr: any) => void; state: any } | null = null;
    const pending = new Set<string>();
    const request = (lang: string) => {
      if (pending.has(lang)) return;
      pending.add(lang);
      void loadLanguage(lang).then((s) => {
        ready.set(lang, s);
        if (view) view.dispatch(view.state.tr.setMeta(key, "lang"));
      });
    };
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_, state) => decorate(state.doc, request),
          apply(tr, old) {
            if (!tr.docChanged && !tr.getMeta(key)) return old;
            return decorate(tr.doc, request);
          },
        },
        view(v) {
          view = v as any;
          return { destroy: () => void (view = null) };
        },
        props: { decorations: (state) => key.getState(state) },
      }),
    ];
  },
});
