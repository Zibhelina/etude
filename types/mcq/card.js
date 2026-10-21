const { view } = etude;
const box = etude.$(".options");
const keys = "123456789abcdefgh";
box.innerHTML = view.options.map((o, i) => `
  <button type="button" class="e-option" data-id="${o.id}" aria-pressed="false">
    <span class="e-key">${keys[i] ?? ""}</span>
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
  const i = keys.indexOf(e.key.toLowerCase());
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
    else if (right.has(id)) b.classList.add("is-missed");
    else if (selected.has(id)) b.classList.add("is-wrong");
    else b.classList.add("dim");
    const why = key.why[id];
    if (why && (right.has(id) || selected.has(id))) b.querySelector(".e-why").innerHTML = etude.md(why);
  });
});
