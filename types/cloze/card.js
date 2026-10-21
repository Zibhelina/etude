const { view } = etude;
// Render the markdown with placeholders, then swap each placeholder for an input.
// Placeholders inside math are rendered as \text{} boxes by KaTeX, so replace them before rendering math.
const marker = (i) => `ETUDEBLANK${i}X`;
let html = etude.md(view.text.replace(/⟦(\d+)⟧/g, (_, i) => marker(i)));
html = html.replace(/ETUDEBLANK(\d+)X/g, (_, i) => {
  const b = view.blanks[i];
  return `<span class="blank"><input class="e-input mono" data-i="${i}" size="${Math.min(b.size + 2, 40)}" autocomplete="off" spellcheck="false" placeholder="${etude.escape(b.hint)}"><span class="fix only-result"></span></span>`;
});
etude.$(".cloze").innerHTML = html;
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
  const marks = grade.details?.marks ?? [];
  inputs.forEach((el, i) => {
    el.disabled = true;
    el.classList.add(marks[i] ? "is-correct" : "is-wrong");
    if (!marks[i]) el.nextElementSibling.textContent = key.answers[i][0];
  });
});
