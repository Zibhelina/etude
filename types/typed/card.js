// Long questions step down from the big serif so they stay readable.
{
  const q = etude.root.firstElementChild;
  const n = q?.textContent.length ?? 0;
  if (q && (n > 260 || q.querySelector("pre, ul, ol, table, .katex-display, h1, h2, h3"))) q.classList.add("q-long");
  else if (q && n > 110) q.classList.add("q-mid");
}
const input = etude.$("#answer");
if (etude.answer != null) input.value = etude.answer;
input.placeholder ||= "Type your answer";
etude.getAnswer(() => input.value);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); etude.submit(); }
});
etude.onResult(({ grade, key, answer }) => {
  input.disabled = true;
  const ok = (grade?.score ?? 0) >= 1;
  input.classList.add(ok ? "is-correct" : "is-wrong");
  const given = String(answer ?? input.value ?? "").trim();
  const answers = (key?.answers ?? []).map(String);
  // What you wrote, struck through when it's wrong; then the answer, big.
  const yours = etude.$(".ex-yours");
  if (yours) yours.innerHTML = given ? `You wrote <b class="${ok ? "ok" : "no"}">${etude.escape(given)}</b>` : document.body.dataset.preview ? "" : "You left it blank";
  const big = etude.$(".ex-big");
  if (big) big.textContent = answers[0] ?? "";
  const also = etude.$(".ex-also");
  if (also && answers.length > 1) also.innerHTML = `Also accepted: ${answers.slice(1).map((a) => `<span>${etude.escape(a)}</span>`).join(", ")}`;
});
