const input = etude.$("#answer");
const preview = etude.$(".wk-preview");
const note = etude.$(".wk-note");
const pad = etude.$(".wk-pad");
const toggle = etude.$(".wk-toggle");
const canvas = etude.$(".wk-canvas");
const ctx = canvas.getContext("2d");
const { math } = etude;
input.placeholder ||= "Final answer";

// Strokes are kept in canvas-width units, so the work replays at any size.
const strokes = [];
let tool = "pen", current = null;
const ratio = 0.62;
// Work loaded from an answer replays at the width it was written at (never wider than the pad), and the
// pad shrinks to fit it.
let basis = 0, replay = false;
const scale = () => (basis ? Math.min(W(), basis) : W());
const css = () => getComputedStyle(document.documentElement);
const W = () => canvas.clientWidth, H = () => canvas.clientHeight;

function fit() {
  const w = canvas.clientWidth;
  if (!w) return;
  const dpr = window.devicePixelRatio || 1;
  // Phones get a taller pad: there is room vertically and fingers need it.
  let h = Math.round(Math.min(Math.max(w * (w < 520 ? 0.95 : ratio), 220), 440));
  if (replay && strokes.length) {
    const maxY = Math.max(...strokes.flatMap((s) => s.pts.map((p) => p[1])));
    h = Math.round(Math.max(maxY * Math.min(w, basis || w) + 28, 120));
  }
  canvas.style.height = h + "px";
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  paint();
}

function paint() {
  if (!canvas.width) return;
  const w = W(), h = H(), c = css();
  ctx.clearRect(0, 0, w, h);
  // Faint graph paper.
  ctx.strokeStyle = c.getPropertyValue("--border").trim() || "rgba(128,128,128,.2)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 24; x < w; x += 24) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); }
  for (let y = 24; y < h; y += 24) { ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); }
  ctx.stroke();
  const ink = c.getPropertyValue("--foreground").trim() || "#111";
  // Ink is drawn on its own pass so the eraser can't remove the grid: erased spans just aren't drawn.
  const layer = document.createElement("canvas");
  layer.width = canvas.width; layer.height = canvas.height;
  const lc = layer.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  lc.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const s of current ? [...strokes, current] : strokes) stroke(lc, s, ink, scale());
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(layer, 0, 0); ctx.restore();
}

function stroke(c, s, ink, w) {
  const p = s.pts;
  if (!p.length) return;
  c.lineCap = "round"; c.lineJoin = "round";
  c.globalCompositeOperation = s.erase ? "destination-out" : "source-over";
  c.strokeStyle = ink;
  c.lineWidth = s.erase ? 18 : Math.max(1.6, w * 0.0035);
  c.beginPath();
  c.moveTo(p[0][0] * w, p[0][1] * w);
  if (p.length === 1) c.lineTo(p[0][0] * w + 0.01, p[0][1] * w);
  for (let i = 1; i < p.length - 1; i++) {
    const mx = ((p[i][0] + p[i + 1][0]) / 2) * w, my = ((p[i][1] + p[i + 1][1]) / 2) * w;
    c.quadraticCurveTo(p[i][0] * w, p[i][1] * w, mx, my);
  }
  if (p.length > 1) c.lineTo(p[p.length - 1][0] * w, p[p.length - 1][1] * w);
  c.stroke();
  c.globalCompositeOperation = "source-over";
}

const at = (e) => { const r = canvas.getBoundingClientRect(), k = scale() * (r.width / (W() || 1)) || 1; return [(e.clientX - r.left) / k, (e.clientY - r.top) / k]; };
canvas.addEventListener("pointerdown", (e) => {
  if (etude.mode !== "answer") return;
  canvas.setPointerCapture(e.pointerId);
  current = { erase: tool === "eraser" || e.buttons === 32, pts: [at(e)] };
  paint();
});
canvas.addEventListener("pointermove", (e) => {
  if (!current) return;
  for (const ev of e.getCoalescedEvents?.() ?? [e]) current.pts.push(at(ev));
  paint();
});
const finish = () => { if (!current) return; strokes.push(current); current = null; paint(); };
canvas.addEventListener("pointerup", finish);
canvas.addEventListener("pointercancel", finish);

etude.$(".wk-tools").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.tool) { tool = b.dataset.tool; etude.$$("[data-tool]").forEach((x) => x.classList.toggle("is-on", x === b)); }
  if (b.dataset.act === "undo") strokes.pop();
  if (b.dataset.act === "clear") strokes.length = 0;
  paint();
});

const show = (on) => {
  pad.hidden = !on;
  toggle.setAttribute("aria-pressed", String(on));
  toggle.title = on ? "Hide the scratchpad" : "Show the scratchpad";
  if (on) requestAnimationFrame(fit);
};
toggle.addEventListener("click", () => show(pad.hidden));
new ResizeObserver(fit).observe(canvas);

// What renders is what gets graded: the parsed answer printed back as LaTeX.
const render = () => {
  const src = input.value.trim();
  preview.classList.remove("is-unread");
  note.classList.remove("is-error");
  note.textContent = "";
  if (!src) {
    preview.innerHTML = `<span class="wk-empty">Your answer renders here</span>`;
    etude.setReady(false);
    return;
  }
  try {
    preview.innerHTML = etude.tex(math.toLatex(math.parse(src)), true);
  } catch (e) {
    preview.innerHTML = etude.tex(src, true);
    preview.classList.add("is-unread");
    note.classList.add("is-error");
    note.textContent = `Can't read this yet: ${e.message}`;
  }
  etude.setReady(true);
};
input.addEventListener("input", render);
input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); etude.submit(); } });
window.addEventListener("keydown", (e) => {
  if (etude.mode !== "answer" || pad.hidden || e.target === input) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); strokes.pop(); paint(); }
  else if (e.key === "e" || e.key === "p") etude.$(`[data-tool="${e.key === "e" ? "eraser" : "pen"}"]`).click();
});

// Rounded and capped so an attempt stays small.
const packed = () => {
  let budget = 6000;
  const paths = [];
  for (const s of strokes) {
    if (s.erase || budget <= 0) continue;
    const pts = s.pts.slice(0, budget).map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]);
    budget -= pts.length;
    paths.push(pts);
  }
  return paths;
};
etude.getAnswer(() => ({ value: input.value, paths: packed(), w: Math.round(scale()) }));

function load(answer) {
  if (answer == null) return;
  input.value = typeof answer === "string" ? answer : String(answer.value ?? "");
  const paths = Array.isArray(answer?.paths) ? answer.paths : [];
  if (paths.length) {
    strokes.length = 0;
    for (const p of paths) if (Array.isArray(p) && p.length) strokes.push({ pts: p });
    basis = Number(answer.w) > 0 ? Number(answer.w) : 0;
    replay = true;
    show(true);
  }
  render();
}
load(etude.answer);
if (etude.answer == null) render();

etude.onResult(({ grade, key, answer }) => {
  input.disabled = true;
  canvas.classList.add("locked");
  if (answer != null && !strokes.length) load(answer);
  // Without scratch work there is nothing to show above the answer.
  if (!strokes.length) pad.hidden = true;
  const s = grade?.score;
  preview.classList.add(s == null ? "is-partial" : s >= 1 ? "is-correct" : s > 0 ? "is-partial" : "is-wrong");
  if (grade?.feedback) { note.classList.remove("is-error"); note.textContent = grade.feedback; }
  const shown = (a) => { try { return etude.tex(math.toLatex(math.parse(a))); } catch { return etude.tex(a); } };
  const box = etude.$(".wk-accepted");
  if (box) box.innerHTML = (key.answers ?? []).slice(0, 1).map((a) => `<span>${/\\[a-zA-Z{]/.test(a) ? etude.tex(a) : shown(a)}</span>`).join("");
});
