const host = etude.$(".code-host");
const language = String(etude.view.language || "");
const initial = etude.answer != null ? String(etude.answer) : String(etude.view.starter ?? "");
let editor = null;
let text = initial;
const ready = () => etude.setReady(text.trim().length > 0 && text.trim() !== String(etude.view.starter ?? "").trim());
etude.getAnswer(() => (editor ? editor.value() : text));
ready();

etude.languageName(language).then((name) => { if (name) etude.$(".code-lang").textContent = name; });
editor = await etude.codeEditor(host, {
  value: initial,
  language,
  minLines: Math.max(6, initial.split("\n").length + 2),
  // Focused below instead: an autofocus attribute in this cross-origin frame only logs an error.
  autofocus: false,
  readOnly: etude.mode !== "answer",
  onChange(v) { text = v; ready(); },
});
host.querySelector(".e-editor-loading")?.remove();
if (etude.mode === "answer") editor.focus();

etude.onResult(async ({ grade, key }) => {
  editor.setReadOnly(true);
  const box = etude.$(".code-box");
  box.classList.add("is-readonly");
  const esc = etude.escape;
  // The result reads like the prototype: a title with the pass count, the first three failures only,
  // the explanation, then Your code / Reference in one place.
  const tests = grade?.details?.tests;
  const verdict = etude.$(".code-verdict");
  const list = etude.$(".code-tests");
  if (Array.isArray(tests) && tests.length) {
    const passed = tests.filter((t) => t.ok).length;
    if (verdict) verdict.textContent = passed === tests.length ? `All ${tests.length} tests pass.` : `${passed} of ${tests.length} tests pass.`;
    const fails = tests.filter((t) => !t.ok);
    const rows = await Promise.all(fails.slice(0, 3).map(async (t) => {
      const expr = await etude.highlight(t.expr, language).catch(() => esc(t.expr));
      return `<div class="code-test fail"><code class="expr">${expr}</code><span class="want">expected ${esc(t.expected)}</span><span class="got">got ${esc(t.got)}</span></div>`;
    }));
    if (list) list.innerHTML = rows.join("") + (fails.length > 3 ? `<div class="code-more">and ${fails.length - 3} more like this</div>` : "");
  } else if (verdict) verdict.remove();

  const view = etude.$(".code-view");
  const ref = etude.$(".code-ref");
  if (ref && key?.reference) ref.querySelector("code").innerHTML = await etude.highlight(key.reference, language);
  // Your code (the editor itself, read-only) and the reference share one place under the tabs.
  if (view) view.append(box);
  if (view && ref) view.append(ref);
  const tabs = etude.$$(".code-tab");
  const show = (which) => {
    tabs.forEach((t) => { const on = t.dataset.tab === which; t.classList.toggle("on", on); t.setAttribute("aria-selected", String(on)); });
    box.hidden = which !== "mine";
    if (ref) ref.hidden = which !== "ref";
  };
  tabs.forEach((t) => t.addEventListener("click", () => show(t.dataset.tab)));
  const allPass = (grade?.score ?? 0) >= 1;
  show(ref && (allPass || document.body.dataset.preview) ? "ref" : "mine");
  if (tabs.length < 2) etude.$(".code-tabs")?.classList.add("single");
});
