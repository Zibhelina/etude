import { useEffect, useMemo, useRef } from "react";
import DOMPurify from "dompurify";
import { highlightBlocks } from "@/editor/highlight";
import "katex/dist/katex.min.css";
import { renderMarkdown as render } from "@/lib/render-markdown";
import { cn } from "@/lib/utils";
import { loadLocalMedia, parkLocalMedia } from "@/lib/local-url";

/** Markdown with KaTeX math, sanitized, for app-side text (feedback, previews). Card bodies render inside their own frame. */
export function renderMarkdown(text: string): string {
  return render(text, DOMPurify);
}

export function Markdown({ children, className }: { children: string; className?: string }) {
  const html = useMemo(() => parkLocalMedia(renderMarkdown(children ?? "")), [children]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    void highlightBlocks(ref.current);
    loadLocalMedia(ref.current);
  }, [html]);
  return <div ref={ref} className={cn("prose-etude", className)} dangerouslySetInnerHTML={{ __html: html }} />;
}
