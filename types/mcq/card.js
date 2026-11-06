// Long questions step down from the big serif so they stay readable.
{
  const q = etude.root.firstElementChild;
  const n = q?.textContent.length ?? 0;
  if (q && (n > 260 || q.querySelector("pre, ul, ol, table, .katex-display, h1, h2, h3"))) q.classList.add("q-long");
  else if (q && n > 110) q.classList.add("q-mid");
}
const { view } = etude;
const box = etude.$(".options");
if (/select all|all that apply|choose all/i.test(view.prompt ?? "")) etude.$(".hint").textContent = "";
// Letters label the options (A, B, C…); the number keys still pick them too. Past nine options keep the old 1–9, a–h labels.
const many = view.options.length > 9;
const labels = many ? "123456789abcdefgh" : "ABCDEFGHI";
const keyIndex = (k) => {
  if (many) return "123456789abcdefgh".indexOf(k);
  const n = "123456789".indexOf(k);
  return n >= 0 ? n : "abcdefghi".indexOf(k);
};
box.innerHTML = view.options.map((o, i) => `
  <button type="button" class="e-option" data-id="${o.id}" aria-pressed="false">
    <span class="e-key">${labels[i] ?? ""}</span>
    <span class="body"><span class="prose">${etude.md(o.text)}</span><span class="e-why only-result"></span></span>
  </button>`).join("");
const buttons = etude.$$(".e-option");
const selected = new Set(Array.isArray(etude.answer) ? etude.answer : []);
const paint = () => buttons.forEach((b) => b.setAttribute("aria-pressed", String(selected.has(b.dataset.id))));
const toggle = (id) => {
  if (etude.mode !== "answer") return;
  if (view.multiple) selected.has(id) ? selected.delete(id) : selected.add(id);
  else { selected.clear(); selected.add(id); }
  paint();
  etude.setReady(selected.size > 0);
};
buttons.forEach((b) => b.addEventListener("click", () => {
  toggle(b.dataset.id);
  if (!view.multiple) etude.submit();
}));
window.addEventListener("keydown", (e) => {
  if (etude.mode !== "answer" || e.ctrlKey || e.metaKey || e.altKey) return;
  const i = keyIndex(e.key.toLowerCase());
  if (i >= 0 && i < buttons.length) { e.preventDefault(); toggle(buttons[i].dataset.id); if (!view.multiple) etude.submit(); }
  if (e.key === "Enter" && view.multiple && selected.size) { e.preventDefault(); etude.submit(); }
});
paint();
etude.setReady(selected.size > 0);
etude.getAnswer(() => [...selected]);
etude.onResult(({ key }) => {
  const right = new Set(key.correct);
  buttons.forEach((b) => {
    const id = b.dataset.id;
    b.disabled = true;
    if (right.has(id) && selected.has(id)) b.classList.add("is-correct");
    else if (right.has(id)) b.classList.add(view.multiple && selected.size ? "is-missed" : "is-correct");
    else if (selected.has(id)) b.classList.add("is-wrong");
    else b.classList.add("dim");
    const why = key.why[id];
    if (why && (right.has(id) || selected.has(id))) b.querySelector(".e-why").innerHTML = etude.md(why);
  });
});
