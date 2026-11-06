// Long questions step down from the big serif so they stay readable.
{
  const q = etude.root.firstElementChild;
  const n = q?.textContent.length ?? 0;
  if (q && (n > 260 || q.querySelector("pre, ul, ol, table, .katex-display, h1, h2, h3"))) q.classList.add("q-long");
  else if (q && n > 110) q.classList.add("q-mid");
}
const input = etude.$("#answer");
const preview = etude.$(".mx-preview");
const note = etude.$(".mx-note");
const { math } = etude;
input.placeholder ||= "your final answer";
if (etude.answer != null) input.value = String(etude.answer);

// What renders is what gets graded: the parsed answer printed back as LaTeX. It stays quiet under the
// field, and only says something when it reads the answer differently from how it looks typed.
const render = () => {
  const src = input.value.trim();
  preview.classList.remove("is-unread");
  note.classList.remove("is-error");
  note.textContent = "";
  if (!src) {
    preview.innerHTML = "";
    etude.setReady(false);
    return;
  }
  try {
    preview.innerHTML = `<span class="mx-reads">reads as</span>${etude.tex(math.toLatex(math.parse(src)))}`;
    etude.setReady(true);
  } catch (e) {
    // Mid-typing ("\frac{1}{") or something the checker can't read: show what KaTeX makes of it.
    preview.innerHTML = `<span class="mx-reads">reads as</span>${etude.tex(src)}`;
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

// How to type math, behind the "?".
const help = etude.$(".mx-help");
const q = etude.$(".mx-q");
q?.addEventListener("click", (e) => {
  e.preventDefault();
  help.hidden = !help.hidden;
  q.setAttribute("aria-expanded", String(!help.hidden));
  q.classList.toggle("is-on", !help.hidden);
});

// I'm stuck: check an empty answer, which shows the solution and counts as not knowing it.
etude.$(".mx-stuck")?.addEventListener("click", () => etude.submit(""));

// ---------- scratchpad (desktop and tablet; a phone has the study screen's own scratchpad) ----------
// Ink that never leaves the card and is never graded; it shows as "Your work" after checking.
const pad = etude.$(".mx-pad");
const cv = etude.$(".mx-cv");
const pctx = cv.getContext("2d");
const ink = getComputedStyle(document.documentElement).getPropertyValue("--foreground").trim() || "#111";
const paths = [];
let ptool = "pen", cur = null, penSeen = false;
const sizePad = () => {
  const r = cv.getBoundingClientRect();
  if (!r.width) return;
  const dpr = Math.max(2, window.devicePixelRatio || 1);
  cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
  pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  redraw();
};
const seg = (s, a, b) => {
  pctx.globalCompositeOperation = s.e ? "destination-out" : "source-over";
  pctx.strokeStyle = ink; pctx.lineCap = "round"; pctx.lineJoin = "round";
  pctx.lineWidth = s.e ? 24 : 1.4 + b[2] * 2.6;
  pctx.beginPath(); pctx.moveTo(a[0], a[1]); pctx.lineTo(b[0] + (a === b ? 0.01 : 0), b[1]); pctx.stroke();
};
function redraw() {
  pctx.clearRect(0, 0, cv.width, cv.height);
  for (const s of paths) s.p.forEach((pt, i) => seg(s, s.p[Math.max(0, i - 1)], pt));
  pctx.globalCompositeOperation = "source-over";
}
const ppos = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top, e.pointerType === "pen" ? e.pressure || 0.5 : 0.5]; };
cv.addEventListener("pointerdown", (e) => {
  if (e.button > 0 || etude.mode !== "answer") return;
  if (e.pointerType === "pen") penSeen = true;
  if (e.pointerType === "touch" && penSeen) return;
  try { cv.setPointerCapture(e.pointerId); } catch {}
  const p = ppos(e);
  cur = { e: ptool === "erase", p: [p] };
  paths.push(cur);
  seg(cur, p, p);
  etude.$(".mx-ph")?.remove();
});
cv.addEventListener("pointermove", (e) => {
  if (!cur) return;
  const evs = e.getCoalescedEvents?.() ?? [];
  for (const ev of evs.length ? evs : [e]) { const p = ppos(ev), l = cur.p[cur.p.length - 1]; cur.p.push(p); seg(cur, l, p); }
});
const end = () => { cur = null; };
cv.addEventListener("pointerup", end);
cv.addEventListener("pointercancel", end);
etude.$(".mx-tools").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.pt) { ptool = b.dataset.pt; etude.$$("[data-pt]").forEach((x) => x.classList.toggle("is-on", x === b)); }
  if (b.dataset.pa === "undo") { paths.pop(); redraw(); }
  if (b.dataset.pa === "clear") { paths.length = 0; redraw(); }
});
const toggle = etude.$(".mx-scratch");
toggle.addEventListener("click", () => {
  pad.hidden = !pad.hidden;
  toggle.setAttribute("aria-pressed", String(!pad.hidden));
  if (!pad.hidden) requestAnimationFrame(sizePad);
  input.focus();
});
new ResizeObserver(() => { if (!pad.hidden) sizePad(); }).observe(pad);

/** The scratch work cropped to its ink, for the answer side. */
function workShot() {
  if (!paths.some((s) => !s.e) || !cv.width) return null;
  const out = document.createElement("canvas");
  out.width = cv.width; out.height = cv.height;
  out.getContext("2d").drawImage(cv, 0, 0);
  return out.toDataURL("image/png");
}

etude.onResult(({ grade, key, answer }) => {
  input.disabled = true;
  const s = grade?.score;
  const shown = (a) => {
    try { return etude.tex(math.toLatex(math.parse(a))); } catch { return etude.tex(a); }
  };
  // Show answers the way their author wrote them when they are LaTeX already.
  const nice = (a) => (/\\[a-zA-Z{]/.test(a) ? etude.tex(a) : shown(a));
  const given = String(answer ?? input.value ?? "").trim();
  const yours = etude.$(".mx-yours");
  if (yours) {
    const cls = s == null ? "" : s >= 1 ? "ok" : s > 0 ? "part" : "no";
    yours.innerHTML = given ? `You wrote <b class="${cls}">${shown(given)}</b>` : document.body.dataset.preview ? "" : "You didn’t answer";
  }
  const fb = etude.$(".mx-fb");
  if (fb) fb.textContent = grade?.feedback && given ? grade.feedback : "";
  const box = etude.$(".mx-accepted");
  if (box) box.innerHTML = (key?.answers ?? []).map((a) => `<span>${nice(a)}</span>`).join(`<i>or</i>`);
  const shot = workShot();
  const work = etude.$(".mx-work");
  if (shot && work) { work.hidden = false; work.querySelector(".mx-shot").innerHTML = `<img alt="Your work" src="${shot}">`; }
});
