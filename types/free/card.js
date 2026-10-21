const kind = etude.view.input || "long";
const box = etude.$(".answer-box");
box.innerHTML = kind === "text"
  ? `<input class="e-input" id="answer" autocomplete="off" placeholder="Your answer" autofocus>`
  : `<textarea class="e-textarea ${kind === "code" ? "mono" : ""}" id="answer" rows="${kind === "code" ? 10 : 5}" spellcheck="${kind !== "code"}" placeholder="${kind === "code" ? "" : "Answer in your own words"}" autofocus></textarea>`;
const input = etude.$("#answer");
if (etude.answer != null) input.value = etude.answer;
if (kind === "code") {
  input.addEventListener("keydown", (e) => {
    if (e.key === "Tab") { e.preventDefault(); const s = input.selectionStart; input.setRangeText("  ", s, input.selectionEnd, "end"); }
  });
} else if (kind === "text") {
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); etude.submit(); } });
}
const grow = () => { if (input.tagName === "TEXTAREA") { input.style.height = "auto"; input.style.height = Math.max(input.scrollHeight + 2, 120) + "px"; } };
input.addEventListener("input", () => { grow(); etude.setReady(input.value.trim().length > 0); });
grow();
etude.setReady(input.value.trim().length > 0);
etude.getAnswer(() => input.value);
etude.onResult(() => { input.disabled = true; });
