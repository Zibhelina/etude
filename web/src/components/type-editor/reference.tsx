// A short, collapsible cheat sheet for template authors. The full reference is docs/types.md.
import { useState } from "react";
import { BookOpen, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

const ROWS: { section: string; items: [string, string][] }[] = [
  {
    section: "Template HTML",
    items: [
      ["{{field}}", "the value, HTML-escaped"],
      ["{{md:field}}", "markdown with KaTeX math, as a block"],
      ["{{mdi:field}}", "markdown, inline (no <p>)"],
      ["{{#field}}…{{/field}}", "kept only when the field is set and non-empty"],
      ['<template data-on="result">', "rendered after grading; the key is merged into the data"],
      [".only-answer / .only-result", "hidden in result / answer mode"],
    ],
  },
  {
    section: "Card script (etude)",
    items: [
      ["etude.view", "what prepare put in view (or the non-private fields)"],
      ["etude.mode", '"answer", "result" or "preview"'],
      ["etude.getAnswer(fn)", "how to read the answer when Submit is pressed"],
      ["etude.submit(value?)", "submit now"],
      ["etude.setReady(bool)", "enable or disable the Submit button"],
      ["etude.onResult(fn)", "called with { grade, key, answer }"],
      ["etude.$(sel) / $$(sel)", "query inside the card"],
      ["etude.md(s) / mdInline(s)", "render markdown and math"],
      ["etude.escape(s) / html`…`", "escape text; tagged template that escapes values"],
    ],
  },
  {
    section: "Scripts on the server",
    items: [
      ["prepare(fields, face, rng)", "returns { view, key }; view reaches the card"],
      ["grade(answer, view, key, fields)", "returns { score 0..1, details?, feedback? }"],
      ["std.normalize / looseEqual", "case and whitespace insensitive compare"],
      ["std.parseNumber / within", '"1/8", "3e-3"; relative tolerance check'],
      ["rng.int / float / pick / shuffle", "seeded, so a variant can be replayed"],
    ],
  },
];

export function TemplateReference({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn("rounded-lg border", className)}>
      <button className="flex min-h-10 w-full items-center gap-2 px-3 text-left text-sm text-muted-foreground hover:text-foreground" onClick={() => setOpen(!open)} aria-expanded={open}>
        <BookOpen className="size-4" />
        <span className="flex-1">Template and runtime reference</span>
        <ChevronRight className={cn("size-4 transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="flex flex-col gap-4 border-t px-3 py-4 text-[13px]">
          {ROWS.map((s) => (
            <div key={s.section} className="flex flex-col gap-1.5">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{s.section}</div>
              {s.items.map(([code, text]) => (
                <div key={code} className="grid gap-0.5 sm:grid-cols-[minmax(0,16rem)_1fr] sm:gap-3">
                  <code className="break-words font-mono text-[12px] text-foreground">{code}</code>
                  <span className="text-muted-foreground">{text}</span>
                </div>
              ))}
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            Cards can use the theme variables (<code className="font-mono">--foreground</code>, <code className="font-mono">--highlight</code>, <code className="font-mono">--success</code>…) and ready-made classes like <code className="font-mono">.prose</code>, <code className="font-mono">.e-input</code>, <code className="font-mono">.e-option</code>, <code className="font-mono">.e-reveal</code>. The full reference is <code className="font-mono">docs/types.md</code> in the repository.
          </p>
        </div>
      )}
    </div>
  );
}
