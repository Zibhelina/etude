// text: one line · long (default): markdown with live math, like a notebook · code: a code editor · plain: a bare textarea
const kind = etude.view.input || "long";
const box = etude.$(".answer-box");
const initial = etude.answer != null ? String(etude.answer) : "";
let text = initial;
const ready = () => etude.setReady(text.trim().length > 0);
etude.getAnswer(() => text);

if (kind === "text") {
  box.innerHTML = `<input class="e-input" id="answer" autocomplete="off" placeholder="Your answer" autofocus>`;
  const input = etude.$("#answer");
  input.value = initial;
  input.addEventListener("input", () => { text = input.value; ready(); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); etude.submit(); } });
  etude.onResult(() => { input.disabled = true; });
} else if (kind === "plain") {
  box.innerHTML = `<textarea class="e-textarea" id="answer" rows="5" placeholder="Answer in your own words" autofocus></textarea>`;
  const input = etude.$("#answer");
  input.value = initial;
  const grow = () => { input.style.height = "auto"; input.style.height = Math.max(input.scrollHeight + 2, 120) + "px"; };
  input.addEventListener("input", () => { text = input.value; grow(); ready(); });
  grow();
  etude.onResult(() => { input.disabled = true; });
} else {
  const code = kind === "code";
  box.innerHTML = `<div class="e-editor">${code ? `<div class="e-editor-head"><span class="lang"></span></div>` : ""}<div class="host"><div class="e-editor-loading">${etude.escape(initial)}</div></div></div>`;
  const host = etude.$(".answer-box .host");
  const language = String(etude.view.language || "");
  if (code && language) etude.languageName(language).then((n) => { etude.$(".answer-box .lang").textContent = n; });
  else if (code) etude.$(".answer-box .e-editor-head").remove();
  const opts = {
    value: initial,
    autofocus: etude.mode === "answer",
    readOnly: etude.mode !== "answer",
    onChange(v) { text = v; ready(); },
  };
  const editor = code
    ? await etude.codeEditor(host, { ...opts, language, minLines: 8 })
    : await etude.markdownEditor(host, { ...opts, minLines: 4, placeholder: "Answer in your own words. $math$ and **markdown** render as you type." });
  host.querySelector(".e-editor-loading")?.remove();
  if (etude.mode === "answer") editor.focus();
  etude.onResult(() => {
    editor.setReadOnly(true);
    etude.$(".answer-box .e-editor").classList.add("is-readonly");
  });
}
ready();
