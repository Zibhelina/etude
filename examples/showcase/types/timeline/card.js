const { view } = etude;
const { from, to } = view;
const tl = etude.$(".tl"), tray = etude.$(".tl-tray");
const pct = (y) => ((y - from) / (to - from)) * 100;
const yearAt = (clientX) => {
  const r = tl.getBoundingClientRect();
  return Math.round(from + Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * (to - from));
};
const fmt = (y) => (y < 0 ? `${-y} BC` : String(y));

// Ticks at a round step that gives 4 to 8 labels.
const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((s) => (to - from) / s <= 8) ?? 1000;
let ticks = "";
for (let y = Math.ceil(from / step) * step; y <= to; y += step) ticks += `<div class="tl-tick" style="left:${pct(y)}%"><span>${fmt(y)}</span></div>`;
const anchors = view.anchors.filter((a) => a.year >= from && a.year <= to).map((a) => `<div class="tl-anchor" style="left:${pct(a.year)}%" title="${etude.escape(a.label)} (${fmt(a.year)})"><i></i><span>${etude.escape(a.label)}<b>${fmt(a.year)}</b></span></div>`).join("");
tl.setAttribute("role", "group"); tl.setAttribute("aria-label", "Timeline");
tl.innerHTML = `<div class="tl-axis"></div>${ticks}${anchors}<div class="tl-stems"></div><div class="tl-pins"></div>`;
const pins = tl.querySelector(".tl-pins"), stems = tl.querySelector(".tl-stems");

const guess = {};
if (etude.answer && typeof etude.answer === "object") Object.assign(guess, etude.answer);
const chipEl = {};
for (const c of view.chips) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "tl-chip";
  el.dataset.id = c.id;
  el.innerHTML = `<span class="lbl">${etude.escape(c.label)}</span><span class="yr"></span>`;
  chipEl[c.id] = el;
}

// Placed chips sit on the line in lanes, so nearby ones don't cover each other.
const layout = () => {
  const placed = view.chips.filter((c) => Number.isFinite(guess[c.id])).sort((a, b) => guess[a.id] - guess[b.id]);
  for (const c of view.chips) if (!Number.isFinite(guess[c.id])) tray.appendChild(chipEl[c.id]);
  const w = tl.getBoundingClientRect().width || 600;
  const pad = parseFloat(getComputedStyle(tl.parentNode).paddingLeft) || 0;
  const laneEnd = [];
  for (const c of placed) {
    const el = chipEl[c.id];
    if (el.parentNode !== pins) pins.appendChild(el);
    el.querySelector(".yr").textContent = fmt(guess[c.id]);
    // The chip stays inside the line's box; its stem still points at the year.
    const x = (pct(guess[c.id]) / 100) * w, half = (el.offsetWidth || 90) / 2 + 4;
    const cx = Math.min(Math.max(x, half - 4 - pad), w - half + 4 + pad);
    el.style.left = cx + "px";
    el.style.setProperty("--dx", x - cx + "px");
    let lane = laneEnd.findIndex((end) => end < cx - half);
    if (lane < 0) lane = laneEnd.length;
    laneEnd[lane] = cx + half;
    el.style.setProperty("--lane", lane);
  }
  tl.style.setProperty("--lanes", Math.max(1, laneEnd.length));
  // Stems live in their own layer under every chip, so a stem passing behind a lower chip is hidden by it.
  stems.innerHTML = placed.map((c) => `<i class="${chipEl[c.id].className.replace("tl-chip", "")}" style="left:${pct(guess[c.id])}%;--lane:${chipEl[c.id].style.getPropertyValue("--lane")}"></i>`).join("");
  tray.classList.toggle("empty", !tray.children.length);
  etude.setReady(etude.mode === "answer" && placed.length > 0);
};

// Dragging moves the chip with a transform only; it lands (and the lanes are redone) on release.
// Re-parenting a chip mid-drag would drop its pointer capture, which ends touch drags early.
let drag = null;
const inside = (r, e, pad = 0) => e.clientX > r.left - pad && e.clientX < r.right + pad && e.clientY > r.top - pad && e.clientY < r.bottom + pad;
const guide = document.createElement("div");
guide.className = "tl-guide";
guide.hidden = true;
tl.appendChild(guide);
const overLine = (e) => { const r = tl.getBoundingClientRect(); return e.clientY > r.top - 70 && e.clientY < r.bottom + 30; };
const onDown = (e) => {
  const el = e.target.closest(".tl-chip");
  if (!el || etude.mode !== "answer" || e.button > 0) return;
  e.preventDefault();
  const r = el.getBoundingClientRect();
  getSelection()?.removeAllRanges();
  drag = { el, id: el.dataset.id, dx: e.clientX - (r.left + r.width / 2), x0: e.clientX, y0: e.clientY, moved: false, year: null, toTray: false };
  el.setPointerCapture(e.pointerId);
};
const onMove = (e) => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) return;
  drag.moved = true;
  const el = drag.el;
  el.classList.add("dragging");
  el.style.setProperty("--tx", e.clientX - drag.x0 + "px");
  el.style.setProperty("--ty", e.clientY - drag.y0 + "px");
  drag.toTray = inside(tray.getBoundingClientRect(), e, 6) && Number.isFinite(guess[drag.id]);
  tray.classList.toggle("drop", drag.toTray);
  drag.year = !drag.toTray && overLine(e) ? yearAt(e.clientX - drag.dx) : null;
  guide.hidden = drag.year === null;
  if (drag.year !== null) {
    guide.style.left = pct(drag.year) + "%";
    guide.dataset.y = fmt(drag.year);
    el.querySelector(".yr").textContent = fmt(drag.year);
  } else el.querySelector(".yr").textContent = Number.isFinite(guess[drag.id]) ? fmt(guess[drag.id]) : "";
};
const onUp = () => {
  if (!drag) return;
  const { el, id } = drag;
  getSelection()?.removeAllRanges();
  el.classList.remove("dragging");
  el.style.removeProperty("--tx");
  el.style.removeProperty("--ty");
  tray.classList.remove("drop");
  guide.hidden = true;
  if (drag.toTray) delete guess[id];
  else if (drag.year !== null) guess[id] = drag.year;
  // A plain tap on a chip in the tray drops it in the middle of the line.
  else if (!drag.moved && !Number.isFinite(guess[id])) guess[id] = Math.round((from + to) / 2);
  drag = null;
  layout();
  el.focus({ preventScroll: true });
};
etude.root.addEventListener("pointerdown", onDown);
window.addEventListener("pointermove", onMove);
window.addEventListener("pointerup", onUp);
window.addEventListener("pointercancel", onUp);
etude.root.addEventListener("keydown", (e) => {
  const el = e.target.closest?.(".tl-chip");
  if (!el || etude.mode !== "answer" || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  e.preventDefault();
  const id = el.dataset.id;
  const d = (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 10 : 1);
  guess[id] = Math.min(to, Math.max(from, (Number.isFinite(guess[id]) ? guess[id] : Math.round((from + to) / 2)) + d));
  layout();
  el.focus();
});
new ResizeObserver(() => layout()).observe(tl);
layout();
etude.getAnswer(() => ({ ...guess }));

etude.onResult(({ key, answer, grade }) => {
  const off = grade?.details?.off ?? {};
  const g = answer && typeof answer === "object" ? answer : {};
  const tol = key.tolerance;
  // Each event gets its true year marked; a wrong guess gets an arc under the line from where you put it.
  let marks = "", arcs = "";
  view.chips.forEach((c, i) => {
    const el = chipEl[c.id];
    el.disabled = true;
    const y = key.years[c.id];
    const placed = Number.isFinite(g[c.id]);
    const good = placed && Math.abs(g[c.id] - y) <= tol;
    el.classList.add(placed ? (good ? "is-correct" : "is-wrong") : "is-missed");
    if (placed && !good) {
      const a = pct(g[c.id]), b = pct(y);
      const depth = Math.min(22, 7 + Math.abs(b - a) * 0.5);
      arcs += `<path d="M${a} 0 C${a} ${depth}, ${b} ${depth}, ${b} 0" vector-effect="non-scaling-stroke"/>`;
    }
    marks += `<div class="tl-true ${good ? "good" : ""}" style="left:${pct(y)}%"><i></i></div>`;
  });
  if (arcs) {
    marks = `<svg class="tl-arcs" viewBox="0 0 100 24" preserveAspectRatio="none">${arcs}</svg>` + marks;
    tl.classList.add("has-arcs");
  }
  tl.insertAdjacentHTML("beforeend", `<div class="tl-marks">${marks}</div>`);
  if (!Object.keys(g).length) {
    // A preview with no attempt: put every chip on its true year.
    view.chips.forEach((c) => (guess[c.id] = key.years[c.id]));
    view.chips.forEach((c) => chipEl[c.id].classList.remove("is-missed"));
  }
  layout();
  const rows = view.chips.slice().sort((a, b) => key.years[a.id] - key.years[b.id]).map((c) => {
    const o = off[c.id];
    const status = !Object.keys(g).length ? "" : o === null || o === undefined ? `<span class="st miss">not placed</span>` : Math.abs(o) <= tol ? `<span class="st ok">${o === 0 ? "exact" : `${Math.abs(o)} off`}</span>` : `<span class="st bad">you: ${fmt(g[c.id])}, ${Math.abs(o)} years ${o > 0 ? "late" : "early"}</span>`;
    return `<div class="tl-row"><b>${fmt(key.years[c.id])}</b><span class="lbl">${etude.escape(c.label)}${key.notes[c.id] ? `<span class="nt">${etude.mdInline(key.notes[c.id])}</span>` : ""}</span>${status}</div>`;
  }).join("");
  etude.$(".tl-list").innerHTML = rows;
});
