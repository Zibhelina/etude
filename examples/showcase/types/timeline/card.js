const { view } = etude;
const { from, to } = view;
const tl = etude.$(".tl"), tray = etude.$(".tl-tray"), wrap = etude.$(".tl-wrap");
const span = to - from;
const fmt = (y) => (y < 0 ? `${-y} BC` : String(y));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

tl.setAttribute("role", "group");
tl.setAttribute("aria-label", `Timeline from ${fmt(from)} to ${fmt(to)}`);
tl.innerHTML = `<div class="tl-hint">Drop events on the line</div><div class="tl-ticks"></div><div class="tl-axis"></div><div class="tl-stems"></div><div class="tl-marks"></div><div class="tl-pins"></div><div class="tl-guide" hidden><span></span></div>`;
const ticksEl = tl.querySelector(".tl-ticks"), stemsEl = tl.querySelector(".tl-stems"), pins = tl.querySelector(".tl-pins");
const marksEl = tl.querySelector(".tl-marks"), guide = tl.querySelector(".tl-guide"), hint = tl.querySelector(".tl-hint");

const guess = {};
if (etude.answer && typeof etude.answer === "object") for (const [k, v] of Object.entries(etude.answer)) if (Number.isFinite(v)) guess[k] = v;
let result = null; // { key, given } once graded

const GRIP = `<svg class="grip" viewBox="0 0 6 10" aria-hidden="true"><circle cx="1" cy="1" r="1"/><circle cx="5" cy="1" r="1"/><circle cx="1" cy="5" r="1"/><circle cx="5" cy="5" r="1"/><circle cx="1" cy="9" r="1"/><circle cx="5" cy="9" r="1"/></svg>`;
const chipEl = {};
for (const c of view.chips) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "tl-chip";
  el.dataset.id = c.id;
  el.innerHTML = `${GRIP}<span class="lbl">${etude.escape(c.label)}</span><span class="yr"></span>`;
  chipEl[c.id] = el;
}
const anchorEl = view.anchors
  .filter((a) => a && Number.isFinite(a.year) && a.year >= from && a.year <= to)
  .map((a) => {
    const el = document.createElement("div");
    el.className = "tl-anchor";
    el.innerHTML = `<span class="lbl">${etude.escape(a.label)}</span><span class="yr">${fmt(a.year)}</span>`;
    el.title = `${a.label} (${fmt(a.year)}), given`;
    pins.appendChild(el);
    return { el, year: a.year };
  });

// Geometry, in px inside .tl. The axis runs the full width of .tl; .tl-wrap's padding is room
// for cards near the ends to hang over without leaving the card.
const STEM = 14, GAP = 8, LABELS = 24;
let geo = { w: 600, axisY: 80 };
const xOf = (y) => ((y - from) / span) * geo.w;
const yearAt = (clientX) => {
  const r = tl.getBoundingClientRect();
  return Math.round(from + clamp((clientX - r.left) / r.width, 0, 1) * span);
};

// Ticks: labels at a round step that leaves room for them, minor ticks between.
function ticks(w) {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  const major = steps.find((s) => (w / span) * s >= 64) ?? 5000;
  // Minor ticks on round years (every 1, 5, 10, 25… years), at most five per labelled step.
  const minor = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000].find((m) => major % m === 0 && m < major && major / m <= 5 && (w / span) * m >= 9) ?? major;
  const out = [];
  for (let y = Math.ceil(from / minor) * minor; y <= to; y += minor) out.push({ y, major: y % major === 0 });
  return out;
}

const placedYear = (id) => (result ? (Number.isFinite(result.given[id]) ? result.given[id] : result.key.years[id]) : guess[id]);

function layout() {
  const w = tl.clientWidth || 600;
  const pad = parseFloat(getComputedStyle(wrap).paddingLeft) || 0;
  geo.w = w;
  const ids = view.chips.map((c) => c.id).filter((id) => Number.isFinite(placedYear(id)));
  for (const c of view.chips) if (!ids.includes(c.id) && chipEl[c.id].parentNode !== tray) tray.appendChild(chipEl[c.id]);
  for (const id of ids) {
    const el = chipEl[id];
    if (el.parentNode !== pins) pins.appendChild(el);
    if (!result) el.querySelector(".yr").textContent = fmt(guess[id]);
  }
  // Every card on the line, anchors included, sorted by year, gets a side and a lane: the first lane
  // (nearest the axis) on either side where it doesn't overlap a neighbour, starting with the side
  // opposite the previous card, so neighbours stagger above and below.
  const items = [
    ...anchorEl.map((a) => ({ el: a.el, year: a.year, anchor: true })),
    ...ids.map((id) => ({ el: chipEl[id], year: placedYear(id), id })),
  ].sort((a, b) => a.year - b.year || (a.anchor ? -1 : 1));
  // Each card gets a side and a lane (lane 0 nearest the axis), staggering neighbours above and
  // below. Its stem must not pass through a card nearer the axis: if the year's own x is covered,
  // the stem jogs sideways just off the axis to the nearest clear gap (sx), and the card sits there.
  const placed = [];
  const lanes = { up: [], down: [] };
  const clearX = (side, L, x) => {
    const near = placed.filter((p) => p.side === side && p.lane < L).map((p) => [p.lo - 8, p.hi + 8]).sort((a, b) => a[0] - b[0]);
    const blocked = (v) => near.some(([a, b]) => v > a && v < b);
    if (!blocked(x)) return x;
    const cands = near.flatMap(([a, b]) => [a, b]).filter((v) => v >= -pad && v <= w + pad && !blocked(v));
    return cands.sort((a, b) => Math.abs(a - x) - Math.abs(b - x))[0] ?? null;
  };
  const fits = (it, side, L, sx) => {
    const cx = clamp(clamp(sx, it.wd / 2 - pad, w + pad - it.wd / 2), sx - it.wd / 2 + 14, sx + it.wd / 2 - 14);
    const lo = cx - it.wd / 2, hi = cx + it.wd / 2;
    const ok = placed.every((p) => p.side !== side || (p.lane === L ? hi + GAP <= p.lo || p.hi + GAP <= lo : p.lane < L || p.sx < lo - 6 || p.sx > hi + 6));
    return ok ? { cx, lo, hi } : null;
  };
  let prev = "down";
  for (const it of items) {
    it.wd = it.el.offsetWidth;
    it.h = it.el.offsetHeight;
    it.x = xOf(it.year);
    const order = prev === "up" ? ["down", "up"] : ["up", "down"];
    let best = null;
    for (let L = 0; L < 8 && !best; L++) {
      for (const side of order) {
        const sx = clearX(side, L, it.x);
        if (sx === null || Math.abs(sx - it.x) > Math.max(120, w * 0.25)) continue;
        const f = fits(it, side, L, sx);
        if (f) { best = { side, lane: L, sx, ...f }; break; }
      }
    }
    // A very crowded line: the lowest free lane on the emptier side, stem straight through.
    if (!best) {
      const side = lanes.up.length <= lanes.down.length ? "up" : "down";
      let L = 0;
      while (!fits(it, side, L, it.x)) L++;
      best = { side, lane: L, sx: it.x, ...fits(it, side, L, it.x) };
    }
    Object.assign(it, best);
    placed.push(it);
    for (let L = 0; L <= it.lane; L++) lanes[it.side][L] ??= { h: 0 };
    lanes[it.side][it.lane].h = Math.max(lanes[it.side][it.lane].h, it.h);
    prev = it.side;
  }
  // Lane offsets from the axis; at least one lane each side keeps the band steady while placing.
  const minH = 40;
  const size = (l) => (l.h ? l.h + GAP : 0);
  const offs = (side) => {
    let acc = 0;
    return lanes[side].map((l) => { const o = acc; acc += size(l); return o; });
  };
  const up = offs("up"), down = offs("down");
  const upH = Math.max(minH + GAP, lanes.up.reduce((s, l) => s + size(l), 0));
  const downH = Math.max(minH + GAP, lanes.down.reduce((s, l) => s + size(l), 0));
  const axisY = STEM + upH;
  geo.axisY = axisY;
  tl.style.height = `${axisY + LABELS + 6 + downH}px`;
  tl.style.setProperty("--axis", `${axisY}px`);
  // Year labels under the axis, knocked out of any stem passing behind them; a label a stem would
  // split down the middle is left out.
  const downX = items.filter((it) => it.side === "down").map((it) => it.x);
  const labels = [];
  ticksEl.innerHTML = ticks(w)
    .map((t) => {
      const x = xOf(t.y);
      const show = t.major && !downX.some((dx) => Math.abs(dx - x) < 7);
      if (show) labels.push(x);
      return `<i class="${t.major ? "major" : ""}" style="left:${x}px">${show ? `<span>${fmt(t.y)}</span>` : ""}</i>`;
    })
    .join("");
  const cls = (it) => (it.anchor ? "anchor" : [...it.el.classList].filter((k) => /^tl-(ok|bad|miss)$/.test(k)).join(" "));
  let stems = "";
  for (const it of items) {
    const top = it.side === "up" ? axisY - STEM - up[it.lane] - it.h : axisY + LABELS + 6 + down[it.lane];
    it.el.style.left = `${it.cx - it.wd / 2}px`;
    it.el.style.top = `${top}px`;
    it.el.dataset.side = it.side;
    const seg = (x, y0, y1) => (stems += `<i class="${cls(it)}" style="left:${x}px;top:${Math.min(y0, y1)}px;height:${Math.abs(y1 - y0)}px"></i>`);
    const near = it.side === "up" ? top + it.h : top, jog = it.side === "up" ? axisY - 7 : axisY + LABELS + 3;
    if (Math.abs(it.sx - it.x) < 1) seg(it.x, axisY, near);
    else {
      seg(it.x, axisY, jog);
      stems += `<i class="h ${cls(it)}" style="left:${Math.min(it.x, it.sx)}px;top:${jog}px;width:${Math.abs(it.sx - it.x)}px"></i>`;
      seg(it.sx, jog, near);
    }
  }
  // Dots sit on the axis at each card's year.
  stems += items.map((it) => `<b class="${cls(it)}" style="left:${it.x}px"></b>`).join("");
  stemsEl.innerHTML = stems;
  hint.hidden = ids.length > 0 || !!result;
  tray.classList.toggle("empty", !view.chips.some((c) => chipEl[c.id].parentNode === tray));
  if (result) drawMarks();
  etude.setReady(etude.mode === "answer" && ids.length > 0);
}

// ---------------------------------------------------------------- dragging
// The chip moves with a transform only and lands (lanes redone) on release: re-parenting a chip
// mid-drag would drop its pointer capture, which ends touch drags early.
let drag = null;
const inside = (r, e, pad = 0) => e.clientX > r.left - pad && e.clientX < r.right + pad && e.clientY > r.top - pad && e.clientY < r.bottom + pad;
const overLine = (e) => { const r = tl.getBoundingClientRect(); return e.clientY > r.top - 24 && e.clientY < r.bottom + 24 && e.clientX > r.left - 40 && e.clientX < r.right + 40; };
etude.root.addEventListener("pointerdown", (e) => {
  const el = e.target.closest(".tl-chip");
  if (!el || etude.mode !== "answer" || e.button > 0) return;
  e.preventDefault();
  const r = el.getBoundingClientRect();
  getSelection()?.removeAllRanges();
  drag = { el, id: el.dataset.id, dx: e.clientX - (r.left + r.width / 2), x0: e.clientX, y0: e.clientY, moved: false, year: null, toTray: false };
  el.setPointerCapture?.(e.pointerId);
});
window.addEventListener("pointermove", (e) => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) return;
  drag.moved = true;
  const el = drag.el;
  el.classList.add("dragging");
  el.style.setProperty("--tx", `${e.clientX - drag.x0}px`);
  el.style.setProperty("--ty", `${e.clientY - drag.y0}px`);
  drag.toTray = Number.isFinite(guess[drag.id]) && inside(tray.getBoundingClientRect(), e, 8);
  tray.classList.toggle("drop", drag.toTray);
  drag.year = !drag.toTray && overLine(e) ? yearAt(e.clientX - drag.dx) : null;
  guide.hidden = drag.year === null;
  tl.classList.toggle("targeting", drag.year !== null);
  if (drag.year !== null) {
    guide.style.left = `${xOf(drag.year)}px`;
    guide.firstChild.textContent = fmt(drag.year);
    el.querySelector(".yr").textContent = fmt(drag.year);
  } else el.querySelector(".yr").textContent = Number.isFinite(guess[drag.id]) ? fmt(guess[drag.id]) : "";
});
const end = () => {
  if (!drag) return;
  const { el, id } = drag;
  getSelection()?.removeAllRanges();
  el.classList.remove("dragging");
  el.style.removeProperty("--tx");
  el.style.removeProperty("--ty");
  tray.classList.remove("drop");
  tl.classList.remove("targeting");
  guide.hidden = true;
  if (drag.toTray) delete guess[id];
  else if (drag.year !== null) guess[id] = drag.year;
  // A tap on a chip in the tray drops it in the middle of the line.
  else if (!drag.moved && !Number.isFinite(guess[id])) guess[id] = Math.round((from + to) / 2);
  drag = null;
  layout();
};
window.addEventListener("pointerup", end);
window.addEventListener("pointercancel", end);
etude.root.addEventListener("keydown", (e) => {
  const el = e.target.closest?.(".tl-chip");
  if (!el || etude.mode !== "answer" || e.ctrlKey || e.metaKey || e.altKey) return;
  const id = el.dataset.id;
  if ((e.key === "Delete" || e.key === "Backspace") && Number.isFinite(guess[id])) {
    e.preventDefault();
    delete guess[id];
  } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    const d = (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 10 : 1);
    guess[id] = clamp((Number.isFinite(guess[id]) ? guess[id] : Math.round((from + to) / 2)) + d, from, to);
  } else return;
  layout();
  el.focus({ preventScroll: true });
});
let lastW = 0;
new ResizeObserver(() => { if (tl.clientWidth !== lastW) { lastW = tl.clientWidth; layout(); } }).observe(tl);
document.fonts?.ready.then(layout);
layout();
etude.getAnswer(() => ({ ...guess }));

// ---------------------------------------------------------------- result
// Each card stays where it was put, colored by how close it was. A wrong one gets a ring at its
// true year and an arrow along the axis from where it was put to where it belongs.
function drawMarks() {
  const { key, given } = result;
  const runs = [];
  let rings = "";
  for (const c of view.chips) {
    const y = key.years[c.id], g = given[c.id];
    if (!Number.isFinite(g) || Math.abs(g - y) <= key.tolerance) continue;
    const gx = xOf(g), tx = xOf(y), dir = Math.sign(tx - gx);
    runs.push({ a: Math.min(gx, tx), b: Math.max(gx, tx), dir, tx, gx });
    rings += `<b style="left:${tx}px" title="${etude.escape(c.label)}: ${fmt(y)}"></b>`;
  }
  // A wrong one: a ring at the true year, and a red arrow from your year to it. Arrows that would
  // overlap go on separate tracks just above the axis.
  const tracks = [];
  let html = "";
  for (const r of runs.sort((p, q) => p.a - q.a)) {
    let t = tracks.findIndex((end) => end + 10 < r.a);
    if (t < 0) t = tracks.length;
    tracks[t] = r.b;
    const a = r.dir > 0 ? r.gx : r.tx + 10, b = r.dir > 0 ? r.tx - 10 : r.gx;
    html += `<i class="run ${r.dir > 0 ? "r" : "l"}" style="left:${a}px;width:${Math.max(0, b - a)}px;--t:${t}"></i>`;
  }
  marksEl.innerHTML = html + rings;
}

etude.onResult(({ key, answer }) => {
  const given = answer && typeof answer === "object" ? answer : {};
  const attempt = Object.keys(given).length > 0;
  const tol = key.tolerance;
  // A preview with no attempt shows every event at its true year.
  result = { key, given: attempt ? given : key.years };
  for (const c of view.chips) {
    const el = chipEl[c.id];
    el.disabled = true;
    el.querySelector(".grip")?.remove();
    const y = key.years[c.id], g = given[c.id];
    const yr = el.querySelector(".yr");
    if (!attempt) { yr.textContent = fmt(y); continue; }
    if (!Number.isFinite(g)) {
      el.classList.add("tl-miss");
      yr.innerHTML = `${fmt(y)}<em>not placed</em>`;
    } else if (Math.abs(g - y) <= tol) {
      el.classList.add("tl-ok");
      yr.innerHTML = g === y ? fmt(y) : `${fmt(g)}<em>${fmt(y)}</em>`;
    } else {
      el.classList.add("tl-bad");
      yr.innerHTML = `<s>${fmt(g)}</s><em>${fmt(y)}</em>`;
    }
  }
  if (!attempt) tl.classList.add("is-preview");
  layout();
  const rows = view.chips
    .slice()
    .sort((a, b) => key.years[a.id] - key.years[b.id])
    .map((c) => {
      const y = key.years[c.id], g = given[c.id];
      const o = Number.isFinite(g) ? g - y : null;
      const status = !attempt ? "" : o === null ? `<span class="st miss">not placed</span>` : Math.abs(o) <= tol ? `<span class="st ok">${o === 0 ? "exact" : `${Math.abs(o)} off`}</span>` : `<span class="st bad">yours ${fmt(g)}, ${Math.abs(o)} ${Math.abs(o) === 1 ? "year" : "years"} ${o > 0 ? "late" : "early"}</span>`;
      return `<div class="tl-row"><b>${fmt(y)}</b><span class="lbl">${etude.escape(c.label)}${key.notes?.[c.id] ? `<span class="nt">${etude.mdInline(key.notes[c.id])}</span>` : ""}</span>${status}</div>`;
    })
    .join("");
  etude.$(".tl-list").innerHTML = `<div class="e-section-title">In order</div>${rows}`;
});
