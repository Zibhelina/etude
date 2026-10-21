const input = etude.$("#answer");
const preview = etude.$(".mx-preview");
const note = etude.$(".mx-note");
const { math } = etude;
input.placeholder ||= "Type your answer";
if (etude.answer != null) input.value = String(etude.answer);

// What renders is what gets graded: the parsed answer printed back as LaTeX.
const render = () => {
  const src = input.value.trim();
  preview.classList.remove("is-unread");
  note.classList.remove("is-error");
  note.textContent = "";
  if (!src) {
    preview.innerHTML = `<span class="mx-empty">Your answer renders here</span>`;
    etude.setReady(false);
    return;
  }
  try {
    preview.innerHTML = etude.tex(math.toLatex(math.parse(src)), true);
    etude.setReady(true);
  } catch (e) {
    // Mid-typing ("\frac{1}{") or something the checker can't read: show what KaTeX makes of it.
    preview.innerHTML = etude.tex(src, true);
    preview.classList.add("is-unread");
    note.classList.add("is-error");
    note.textContent = `Can't read this yet: ${e.message}`;
    etude.setReady(true);
  }
};
input.addEventListener("input", render);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); etude.submit(); }
});
render();
etude.getAnswer(() => input.value);

etude.onResult(({ grade, key }) => {
  input.disabled = true;
  const s = grade?.score;
  preview.classList.add(s == null ? "is-partial" : s >= 1 ? "is-correct" : s > 0 ? "is-partial" : "is-wrong");
  if (grade?.feedback) {
    note.classList.remove("is-error");
    note.textContent = grade.feedback;
  }
  const shown = (a) => {
    try { return etude.tex(math.toLatex(math.parse(a))); } catch { return etude.tex(a); }
  };
  const box = etude.$(".mx-accepted");
  // Show answers the way their author wrote them when they are LaTeX already.
  if (box) box.innerHTML = (key.answers ?? []).map((a) => `<span>${/\\[a-zA-Z{]/.test(a) ? etude.tex(a) : shown(a)}</span>`).join("");
});
