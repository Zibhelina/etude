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
const STEM = 12, GAP = 7, LABEL_H = 22;
let geo = { w: 600, axisY: 80 };
let arcs = { runs: [], band: 0 }; // result only: where each wrong one was put
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

// Once graded every event sits at its true year; where you put it is drawn as a ghost on the axis.
const attemptMade = () => result && result.given !== result.key.years;
const placedYear = (id) => (result ? result.key.years[id] : guess[id]);

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
  // Every card on the line, anchors included, is a flag: its stem rises from the axis at its year
  // and meets the card's left edge (or right edge near the end of the line). Each card takes the
  // lane nearest the axis, on either side, where it overlaps nothing, no nearer card stands over
  // its stem, and it stands over no farther card's stem, so stems are straight and never pass
  // behind a card.
const all = [
    ...anchorEl.map((a) => ({ el: a.el, year: a.year, anchor: true })),
    ...ids.map((id) => ({ el: chipEl[id], year: placedYear(id), id })),
  ];
  for (const it of all) { it.wd = it.el.offsetWidth; it.h = it.el.offsetHeight; it.x = xOf(it.year); }
  if (result) arcs = planArcs();
  const M = 5;
  const spanFor = (it, dir) =>
    dir === "r" ? [it.x - 0.5, it.x - 0.5 + it.wd] : dir === "l" ? [it.x + 0.5 - it.wd, it.x + 0.5] : (() => { const c = clamp(it.x, it.wd / 2 - pad, w + pad - it.wd / 2); return [c - it.wd / 2, c + it.wd / 2]; })();
  // Graded, a card below the axis must not drop its stem through a miss's hairline.
  const clearOfMisses = (x) => !arcs.runs.some((r) => x > Math.min(r.gx, r.tx) - 6 && x < Math.max(r.gx, r.tx) + 6);
  const sides = result && attemptMade() ? ["up", "down"] : null;
  function plan(order) {
    const placed = [];
    const lanes = { up: [], down: [] };
    const ok = (it, side, L, lo, hi) =>
      (side === "up" || !result || clearOfMisses(it.x)) &&
      placed.every((p) => p.side !== side ||
        (p.lane === L ? hi + GAP <= p.lo || p.hi + GAP <= lo
          : p.lane < L ? !(it.x > p.lo - M && it.x < p.hi + M)
          : !(p.x > lo - M && p.x < hi + M)));
    const loose = (it, side, L, lo, hi) => (side === "up" || !result || clearOfMisses(it.x)) && placed.every((p) => p.side !== side || p.lane !== L || hi + GAP <= p.lo || p.hi + GAP <= lo);
    let prev = "down", bad = 0;
    for (const src of order) {
      const it = { ...src };
      const dirs = [];
      if (it.x - 0.5 + it.wd <= w + pad) dirs.push("r");
      if (it.x + 0.5 - it.wd >= -pad) dirs.push("l");
      if (!dirs.length) dirs.push("c");
      const sideOrder = sides ?? (prev === "up" ? ["down", "up"] : ["up", "down"]);
      let best = null;
      const any = (it, side, L, lo, hi) => placed.every((p) => p.side !== side || p.lane !== L || hi + GAP <= p.lo || p.hi + GAP <= lo);
      for (const test of [ok, loose, any]) {
        for (let L = 0; L < 10 && !best; L++)
          for (const side of sideOrder) {
            if (best) break;
            for (const dir of dirs) {
              const [lo, hi] = spanFor(it, dir);
              if (test(it, side, L, lo, hi)) { best = { side, lane: L, dir, lo, hi }; break; }
            }
          }
        if (best) break;
        bad++;
      }
      Object.assign(it, best);
      placed.push(it);
      for (let L = 0; L <= it.lane; L++) lanes[it.side][L] ??= { h: 0 };
      lanes[it.side][it.lane].h = Math.max(lanes[it.side][it.lane].h, it.h);
      prev = it.side;
    }
    const height = [...lanes.up, ...lanes.down].reduce((s, l) => s + (l.h ? l.h + GAP : 0), 0);
    return { placed, lanes, cost: bad * 10000 + height };
  }
  // A few orders (latest first, earliest first, widest first, middle out); keep the tidiest.
  const byYear = all.slice().sort((a, b) => b.year - a.year || (a.anchor ? 1 : -1));
  const mid = (from + to) / 2;
  const orders = [byYear, byYear.slice().reverse(), all.slice().sort((a, b) => b.wd - a.wd), all.slice().sort((a, b) => Math.abs(a.year - mid) - Math.abs(b.year - mid))];
  const { placed: items, lanes } = orders.map(plan).reduce((a, b) => (b.cost < a.cost ? b : a));
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
  const LABELS = LABEL_H + arcs.band;
  tl.style.height = `${axisY + LABELS + 6 + downH}px`;
  tl.style.setProperty("--axis", `${axisY}px`);
  tl.style.setProperty("--lab", `${9 + arcs.band}px`);
  // Year labels under the axis, knocked out of any stem passing behind them; a label a stem would
  // split down the middle is left out.
  // Stems of cards below the axis cross the label row: a label they'd cut through is left out.
  const downX = items.filter((it) => it.side === "down").map((it) => it.x);
  const labels = [];
  ticksEl.innerHTML = ticks(w)
    .map((t) => {
      const x = xOf(t.y);
      const show = t.major;
      if (show) labels.push(x);
      return `<i class="${t.major ? "major" : ""}" style="left:${x}px">${show ? `<span>${fmt(t.y)}</span>` : ""}</i>`;
    })
    .join("");
  const cls = (it) => (it.anchor ? "anchor" : [...it.el.classList].filter((k) => /^tl-(ok|bad|miss)$/.test(k)).join(" "));
  let stems = "";
  for (const it of items) {
    const top = it.side === "up" ? axisY - STEM - up[it.lane] - it.h : axisY + LABELS + 6 + down[it.lane];
    it.el.style.left = `${it.lo}px`;
    it.el.style.top = `${top}px`;
    it.el.dataset.side = it.side;
    it.el.dataset.dir = it.dir;
    const near = it.side === "up" ? top + it.h : top;
    stems += `<i class="${cls(it)}" style="left:${it.x}px;top:${Math.min(axisY, near)}px;height:${Math.abs(near - axisY)}px"></i>`;
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
// A wrong one: a small hollow ghost on the axis where you put it, and a thin arc under the axis
// from it to the true year, where the event now sits. Arcs that overlap nest one level deeper.
function planArcs() {
  const { key, given } = result;
  const runs = [];
  for (const c of view.chips) {
    const y = key.years[c.id], g = given[c.id];
    if (!Number.isFinite(g) || Math.abs(g - y) <= key.tolerance) continue;
    runs.push({ id: c.id, gx: xOf(g), tx: xOf(y) });
  }
  // Each miss is a straight hairline on its own track under the axis; overlapping ones take
  // separate tracks, so lines are parallel and never cross.
  runs.sort((p, q) => Math.min(p.gx, p.tx) - Math.min(q.gx, q.tx));
  const ends = [];
  for (const r of runs) {
    const a = Math.min(r.gx, r.tx) - 8, b = Math.max(r.gx, r.tx) + 8;
    let t = ends.findIndex((e) => e < a);
    if (t < 0) t = ends.length;
    ends[t] = b;
    r.depth = 9 + t * 7;
  }
  return { runs, band: runs.length ? Math.max(...runs.map((r) => r.depth)) + 5 : 0 };
}
function drawMarks() {
  const y0 = geo.axisY;
  let svg = "";
  for (const r of arcs.runs) {
    const y = y0 + r.depth, dir = Math.sign(r.tx - r.gx);
    svg += `<path d="M${r.gx + dir * 3} ${y}L${r.tx - dir * 4} ${y}"/>`;
    svg += `<path class="head" d="M${r.tx} ${y}L${r.tx - dir * 5} ${y - 2.6}L${r.tx - dir * 5} ${y + 2.6}Z"/>`;
    svg += `<circle cx="${r.gx}" cy="${y}" r="2.5"/>`;
  }
  marksEl.innerHTML = `<svg width="${geo.w}" height="${tl.offsetHeight}" viewBox="0 0 ${geo.w} ${tl.offsetHeight}" aria-hidden="true">${svg}</svg>`;
  tl.classList.toggle("has-arcs", arcs.runs.length > 0);
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
      yr.innerHTML = g === y ? `${fmt(y)}<i class="ck">✓</i>` : `${fmt(y)}<i class="ck">✓</i><em>yours ${fmt(g)}</em>`;
    } else {
      el.classList.add("tl-bad");
      yr.innerHTML = `${fmt(y)}<s aria-label="you put ${fmt(g)}">${fmt(g)}</s>`;
      el.title = `${c.label}: ${fmt(y)}; you put ${fmt(g)}`;
    }
  }
  if (!attempt) tl.classList.add("is-preview");
  layout();
  // The line already reads in order; a list only adds something when events carry notes.
  if (!view.chips.some((c) => key.notes?.[c.id])) return;
  const rows = view.chips
    .slice()
    .sort((a, b) => key.years[a.id] - key.years[b.id])
    .map((c) => `<div class="tl-row"><b>${fmt(key.years[c.id])}</b><span class="lbl">${etude.escape(c.label)}${key.notes?.[c.id] ? `<span class="nt">${etude.mdInline(key.notes[c.id])}</span>` : ""}</span></div>`)
    .join("");
  etude.$(".tl-list").innerHTML = `<div class="e-section-title">In order</div>${rows}`;
});
