// React wrappers for the editor kit: the live markdown editor for markdown fields and a code editor
// for any language. The same kit runs inside card frames, so authoring and answering look alike.
import { useEffect, useRef } from "react";
import katex from "katex";
import { createMarkdownEditor } from "@/editor/markdown-editor";
import { createCodeEditor } from "@/editor/code-editor";
import type { EditorHandle } from "@/editor/code-editor";
import { cn } from "@/lib/utils";

interface Common {
  value: string;
  onChange(v: string): void;
  placeholder?: string;
  className?: string;
  minLines?: number;
}

function useEditor(make: (el: HTMLElement, onChange: (v: string) => void) => EditorHandle, value: string, onChange: (v: string) => void, deps: unknown[]) {
  const host = useRef<HTMLDivElement>(null);
  const ed = useRef<EditorHandle | null>(null);
  const change = useRef(onChange);
  change.current = onChange;
  useEffect(() => {
    if (!host.current) return;
    const h = make(host.current, (v) => change.current(v));
    ed.current = h;
    return () => {
      h.destroy();
      ed.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  // Outside changes (switching items, reset) replace the document; our own edits already match.
  useEffect(() => {
    const h = ed.current;
    if (h && h.value() !== value) h.set(value);
  }, [value]);
  return host;
}

/** Markdown with live preview: math, code and formatting render in place, like Obsidian. */
export function LiveMarkdown({ value, onChange, placeholder, className, minLines = 2 }: Common) {
  const host = useEditor((el, change) => createMarkdownEditor(el, { value, katex, placeholder, minLines, onChange: change }), value, onChange, [placeholder, minLines]);
  return <div ref={host} className={cn("live-md e-editor bg-transparent", className)} />;
}

/** A code editor for any language CodeMirror knows (loaded on demand). */
export function AnyCodeEditor({ value, onChange, placeholder, className, minLines = 6, language }: Common & { language: string }) {
  const host = useEditor((el, change) => createCodeEditor(el, { value, language, placeholder, minLines, onChange: change }), value, onChange, [language, placeholder, minLines]);
  return <div ref={host} className={cn("e-editor", className)} />;
}
