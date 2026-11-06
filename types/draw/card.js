// Long questions step down from the big serif so they stay readable.
{
  const q = etude.root.firstElementChild;
  const n = q?.textContent.length ?? 0;
  if (q && (n > 260 || q.querySelector("pre, ul, ol, table, .katex-display, h1, h2, h3"))) q.classList.add("q-long");
  else if (q && n > 110) q.classList.add("q-mid");
}
const canvas = etude.$(".canvas");
const ctx = canvas.getContext("2d");
const bg = etude.view.background || "grid";
const css = getComputedStyle(document.documentElement);
const COLORS = [css.getPropertyValue("--foreground").trim() || "#fafafa", "#f472b6", "#60a5fa", "#4ade80", "#facc15"];
let color = COLORS[0], size = 3.5, tool = "pen";
const strokes = [];
let redo = [];
let current = null;
let lastW = 0, lastH = 0;
const W = () => canvas.clientWidth || lastW, H = () => canvas.clientHeight || lastH;
const hint = etude.$(".pad-hint");
if (bg === "blank") etude.$(".pad").classList.add("blank");

etude.$(".swatches").innerHTML = COLORS.map((c, i) => `<button type="button" class="swatch ${i ? "" : "is-on"}" data-color="${c}" style="--c:${c}" title="Color" aria-label="Color"></button>`).join("");

function fit() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  // A hidden frame (e.g. the type editor's Preview tab before it's shown) has no width yet; the ResizeObserver calls again once it does.
  if (!w) return;
  // Phones get a near-square canvas: there is room vertically and fingers need it.
  // A blank pad (a character, a free sketch) is a square sheet, like writing on paper.
  const h = bg === "blank" ? w : Math.round(w < 520 ? Math.min(Math.max(w * 1.05, 340), 520) : Math.min(Math.max(w * 0.62, 320), 560));
  canvas.style.height = h + "px";
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  lastW = w; lastH = h;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  paint();
}

function paintBackground(c, w, h, forExport) {
  if (forExport) { c.fillStyle = "#ffffff"; c.fillRect(0, 0, w, h); }
  if (bg === "blank") return;
  // Faint lines in the text colour, so they read on light and dark themes alike.
  c.save();
  c.strokeStyle = forExport ? "#e5e7eb" : COLORS[0];
  c.globalAlpha = forExport ? 1 : 0.07;
  c.lineWidth = 1;
  c.beginPath();
  const step = 24;
  if (bg === "grid") for (let x = step; x < w; x += step) { c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, h); }
  for (let y = step; y < h; y += step) { c.moveTo(0, y + 0.5); c.lineTo(w, y + 0.5); }
  c.stroke();
  c.restore();
}

// A pen stroke keeps a width per point (pressure for a pen, speed for a finger or mouse) and is filled
// as round joints plus the quads between them, so the line swells and thins like ink.
function fillStroke(c, p) {
  const dot = (a) => { c.beginPath(); c.arc(a[0], a[1], a[2] / 2, 0, Math.PI * 2); c.fill(); };
  dot(p[0]);
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1], b = p[i];
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
    if (L > 0.01) {
      const nx = -dy / L, ny = dx / L, ra = a[2] / 2, rb = b[2] / 2;
      c.beginPath();
      c.moveTo(a[0] + nx * ra, a[1] + ny * ra);
      c.lineTo(b[0] + nx * rb, b[1] + ny * rb);
      c.lineTo(b[0] - nx * rb, b[1] - ny * rb);
      c.lineTo(a[0] - nx * ra, a[1] - ny * ra);
      c.closePath();
      c.fill();
    }
    dot(b);
  }
}

function drawStroke(c, s, forExport) {
  if (s.points.length === 0) return;
  const ink = forExport && s.color === COLORS[0] ? "#111111" : s.color;
  if (s.tool !== "eraser" && s.points[0].length > 2) {
    c.globalCompositeOperation = "source-over";
    c.fillStyle = ink;
    fillStroke(c, s.points);
    return;
  }
  c.lineCap = "round"; c.lineJoin = "round";
  c.globalCompositeOperation = s.tool === "eraser" ? "destination-out" : "source-over";
  c.strokeStyle = ink;
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
  // WebKit throws InvalidStateError when drawImage gets a zero-sized canvas.
  if (!canvas.width || !canvas.height || !canvas.clientWidth) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, W(), H());
  paintBackground(ctx, W(), H(), false);
  ink.width = canvas.width; ink.height = canvas.height;
  inkCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const s of strokes) drawStroke(inkCtx, s, false);
  if (current) drawStroke(inkCtx, current, false);
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(ink, 0, 0); ctx.restore();
}

// Width of the next point: pressure for a pen, slower is thicker for a finger or mouse, eased so it never jumps.
let lw = 0, lp = null, lt = 0;
function widthAt(e, P) {
  let k;
  if (e.pointerType === "pen" && e.pressure > 0) k = 0.5 + Math.pow(e.pressure, 1.25) * 3.6;
  else {
    const v = lp ? Math.hypot(P[0] - lp[0], P[1] - lp[1]) / Math.max(1, e.timeStamp - lt) : 0;
    k = Math.max(1, Math.min(2.3, 2.3 - v * 0.6));
  }
  const w = size * k;
  lw = lw ? lw * 0.72 + w * 0.28 : w * 0.8;
  lp = P; lt = e.timeStamp;
  return lw;
}
const pos = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
const point = (e) => { const P = pos(e); P.push(widthAt(e, P)); return P; };

// One pass of Chaikin's corner cutting: the polyline becomes a smooth curve through the same shape.
function chaikin(p) {
  if (p.length < 3) return p;
  const out = [p[0]];
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i], b = p[i + 1];
    out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25, a[2] * 0.75 + b[2] * 0.25]);
    out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75, a[2] * 0.25 + b[2] * 0.75]);
  }
  out.push(p[p.length - 1]);
  return out;
}

let penSeen = false;
canvas.addEventListener("pointerdown", (e) => {
  if (etude.mode !== "answer" || e.button > 0 && e.buttons !== 32) return;
  if (e.pointerType === "pen") penSeen = true;
  // Once a stylus has drawn, a resting palm doesn't.
  if (e.pointerType === "touch" && penSeen) return;
  canvas.setPointerCapture(e.pointerId);
  lw = 0; lp = null; lt = e.timeStamp;
  const t = e.buttons === 32 ? "eraser" : tool;
  current = { tool: t, color, size, points: [t === "eraser" ? pos(e) : point(e)] };
  if (hint) hint.classList.add("gone");
  paint();
});
canvas.addEventListener("pointermove", (e) => {
  if (!current) return;
  const evs = e.getCoalescedEvents?.() ?? [];
  for (const ev of evs.length ? evs : [e]) current.points.push(current.tool === "eraser" ? pos(ev) : point(ev));
  paint();
});
const finish = () => {
  if (!current) return;
  if (current.tool !== "eraser") {
    const p = chaikin(current.points);
    // Taper the lift-off: the last few points thin out like a brush leaving the paper.
    const n = p.length;
    for (let k = 1; k <= Math.min(5, n - 1); k++) p[n - k] = [p[n - k][0], p[n - k][1], p[n - k][2] * (1 - 0.13 * (6 - k))];
    current.points = p;
  }
  strokes.push(current); redo = []; current = null; paint();
  etude.setReady(strokes.some((s) => s.tool === "pen"));
};
canvas.addEventListener("pointerup", finish);
canvas.addEventListener("pointercancel", finish);

etude.$(".tools").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.tool) { tool = b.dataset.tool; etude.$$("[data-tool]").forEach((x) => x.classList.toggle("is-on", x === b)); }
  const sw = b.closest(".swatches");
  if (b.dataset.color && sw && !sw.classList.contains("open") && b.classList.contains("is-on")) { sw.classList.add("open"); return; }
  if (sw) sw.classList.remove("open");
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
new ResizeObserver(() => { fit(); if (shippedPaths && strokes.length) fromPaths(shippedPaths); }).observe(canvas);
fit();
etude.setReady(false);

// An answer can also be strokes in 0..1 coordinates of a square centred on the canvas
// (`{ paths: [[[x, y], ...], ...] }`): how a deck ships an example drawing for watch mode.
function fromPaths(paths, w = W(), h = H()) {
  const s = Math.min(w, h) * 0.84, x0 = (w - s) / 2, y0 = (h - s) / 2;
  strokes.length = 0;
  for (const p of paths) {
    if (!Array.isArray(p) || p.length < 1) continue;
    const pts = [];
    for (let i = 0; i < p.length; i++) {
      const [ax, ay] = p[i], [bx, by] = p[i + 1] ?? p[i];
      const n = i + 1 < p.length ? 12 : 1;
      for (let t = 0; t < n; t++) pts.push([x0 + (ax + ((bx - ax) * t) / n) * s, y0 + (ay + ((by - ay) * t) / n) * s]);
    }
    strokes.push({ tool: "pen", color: COLORS[0], size: 7, points: pts });
  }
  paint();
}
const shippedPaths = Array.isArray(etude.answer?.paths) ? etude.answer.paths : null;
if (shippedPaths) requestAnimationFrame(() => fromPaths(shippedPaths));
else if (etude.answer?.image) {
  const img = new Image();
  img.onload = () => { ctx.drawImage(img, 0, 0, W(), H()); };
  img.src = etude.answer.image;
}

/** Your drawing alone, cropped to the ink, in the theme's colours, for the Yours tile. */
function snapshot(square) {
  const w = W() || 600, h = H() || 400;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) if (s.tool !== "eraser") for (const p of s.points) {
    const r = (p[2] ?? s.size) / 2;
    x0 = Math.min(x0, p[0] - r); y0 = Math.min(y0, p[1] - r); x1 = Math.max(x1, p[0] + r); y1 = Math.max(y1, p[1] + r);
  }
  if (!Number.isFinite(x0)) return null;
  const m = Math.max(16, Math.max(x1 - x0, y1 - y0) * 0.14);
  x0 -= m; y0 -= m; x1 += m; y1 += m;
  if (square) { const d = Math.max(x1 - x0, y1 - y0), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2; x0 = cx - d / 2; x1 = cx + d / 2; y0 = cy - d / 2; y1 = cy + d / 2; }
  else { x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(w, x1); y1 = Math.min(h, y1); }
  const scale = 2, out = document.createElement("canvas");
  out.width = Math.max(1, Math.round((x1 - x0) * scale)); out.height = Math.max(1, Math.round((y1 - y0) * scale));
  const c = out.getContext("2d");
  c.scale(scale, scale); c.translate(-x0, -y0);
  for (const s of strokes) drawStroke(c, s, false);
  return out.toDataURL("image/png");
}

// A reference that opens with the character itself ("水: a long central stroke…") shows it big, the rest under the tiles.
const GLYPH = /^\s*([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{1,4})\s*(?:[:：—–-]\s*|$)([\s\S]*)$/u;

etude.onResult(({ answer, key }) => {
  canvas.classList.add("locked");
  const ref = String(key?.reference ?? "");
  const g = ref.match(GLYPH);
  const refTile = etude.$(".dr-ref .dr-tile");
  if (g && refTile) {
    refTile.className = "dr-tile glyph";
    refTile.textContent = g[1];
    const more = etude.$(".dr-more");
    const rest = g[2].trim();
    if (more && rest) more.innerHTML = etude.md(rest[0].toUpperCase() + rest.slice(1));
  }
  const mine = etude.$(".dr-mine .dr-tile");
  if (!mine) return;
  if (g) etude.$(".dr-pair")?.classList.add("square");
  if (!strokes.length && Array.isArray(answer?.paths)) fromPaths(answer.paths, 400, 400);
  const src = strokes.length ? snapshot(!!g) : answer?.image ?? null;
  if (src) mine.innerHTML = `<img alt="Your drawing" src="${src}"${strokes.length ? "" : ' class="exported"'}>`;
  else mine.innerHTML = `<span class="dr-empty">Nothing drawn</span>`;
});
