const box = etude.$(".parts");
const multi = etude.view.parts.length > 1;
box.innerHTML = etude.view.parts.map((p, i) => `
  <label class="part">
    ${p.label ? `<span class="part-label prose">${etude.mdInline(p.label)}</span>` : multi ? `<span class="part-label">Part ${i + 1}</span>` : ""}
    <span class="e-row part-input">
      <input class="e-input mono" data-part="${i}" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="${multi ? "" : "Your answer"}" ${i === 0 ? "autofocus" : ""}>
      ${p.unit ? `<span class="e-unit">${etude.escape(p.unit)}</span>` : ""}
    </span>
    <span class="expected only-result"></span>
  </label>`).join("");
const inputs = etude.$$("input[data-part]");
if (Array.isArray(etude.answer)) inputs.forEach((el, i) => (el.value = etude.answer[i] ?? ""));
etude.getAnswer(() => inputs.map((el) => el.value));
inputs.forEach((el, i) => el.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  if (i < inputs.length - 1) inputs[i + 1].focus();
  else etude.submit();
}));
etude.onResult(({ grade, key }) => {
  const marks = grade.details?.parts ?? [];
  inputs.forEach((el, i) => {
    el.disabled = true;
    el.classList.add(marks[i]?.correct ? "is-correct" : "is-wrong");
    const exp = el.closest(".part").querySelector(".expected");
    const k = key.parts[i];
    exp.innerHTML = marks[i]?.correct
      ? ""
      : `Expected <code>${etude.escape(std_fmt(k.answer))}</code>${k.unit ? " " + etude.escape(k.unit) : ""}`;
  });
});
function std_fmt(x) {
  if (typeof x !== "number") return String(x);
  if (x !== 0 && (Math.abs(x) >= 1e6 || Math.abs(x) < 1e-3)) return x.toExponential(4).replace(/\.?0+e/, "e");
  return String(Number(x.toPrecision(6)));
}
