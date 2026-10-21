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
  autofocus: etude.mode === "answer",
  readOnly: etude.mode !== "answer",
  onChange(v) { text = v; ready(); },
});
host.querySelector(".e-editor-loading")?.remove();
if (etude.mode === "answer") editor.focus();

etude.onResult(async ({ grade, key }) => {
  editor.setReadOnly(true);
  etude.$(".code-box").classList.add("is-readonly");
  const ref = etude.$(".code-ref code");
  if (ref && key.reference) ref.innerHTML = await etude.highlight(key.reference, language);
  const tests = grade?.details?.tests;
  const box = etude.$(".code-tests");
  if (box && Array.isArray(tests)) {
    const passed = tests.filter((t) => t.ok).length;
    const esc = etude.escape;
    box.innerHTML = `<div class="e-section-title">Tests · ${passed} of ${tests.length} passed</div>` + tests.map((t) =>
      `<div class="code-test ${t.ok ? "pass" : "fail"}"><span class="mark">${t.ok ? "✓" : "✗"}</span><span><code>${esc(t.expr)}</code>` +
      (t.ok ? "" : `<div class="got">expected <code>${esc(t.expected)}</code>, got <b>${esc(t.got)}</b></div>`) + `</span></div>`).join("");
  }
});
