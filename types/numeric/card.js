// Long questions step down from the big serif so they stay readable.
{
  const q = etude.root.firstElementChild;
  const n = q?.textContent.length ?? 0;
  if (q && (n > 260 || q.querySelector("pre, ul, ol, table, .katex-display, h1, h2, h3"))) q.classList.add("q-long");
  else if (q && n > 110) q.classList.add("q-mid");
}
const box = etude.$(".parts");
const multi = etude.view.parts.length > 1;
box.classList.toggle("multi", multi);
box.innerHTML = etude.view.parts.map((p, i) => `
  <label class="part">
    ${p.label ? `<span class="part-label prose">${etude.mdInline(p.label)}</span>` : multi ? `<span class="part-label">Part ${i + 1}</span>` : ""}
    <span class="e-row part-input only-answer">
      <input class="e-input mono" data-part="${i}" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="${multi ? "" : "Your answer"}" ${i === 0 ? "data-autofocus" : ""}>
      ${p.unit ? `<span class="e-unit">${etude.escape(p.unit)}</span>` : ""}
    </span>
    <span class="part-res only-result"><span class="ex-yours"></span><span class="ex-big expected"></span></span>
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
  const marks = grade?.details?.parts ?? [];
  inputs.forEach((el, i) => {
    el.disabled = true;
    const ok = !!marks[i]?.correct;
    el.classList.add(ok ? "is-correct" : "is-wrong");
    const part = el.closest(".part");
    const k = key?.parts?.[i] ?? {};
    const unit = k.unit ? ` ${etude.escape(k.unit)}` : "";
    const given = String(el.value ?? "").trim();
    // What you wrote, struck through when it's wrong; then the expected value, big.
    part.querySelector(".ex-yours").innerHTML = given ? `You wrote <b class="${ok ? "ok" : "no"}">${etude.escape(given)}${/[a-zµμ%]/i.test(given) ? "" : unit}</b>` : document.body.dataset.preview ? "" : "You left it blank";
    part.querySelector(".ex-big").innerHTML = k.answer == null ? "" : `${etude.escape(std_fmt(k.answer))}${unit ? `<small>${unit}</small>` : ""}`;
  });
});
function std_fmt(x) {
  if (typeof x !== "number") return String(x);
  if (x !== 0 && (Math.abs(x) >= 1e6 || Math.abs(x) < 1e-3)) return x.toExponential(4).replace(/\.?0+e/, "e");
  return String(Number(x.toPrecision(6)));
}
