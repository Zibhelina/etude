import { useMemo } from "react";
import { marked } from "marked";
import katex from "katex";
import "katex/dist/katex.min.css";
import { cn } from "@/lib/utils";

const MATH = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(?<![\\$\w])\$(?!\s)(?:\\.|[^$\n\\])+?(?<!\s)\$(?!\d))/g;

/** Markdown with KaTeX math, for app-side text (feedback, previews). Card bodies render inside their own frame. */
export function renderMarkdown(text: string): string {
  const stash: string[] = [];
  const src = text.replace(MATH, (m) => {
    const display = m.startsWith("$$") || m.startsWith("\\[");
    const body = m.startsWith("$$") || m.startsWith("\\[") || m.startsWith("\\(") ? m.slice(2, -2) : m.slice(1, -1);
    stash.push(katex.renderToString(body.trim(), { displayMode: display, throwOnError: false, strict: "ignore" }));
    return `\u0000${stash.length - 1}\u0000`;
  });
  const html = marked.parse(src, { gfm: true, async: false }) as string;
  // Feedback comes from a model: drop scripts and inline handlers before inserting.
  const clean = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/\son\w+="[^"]*"/gi, "").replace(/javascript:/gi, "");
  return clean.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
}

export function Markdown({ children, className }: { children: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(children ?? ""), [children]);
  return <div className={cn("prose-etude", className)} dangerouslySetInnerHTML={{ __html: html }} />;
}
