const input = etude.$("#answer");
const note = etude.$(".wk-note");
const pad = etude.$(".wk-pad");
const ph = etude.$(".wk-ph");
const toggle = etude.$(".wk-toggle");
const canvas = etude.$(".wk-canvas");
const ctx = canvas.getContext("2d");
const { math } = etude;
input.placeholder ||= "your final answer";
const touch = matchMedia("(pointer: coarse)").matches;
ph.textContent = touch ? "Work it out here with your finger or pencil" : "Work it out here with your mouse or pen";

// Strokes are kept in canvas-width units, so the work replays at any size. A point is [x, y] or [x, y, pressure].
const strokes = [];
let tool = "pen", current = null, penSeen = false;
// Work loaded from an answer replays at the width it was written at (never wider than the pad), and the
// pad shrinks to fit it.
let basis = 0, replay = false;
const W = () => canvas.clientWidth, H = () => canvas.clientHeight;
const scale = () => (basis ? Math.min(W(), basis) : W());

function fit() {
  const w = pad.clientWidth;
  if (!w) return;
  const dpr = window.devicePixelRatio || 1;
  if (replay) {
    const ys = strokes.flatMap((s) => s.pts.map((p) => p[1]));
    const h = Math.round(Math.min(Math.max((ys.length ? Math.max(...ys) : 0) * Math.min(w, basis || w) + 28, 120), 340));
    canvas.style.height = h + "px";
  } else canvas.style.height = "";
  canvas.width = Math.round(W() * dpr);
  canvas.height = Math.round(H() * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  paint();
}

// Ink width follows pen pressure (thin when light, thick when heavy); a mouse or finger draws a steady line.
const width = (p) => 1.4 + (p ?? 0.5) * 2.6;
function paint() {
  if (!canvas.width) return;
  ctx.clearRect(0, 0, W(), H());
  const ink = getComputedStyle(document.documentElement).getPropertyValue("--foreground").trim() || "#111";
  for (const s of current ? [...strokes, current] : strokes) stroke(s, ink, scale());
}
function stroke(s, ink, w) {
  const p = s.pts;
  if (!p.length) return;
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.globalCompositeOperation = s.erase ? "destination-out" : "source-over";
  ctx.strokeStyle = ink;
  const X = (q) => q[0] * w, Y = (q) => q[1] * w;
  if (p.length < 3) {
    ctx.lineWidth = s.erase ? 24 : width(p[0][2]);
    ctx.beginPath(); ctx.moveTo(X(p[0]), Y(p[0])); ctx.lineTo(X(p[p.length - 1]) + 0.01, Y(p[p.length - 1])); ctx.stroke();
  } else {
    // Midpoint-smoothed, one short curve per point so the width can change along the stroke.
    let mx = X(p[0]), my = Y(p[0]);
    for (let i = 1; i < p.length; i++) {
      const last = i === p.length - 1;
      const nx = last ? X(p[i]) : (X(p[i]) + X(p[i + 1])) / 2, ny = last ? Y(p[i]) : (Y(p[i]) + Y(p[i + 1])) / 2;
      ctx.lineWidth = s.erase ? 24 : width(p[i][2]);
      ctx.beginPath(); ctx.moveTo(mx, my); ctx.quadraticCurveTo(X(p[i]), Y(p[i]), nx, ny); ctx.stroke();
      mx = nx; my = ny;
    }
  }
  ctx.globalCompositeOperation = "source-over";
}

const at = (e) => {
  const r = canvas.getBoundingClientRect(), k = scale() * (r.width / (W() || 1)) || 1;
  const q = [(e.clientX - r.left) / k, (e.clientY - r.top) / k];
  if (e.pointerType === "pen") q.push(Math.round((e.pressure || 0.5) * 100) / 100);
  return q;
};
canvas.addEventListener("pointerdown", (e) => {
  if (etude.mode !== "answer" || e.button > 0) return;
  if (e.pointerType === "pen") penSeen = true;
  // Palm rejection: once a pen has drawn, a resting hand doesn't.
  if (e.pointerType === "touch" && penSeen) return;
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  current = { erase: tool === "eraser" || e.buttons === 32, pts: [at(e)] };
  ph.textContent = "";
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

const setTool = (t) => { tool = t; etude.$$("[data-tool]").forEach((x) => x.classList.toggle("is-on", x.dataset.tool === t)); };
etude.$(".wk-tools").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.tool) setTool(b.dataset.tool);
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
new ResizeObserver(fit).observe(pad);

// The answer is checked like a Math answer; only a line it can't read says so.
const render = () => {
  const src = input.value.trim();
  note.classList.remove("is-error");
  note.textContent = "";
  etude.setReady(!!src);
  if (!src) return;
  try { math.parse(src); } catch (e) {
    note.classList.add("is-error");
    note.textContent = `Can't read this yet: ${e.message}`;
  }
};
input.addEventListener("input", render);
input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); if (input.value.trim()) etude.submit(); } });
window.addEventListener("keydown", (e) => {
  if (etude.mode !== "answer" || pad.hidden || e.target === input) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); strokes.pop(); paint(); }
  else if (e.key === "e" || e.key === "p") setTool(e.key === "e" ? "eraser" : "pen");
});

// Rounded and capped so an attempt stays small. Eraser strokes ride along so the replay matches what you saw.
const packed = () => {
  let budget = 6000;
  const paths = [];
  for (const s of strokes) {
    if (budget <= 0) break;
    const pts = s.pts.slice(0, budget).map(([x, y, p]) => (p == null ? [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4] : [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4, p]));
    budget -= pts.length;
    paths.push(s.erase ? { erase: true, pts } : pts);
  }
  return paths;
};
etude.getAnswer(() => ({ value: input.value, paths: packed(), w: Math.round(scale()) }));
etude.$(".wk-stuck").addEventListener("click", () => etude.submit({ value: "", stuck: true, paths: packed(), w: Math.round(scale()) }));

function load(answer) {
  if (answer == null) return;
  input.value = typeof answer === "string" ? answer : String(answer.value ?? "");
  const paths = Array.isArray(answer?.paths) ? answer.paths : [];
  if (paths.length) {
    strokes.length = 0;
    for (const p of paths) {
      if (Array.isArray(p) && p.length) strokes.push({ pts: p });
      else if (p && Array.isArray(p.pts) && p.pts.length) strokes.push({ erase: !!p.erase, pts: p.pts });
    }
    basis = Number(answer.w) > 0 ? Number(answer.w) : 0;
    ph.textContent = "";
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
  const s = grade?.score ?? 0;
  const typed = (typeof answer === "string" ? answer : answer?.value ?? "").trim();
  const yours = etude.$(".wk-yours");
  if (typed) {
    yours.className = `wk-yours ${s >= 1 ? "ok" : "no"}`;
    yours.innerHTML = `You wrote <b>${etude.escape(typed)}</b>`;
  }
  const shown = (a) => { try { return etude.tex(math.toLatex(math.parse(a))); } catch { return etude.tex(a); } };
  const box = etude.$(".wk-accepted");
  if (box) box.innerHTML = (key.answers ?? []).slice(0, 1).map((a) => `<span>${/\\[a-zA-Z{]/.test(a) ? etude.tex(a) : shown(a)}</span>`).join("");
  // Your scratch work moves under the solution, sized to what you wrote.
  const shot = etude.$(".wk-shot");
  if (strokes.length && shot) {
    replay = true;
    shot.hidden = false;
    shot.append(pad);
    pad.hidden = false;
    requestAnimationFrame(fit);
  } else pad.hidden = true;
});
