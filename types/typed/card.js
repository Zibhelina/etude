const input = etude.$("#answer");
if (etude.answer != null) input.value = etude.answer;
input.placeholder ||= "Type your answer";
etude.getAnswer(() => input.value);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); etude.submit(); }
});
etude.onResult(({ grade, key }) => {
  input.disabled = true;
  input.classList.add(grade.score >= 1 ? "is-correct" : "is-wrong");
  etude.$(".accepted").innerHTML = key.answers.map((a) => `<code>${etude.escape(a)}</code>`).join(" ");
});
