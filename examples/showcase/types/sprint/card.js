const { view } = etude;
const q = etude.$(".sp-q");
const input = etude.$(".sp-input");
const startBtn = etude.$(".sp-start");
const fill = etude.$(".sp-fill");
const timeEl = etude.$(".sp-time");
const countEl = etude.$(".sp-count");
const total = view.seconds * 1000;

const answers = [];
let i = 0, t0 = 0, running = false, finished = false, raf = 0, endTimer = 0;
q.textContent = "ready?";
q.classList.add("idle");
timeEl.textContent = `${view.seconds.toFixed(1)} s`;
countEl.textContent = `0 answered`;
etude.setReady(false);

const show = () => {
  q.classList.remove("idle", "pop");
  void q.offsetWidth;
  q.textContent = `${view.problems[i]} =`;
  q.classList.add("pop");
};
const tick = () => {
  const left = Math.max(0, total - (performance.now() - t0));
  fill.style.transform = `scaleX(${left / total})`;
  fill.classList.toggle("low", left < 5000);
  timeEl.textContent = `${(left / 1000).toFixed(1)} s`;
  if (left <= 0) return finish();
  raf = requestAnimationFrame(tick);
};
const finish = () => {
  if (finished) return;
  finished = true;
  running = false;
  cancelAnimationFrame(raf);
  clearTimeout(endTimer);
  // A half-typed answer when the clock runs out still counts.
  if (input.value.trim()) answers.push(input.value.trim());
  input.disabled = true;
  fill.style.transform = "scaleX(0)";
  timeEl.textContent = "0.0 s";
  q.textContent = "time!";
  quietUntil = performance.now() + 1500;
  etude.submit({ answers: answers.slice() });
};
const start = () => {
  if (running || finished || etude.mode !== "answer") return;
  running = true;
  startBtn.hidden = true;
  input.disabled = false;
  input.focus();
  t0 = performance.now();
  show();
  raf = requestAnimationFrame(tick);
  // Backup for when animation frames pause (hidden tab).
  endTimer = setTimeout(finish, total + 50);
};
startBtn.addEventListener("click", start);
// The card frame is sandboxed without forms, so Enter is handled on the input itself.
const next = () => {
  if (!running) return;
  const v = input.value.trim();
  if (!v) return;
  answers.push(v);
  input.value = "";
  countEl.textContent = `${answers.length} answered`;
  i++;
  if (i >= view.problems.length) return finish();
  show();
};
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); next(); }
});
// Enter or Space starts the round; while it runs, Enter belongs to the input.
// Right after the buzzer, Enter and Space are swallowed for a moment: someone mid-answer
// would otherwise rate the card before seeing their results.
let quietUntil = 0;
window.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if ((e.key === "Enter" || e.key === " ") && (performance.now() < quietUntil || (finished && etude.mode === "answer"))) { e.preventDefault(); return; }
  if (etude.mode !== "answer") return;
  if (!running && !finished && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); start(); }
});
etude.getAnswer(() => ({ answers: [...answers, ...(running && input.value.trim() ? [input.value.trim()] : [])] }));

etude.onResult(({ grade, key, answer }) => {
  if (finished) quietUntil = Math.max(quietUntil, performance.now() + 1200);
  running = false;
  finished = true;
  cancelAnimationFrame(raf);
  clearTimeout(endTimer);
  const d = grade?.details;
  const given = Array.isArray(answer?.answers) ? answer.answers : [];
  const rows = d?.rows ?? given.map((g, k) => ({ q: view.problems[k], given: String(g), want: key.answers[k], ok: null }));
  const correct = d?.correct ?? rows.filter((r) => r.ok).length;
  if (d) {
    etude.$(".sp-score .n").textContent = `${correct} right`;
    etude.$(".sp-score .of").textContent = `target ${view.target}`;
    const acc = d.answered ? Math.round((100 * correct) / d.answered) : 0;
    etude.$(".sp-line").textContent = `${d.answered} answered in ${view.seconds} seconds, ${acc}% accurate.`;
  } else {
    // Previews have no attempt: show what a round looks like.
    etude.$(".sp-score .n").textContent = `${view.seconds}s`;
    etude.$(".sp-score .of").textContent = `target ${view.target}`;
    etude.$(".sp-line").textContent = "The first problems of this round, with their answers.";
  }
  // Show what was attempted, plus the first unanswered problem so the round has an end.
  const shown = rows.length ? rows : view.problems.slice(0, 6).map((p, k) => ({ q: p, given: "", want: key.answers[k], ok: null }));
  etude.$(".sp-table").innerHTML = shown.length
    ? shown.map((r) => {
        const cls = r.ok === true ? "ok" : r.given === "" ? "skip" : r.ok === false ? "bad" : "";
        const a = r.ok ? etude.escape(r.given) : `${r.given ? `<s>${etude.escape(r.given)}</s> ` : ""}<span class="want">${r.want}</span>`;
        return `<div class="sp-row ${cls}"><span class="q">${etude.escape(r.q)}</span><span class="a">${a}</span></div>`;
      }).join("")
    : `<div class="sp-empty">No answers this round.</div>`;
});
