const canvas = etude.$(".canvas");
const ctx = canvas.getContext("2d");
const bg = etude.view.background || "grid";
const css = getComputedStyle(document.documentElement);
const COLORS = [css.getPropertyValue("--foreground").trim() || "#fafafa", "#f472b6", "#60a5fa", "#4ade80", "#facc15"];
let color = COLORS[0], size = 3.5, tool = "pen";
const strokes = [];
let redo = [];
let current = null;
const W = () => canvas.clientWidth, H = () => canvas.clientHeight;

etude.$(".swatches").innerHTML = COLORS.map((c, i) => `<button type="button" class="swatch ${i ? "" : "is-on"}" data-color="${c}" style="--c:${c}" title="Color"></button>`).join("");

function fit() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  // Phones get a near-square canvas: there is room vertically and fingers need it.
  const h = Math.round(w < 520 ? Math.min(Math.max(w * 1.05, 340), 520) : Math.min(Math.max(w * 0.62, 320), 560));
  canvas.style.height = h + "px";
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  paint();
}

function paintBackground(c, w, h, forExport) {
  if (forExport) { c.fillStyle = "#ffffff"; c.fillRect(0, 0, w, h); }
  if (bg === "blank") return;
  c.strokeStyle = forExport ? "#e5e7eb" : "rgba(255,255,255,0.07)";
  c.lineWidth = 1;
  c.beginPath();
  const step = 24;
  if (bg === "grid") for (let x = step; x < w; x += step) { c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, h); }
  for (let y = step; y < h; y += step) { c.moveTo(0, y + 0.5); c.lineTo(w, y + 0.5); }
  c.stroke();
}

function drawStroke(c, s, forExport) {
  if (s.points.length === 0) return;
  c.lineCap = "round"; c.lineJoin = "round";
  c.globalCompositeOperation = s.tool === "eraser" ? "destination-out" : "source-over";
  c.strokeStyle = forExport && s.color === COLORS[0] ? "#111111" : s.color;
  c.lineWidth = s.tool === "eraser" ? s.size * 5 : s.size;
  c.beginPath();
  const p = s.points;
  c.moveTo(p[0][0], p[0][1]);
  if (p.length === 1) c.lineTo(p[0][0] + 0.01, p[0][1]);
  for (let i = 1; i < p.length - 1; i++) {
    const mx = (p[i][0] + p[i + 1][0]) / 2, my = (p[i][1] + p[i + 1][1]) / 2;
    c.quadraticCurveTo(p[i][0], p[i][1], mx, my);
  }
  if (p.length > 1) c.lineTo(p[p.length - 1][0], p[p.length - 1][1]);
  c.stroke();
  c.globalCompositeOperation = "source-over";
}

// Ink lives on its own layer so the eraser never removes the background.
const ink = document.createElement("canvas");
const inkCtx = ink.getContext("2d");
function paint() {
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, W(), H());
  paintBackground(ctx, W(), H(), false);
  ink.width = canvas.width; ink.height = canvas.height;
  inkCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const s of strokes) drawStroke(inkCtx, s, false);
  if (current) drawStroke(inkCtx, current, false);
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(ink, 0, 0); ctx.restore();
}

const pos = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
canvas.addEventListener("pointerdown", (e) => {
  if (etude.mode !== "answer") return;
  canvas.setPointerCapture(e.pointerId);
  current = { tool: e.buttons === 32 ? "eraser" : tool, color, size: e.pointerType === "pen" ? size * (0.6 + e.pressure) : size, points: [pos(e)] };
  paint();
});
canvas.addEventListener("pointermove", (e) => {
  if (!current) return;
  for (const ev of e.getCoalescedEvents?.() ?? [e]) current.points.push(pos(ev));
  paint();
});
const finish = () => {
  if (!current) return;
  strokes.push(current); redo = []; current = null; paint();
  etude.setReady(strokes.some((s) => s.tool === "pen"));
};
canvas.addEventListener("pointerup", finish);
canvas.addEventListener("pointercancel", finish);

etude.$(".tools").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.tool) { tool = b.dataset.tool; etude.$$("[data-tool]").forEach((x) => x.classList.toggle("is-on", x === b)); }
  if (b.dataset.color) { color = b.dataset.color; tool = "pen"; etude.$$(".swatch").forEach((x) => x.classList.toggle("is-on", x === b)); etude.$$("[data-tool]").forEach((x) => x.classList.toggle("is-on", x.dataset.tool === "pen")); }
  if (b.dataset.size) { size = Number(b.dataset.size); etude.$$("[data-size]").forEach((x) => x.classList.toggle("is-on", x === b)); }
  if (b.dataset.act === "undo" && strokes.length) { redo.push(strokes.pop()); paint(); }
  if (b.dataset.act === "redo" && redo.length) { strokes.push(redo.pop()); paint(); }
  if (b.dataset.act === "clear" && strokes.length) { redo = strokes.splice(0).reverse(); paint(); }
  etude.setReady(strokes.some((s) => s.tool === "pen"));
});
window.addEventListener("keydown", (e) => {
  if (etude.mode !== "answer") return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); etude.$(`[data-act="${e.shiftKey ? "redo" : "undo"}"]`).click(); }
  else if (!e.ctrlKey && !e.metaKey && e.key === "e") etude.$('[data-tool="eraser"]').click();
  else if (!e.ctrlKey && !e.metaKey && e.key === "p") etude.$('[data-tool="pen"]').click();
});

/** Exports the drawing on white, cropped to the ink with a margin, so a vision model sees it clearly. */
function exportPng() {
  const w = W(), h = H();
  const out = document.createElement("canvas");
  const scale = 2;
  out.width = w * scale; out.height = h * scale;
  const c = out.getContext("2d");
  c.scale(scale, scale);
  paintBackground(c, w, h, true);
  const layer = document.createElement("canvas");
  layer.width = w * scale; layer.height = h * scale;
  const lc = layer.getContext("2d");
  lc.scale(scale, scale);
  for (const s of strokes) drawStroke(lc, s, true);
  c.drawImage(layer, 0, 0, w, h);
  return out.toDataURL("image/png");
}

etude.getAnswer(() => ({ image: exportPng(), strokes: strokes.length }));
new ResizeObserver(fit).observe(canvas);
fit();
etude.setReady(false);

if (etude.answer?.image) {
  const img = new Image();
  img.onload = () => { ctx.drawImage(img, 0, 0, W(), H()); };
  img.src = etude.answer.image;
}
etude.onResult(({ answer }) => {
  canvas.classList.add("locked");
  if (!strokes.length && answer?.image) {
    const img = new Image();
    img.onload = () => { ctx.clearRect(0, 0, W(), H()); ctx.drawImage(img, 0, 0, W(), H()); };
    img.src = answer.image;
  }
});
