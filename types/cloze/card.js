const { view } = etude;
// Encode blank index using letters only (A..Z) so KaTeX keeps \text{ETUDEBLANK...X} in one literal text node
// instead of splitting digits and letters into separate spans.
const encodeIdx = (i) => {
  let n = Number(i), s = "";
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
};
const decodeIdx = (s) => {
  let n = 0;
  for (let k = 0; k < s.length; k++) n = n * 26 + (s.charCodeAt(k) - 64);
  return n - 1;
};
const marker = (i) => `ETUDEBLANK${encodeIdx(i)}X`;
const CODE_RE = /(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(\n\2[ \t]*(?=\n|$)|$)|(?<!`)(`+)(?!`)[^\n]*?(?<!`)\4(?!`)/g;
const MATH_RE = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(?<![\\$\w])\$(?!\s)(?:\\.|[^$\n\\])+?(?<!\s)\$(?!\d))/g;
// Wrap placeholders inside LaTeX math in {\text{...}} so KaTeX renders them as a single literal span.
const codeStash = [];
const prepared = view.text
  .replace(CODE_RE, (m) => `\u0002${codeStash.push(m) - 1}\u0002`)
  .replace(MATH_RE, (m) => m.replace(/⟦(\d+)⟧/g, (_, i) => `{\\text{${marker(i)}}}`))
  .replace(/\u0002(\d+)\u0002/g, (_, i) => codeStash[Number(i)])
  .replace(/⟦(\d+)⟧/g, (_, i) => marker(i));
let html = etude.md(prepared);
html = html.replace(/ETUDEBLANK([A-Z]+)X/g, (_, letters) => {
  const i = decodeIdx(letters);
  const b = view.blanks[i];
  if (!b) return "";
  // Wide enough for the answer or the hint, in the field's proportional font.
  const size = Math.min(40, Math.max(3, Math.ceil(b.size * 0.75), b.hint ? Math.ceil(b.hint.length * 0.8) : 0));
  return `<span class="blank"><input class="e-input mono" data-i="${i}" size="${size}" autocomplete="off" spellcheck="false" placeholder="${etude.escape(b.hint)}"><span class="fix only-result"></span></span>`;
});
const box = etude.$(".cloze");
box.innerHTML = html;
// A sentence gets the big serif; a paragraph or a list steps down so it stays readable.
const len = box.textContent.length + view.blanks.length * 6;
if (len > 420 || box.querySelector("ul, ol, pre, table, h1, h2, h3")) box.classList.add("long");
else if (len > 170) box.classList.add("mid");
const inputs = etude.$$("input[data-i]");
if (Array.isArray(etude.answer)) inputs.forEach((el, i) => (el.value = etude.answer[i] ?? ""));
inputs[0]?.setAttribute("autofocus", "");
etude.getAnswer(() => inputs.map((el) => el.value));
inputs.forEach((el, i) => el.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  if (i < inputs.length - 1) inputs[i + 1].focus(); else etude.submit();
}));
etude.onResult(({ grade, key }) => {
  const marks = grade?.details?.marks ?? [];
  inputs.forEach((el, i) => {
    el.disabled = true;
    el.classList.add(marks[i] ? "is-correct" : "is-wrong");
    // The blank becomes text in the sentence: green when right, your word struck in red beside the answer when not.
    const v = el.value.trim();
    const fix = el.nextElementSibling;
    fix.className = `fix only-result czr ${marks[i] ? "ok" : "no"}`;
    fix.innerHTML = marks[i]
      ? etude.escape(v)
      : `${v ? `<s>${etude.escape(v)}</s>` : ""}<b>${etude.escape(key?.answers?.[i]?.[0] ?? "")}</b>`;
  });
});
