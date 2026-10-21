// Syntax highlighting for any language CodeMirror knows (about 140), loaded on demand. Used for
// code blocks in rendered markdown, read-only listings and the code editors, inside card frames
// and in the app. Output uses `tok-*` classes; the stylesheet maps them to theme colors.
import { LanguageDescription, type LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { classHighlighter, highlightCode } from "@lezer/highlight";

const ALIASES: Record<string, string> = {
  py: "python", js: "javascript", ts: "typescript", sh: "shell", bash: "shell", zsh: "shell", console: "shell",
  "c++": "cpp", cc: "cpp", h: "c", hpp: "cpp", rs: "rust", rb: "ruby", kt: "kotlin", cs: "c#", csharp: "c#",
  md: "markdown", yml: "yaml", tex: "latex", plaintext: "", text: "", txt: "", asm: "gas", golang: "go",
};

const loaded = new Map<string, Promise<LanguageSupport | null>>();

export function findLanguage(name: string): LanguageDescription | null {
  const key = String(name ?? "").trim().toLowerCase();
  const n = ALIASES[key] ?? key;
  if (!n) return null;
  return LanguageDescription.matchLanguageName(languages, n, true) ?? LanguageDescription.matchFilename(languages, `x.${n}`);
}

export function loadLanguage(name: string): Promise<LanguageSupport | null> {
  const key = String(name ?? "").trim().toLowerCase();
  let p = loaded.get(key);
  if (!p) {
    const desc = findLanguage(key);
    p = desc ? desc.load().catch(() => null) : Promise.resolve(null);
    loaded.set(key, p);
  }
  return p;
}

/** The display name for a language id ("py" → "Python"), or the id itself when unknown. */
export function languageName(name: string): string {
  return findLanguage(name)?.name ?? name;
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));

/** Highlighted HTML for `code` (no surrounding <pre>). Unknown languages come back escaped. */
export async function highlight(code: string, language: string): Promise<string> {
  const support = await loadLanguage(language);
  if (!support) return esc(code);
  const tree = support.language.parser.parse(code);
  let html = "";
  highlightCode(
    code,
    tree,
    classHighlighter,
    (text, classes) => {
      html += classes ? `<span class="${classes}">${esc(text)}</span>` : esc(text);
    },
    () => {
      html += "\n";
    },
  );
  return html;
}

/** Highlights every `pre > code.language-*` under `root` that hasn't been highlighted yet. */
export async function highlightBlocks(root: ParentNode): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>("pre > code[class*='language-']:not([data-hl])")];
  await Promise.all(
    blocks.map(async (el) => {
      el.dataset.hl = "1";
      const lang = /language-([\w#+.-]+)/.exec(el.className)?.[1] ?? "";
      const html = await highlight(el.textContent ?? "", lang);
      el.innerHTML = html;
      const name = languageName(lang);
      if (name && el.parentElement && !el.parentElement.dataset.lang) el.parentElement.dataset.lang = name;
    }),
  );
}
