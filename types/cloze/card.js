const { view } = etude;
// Render the markdown with placeholders, then swap each placeholder for an input.
// Placeholders inside math are rendered as \text{} boxes by KaTeX, so replace them before rendering math.
const marker = (i) => `ETUDEBLANK${i}X`;
let html = etude.md(view.text.replace(/⟦(\d+)⟧/g, (_, i) => marker(i)));
html = html.replace(/ETUDEBLANK(\d+)X/g, (_, i) => {
  const b = view.blanks[i];
  return `<span class="blank"><input class="e-input mono" data-i="${i}" size="${Math.min(Math.max(b.size + 1, 3), 40)}" autocomplete="off" spellcheck="false" placeholder="${etude.escape(b.hint)}"><span class="fix only-result"></span></span>`;
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
