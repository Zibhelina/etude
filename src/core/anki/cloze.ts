// Anki cloze markers in the built-in cloze syntax: "{{c1::answer::hint}}" becomes "{{answer::hint}}".

export interface ClozeConvertOptions {
  /** An answer of words joined by "/" ("in/into") accepts each word or the whole: "{{in|into|in/into}}". */
  slashAlternatives?: boolean;
}

const OPEN = /\{\{c\s*\d+\s*::/;
const SLASHED = /^[\p{L}\p{M}\p{N}_'’]+(?:\/[\p{L}\p{M}\p{N}_'’]+)+$/u;

// Read the way Anki reads them: markers nest, and the first "::" at the marker's own level starts the hint.
function walk(src: string, render: (answer: string, hint: string) => string): { text: string; blanks: number } {
  let out = "", i = 0, blanks = 0;
  for (;;) {
    const m = OPEN.exec(src.slice(i));
    if (!m) return { text: out + src.slice(i), blanks };
    const start = i + m.index, from = start + m[0].length;
    let j = from, depth = 1, end = -1, sep = -1;
    while (j < src.length) {
      if (src.startsWith("{{", j)) { depth++; j += 2; continue; }
      if (src.startsWith("}}", j)) { if (--depth === 0) { end = j; break; } j += 2; continue; }
      if (depth === 1 && sep < 0 && src.startsWith("::", j)) { sep = j; j += 2; continue; }
      j++;
    }
    if (end < 0) return { text: out + src.slice(i), blanks };
    // The built-in syntax doesn't nest: a marker inside an answer becomes its answer's text.
    const answer = walk(src.slice(from, sep >= 0 ? sep : end), (a) => a).text;
    out += src.slice(i, start) + render(answer, sep >= 0 ? src.slice(sep + 2, end) : "");
    blanks++;
    i = end + 2;
  }
}

/** Every cloze of the note becomes a blank of the one card the built-in type makes. The rest of the text is left as it is. */
export function ankiClozeToBuiltin(text: string, opts: ClozeConvertOptions = {}): { text: string; blanks: number } {
  return walk(text, (answer, hint) => {
    const bare = answer.trim();
    const ans = opts.slashAlternatives && SLASHED.test(bare) ? [...bare.split("/"), bare].join("|") : answer;
    // A hint is kept even when it repeats the answer: it is often the form to change (a word to decline or conjugate).
    return hint.trim() ? `{{${ans}::${hint}}}` : `{{${ans}}}`;
  });
}
