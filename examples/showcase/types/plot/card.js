const { view } = etude;
const NS = "http://www.w3.org/2000/svg";
const el = (tag, attrs = {}, text) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
};
const [x0, x1, y0, y1] = view.range;
const PAD = 0.7;
const svg = etude.$(".pl-svg");
// One SVG unit is one grid unit; y is flipped with a transform on each element instead of the viewBox.
svg.setAttribute("viewBox", `${x0 - PAD} ${-(y1 + PAD)} ${x1 - x0 + 2 * PAD} ${y1 - y0 + 2 * PAD}`);
const Y = (y) => -y;
const snap = view.snap > 0 ? view.snap : 0;
const fmt = (v) => (v < 0 ? "\u2212" : "") + String(Math.abs(Math.round(v * 100) / 100));

// Grid, axes and tick labels.
const grid = etude.$(".pl-grid");
for (let x = Math.ceil(x0); x <= x1; x++) grid.append(el("line", { x1: x, y1: Y(y0), x2: x, y2: Y(y1), class: x === 0 ? "axis" : "" }));
for (let y = Math.ceil(y0); y <= y1; y++) grid.append(el("line", { x1: x0, y1: Y(y), x2: x1, y2: Y(y), class: y === 0 ? "axis" : "" }));
const ax = Math.max(x0, Math.min(x1, 0)), ay = Math.max(y0, Math.min(y1, 0));
grid.append(el("path", { d: `M${x1 + 0.45},${Y(ay)} l-0.2,-0.1 v0.2 Z`, class: "arrow" }));
grid.append(el("path", { d: `M${ax},${Y(y1 + 0.45)} l-0.1,0.2 h0.2 Z`, class: "arrow" }));
grid.append(el("line", { x1: x1, y1: Y(ay), x2: x1 + 0.3, y2: Y(ay), class: "axis" }));
grid.append(el("line", { x1: ax, y1: Y(y1), x2: ax, y2: Y(y1 + 0.3), class: "axis" }));
// Labels are HTML over the SVG so they render in KaTeX.
const tags = etude.$(".pl-tags");
const VW = x1 - x0 + 2 * PAD, VH = y1 - y0 + 2 * PAD;
const label = (x, y, texSrc, cls) => {
  const s = document.createElement("span");
  s.className = cls;
  s.style.left = ((x - x0 + PAD) / VW) * 100 + "%";
  s.style.top = ((y1 + PAD - y) / VH) * 100 + "%";
  s.innerHTML = etude.mdInline("$" + texSrc + "$");
  tags.append(s);
  return s;
};
const every = x1 - x0 > 14 ? 2 : 1;
for (let x = Math.ceil(x0); x <= x1; x++) if (x !== 0 && x % every === 0) label(x, ay - 0.36, String(x), "pl-tick");
for (let y = Math.ceil(y0); y <= y1; y++) if (y !== 0 && y % every === 0) label(ax - 0.3, y, String(y), "pl-tick left");
label(ax - 0.28, ay - 0.36, "0", "pl-tick");
label(x1 + 0.35, ay + 0.3, "x", "pl-var");
label(ax + 0.32, y1 + 0.35, "y", "pl-var");

// Placed points.
let pts = Array.isArray(etude.answer) ? etude.answer.map((p) => [Number(p[0]), Number(p[1])]) : [];
const placedG = etude.$(".pl-placed");
const count = etude.$(".pl-count");
const draw = () => {
  placedG.replaceChildren(...pts.map((p, i) => el("circle", { cx: p[0], cy: Y(p[1]), r: 0.17, class: "pt", "data-i": i })));
  const n = pts.length, want = view.count;
  count.innerHTML = `<b>${n}</b> of ${want} point${want === 1 ? "" : "s"}`;
  count.classList.toggle("over", n > want);
  count.classList.toggle("full", n === want);
  if (etude.mode === "answer") etude.setReady(n > 0);
};

const toWorld = (e) => {
  const pt = svg.createSVGPoint();
  pt.x = e.clientX;
  pt.y = e.clientY;
  const p = pt.matrixTransform(svg.getScreenCTM().inverse());
  return [p.x, -p.y];
};
const snapTo = ([x, y]) => {
  const s = (v) => (snap ? Math.round(v / snap) * snap : Math.round(v * 100) / 100);
  return [Math.max(x0, Math.min(x1, s(x))), Math.max(y0, Math.min(y1, s(y)))];
};
// Hit radius of about 22 CSS px, whatever the grid's size on screen.
const unitPx = () => svg.getBoundingClientRect().width / (x1 - x0 + 2 * PAD);
const hit = (w) => {
  const r = 22 / unitPx();
  let best = -1, bd = Infinity;
  pts.forEach((p, i) => {
    const d = Math.hypot(p[0] - w[0], p[1] - w[1]);
    if (d < r && d < bd) (best = i), (bd = d);
  });
  return best;
};

const cursor = etude.$(".pl-cursor");
let drag = null;
svg.addEventListener("pointerdown", (e) => {
  if (etude.mode !== "answer") return;
  e.preventDefault();
  const w = toWorld(e);
  const i = hit(w);
  svg.setPointerCapture(e.pointerId);
  if (i >= 0) drag = { i, moved: false, sx: e.clientX, sy: e.clientY, fresh: false };
  else {
    const p = snapTo(w);
    if (p[0] < x0 - 1e-9 || p[0] > x1 + 1e-9) return;
    pts.push(p);
    drag = { i: pts.length - 1, moved: true, sx: e.clientX, sy: e.clientY, fresh: true };
    draw();
  }
  svg.classList.add("dragging");
});
svg.addEventListener("pointermove", (e) => {
  if (etude.mode !== "answer") return;
  const w = toWorld(e);
  if (e.pointerType === "mouse" && !drag) {
    const p = snapTo(w);
    cursor.style.display = hit(w) >= 0 ? "none" : "";
    cursor.firstElementChild.setAttribute("cx", p[0]);
    cursor.firstElementChild.setAttribute("cy", Y(p[1]));
  }
  if (!drag) return;
  if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 6) drag.moved = true;
  if (drag.moved) {
    pts[drag.i] = snapTo(w);
    draw();
  }
});
const end = () => {
  if (!drag) return;
  if (!drag.moved && !drag.fresh) pts.splice(drag.i, 1);
  // Two points on the same spot are one point.
  pts = pts.filter((p, i) => pts.findIndex((q) => q[0] === p[0] && q[1] === p[1]) === i);
  drag = null;
  svg.classList.remove("dragging");
  draw();
};
svg.addEventListener("pointerup", end);
svg.addEventListener("pointercancel", end);
svg.addEventListener("pointerleave", () => (cursor.style.display = "none"));
etude.$(".pl-clear").addEventListener("click", () => {
  pts = [];
  draw();
});
// Keyboard: a cursor that arrows move by one snap step; Enter or Space places or removes a point there.
let kc = null;
const step = snap || 0.5;
const showKey = () => {
  cursor.style.display = kc ? "" : "none";
  if (!kc) return;
  cursor.firstElementChild.setAttribute("cx", kc[0]);
  cursor.firstElementChild.setAttribute("cy", Y(kc[1]));
  svg.setAttribute("aria-valuetext", `cursor at ${kc[0]}, ${kc[1]}`);
};
svg.addEventListener("keydown", (e) => {
  if (etude.mode !== "answer" || e.ctrlKey || e.metaKey || e.altKey) return;
  const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
  if (d) {
    e.preventDefault();
    kc = kc ?? [Math.max(x0, Math.min(x1, 0)), Math.max(y0, Math.min(y1, 0))];
    const m = e.shiftKey ? 1 / step : 1;
    kc = snapTo([kc[0] + d[0] * step * m, kc[1] + d[1] * step * m]);
    showKey();
  } else if ((e.key === "Enter" || e.key === " ") && kc) {
    e.preventDefault();
    const i = pts.findIndex((p) => p[0] === kc[0] && p[1] === kc[1]);
    if (i >= 0) pts.splice(i, 1);
    else pts.push(kc.slice());
    draw();
  } else if (e.key === "Backspace" && pts.length) {
    e.preventDefault();
    pts.pop();
    draw();
  }
});
svg.addEventListener("blur", () => { kc = null; showKey(); });
cursor.style.display = "none";
draw();
etude.getAnswer(() => pts);

const texPt = (p) => `$\\left(${p.map((v) => String(Math.round(v * 100) / 100)).join(", ")}\\right)$`;

etude.onResult(({ grade, key }) => {
  svg.classList.add("done");
  cursor.remove();
  const preview = document.body.dataset.preview === "1";
  const d = grade?.details ?? {};
  const placed = Array.isArray(d.placed) ? d.placed : pts;
  const match = Array.isArray(d.match) ? d.match : [];
  const extras = new Set(Array.isArray(d.extras) ? d.extras : []);
  pts = placed;

  // The curve(s), sampled densely and broken where they leave the grid. Samples are kept for label placement.
  const samples = [];
  if (key.curve) {
    const g = etude.$(".pl-curves");
    for (const expr of String(key.curve).split(";").map((s) => s.trim()).filter(Boolean)) {
      let f;
      try { f = new Function("x", `with (Math) { return (${expr}); }`); } catch { continue; }
      let path = "", pen = false;
      const N = 400;
      for (let k = 0; k <= N; k++) {
        const x = x0 + ((x1 - x0) * k) / N;
        let y;
        try { y = Number(f(x)); } catch { y = NaN; }
        const ok = Number.isFinite(y) && y >= y0 - 0.5 && y <= y1 + 0.5;
        if (ok) path += `${pen ? "L" : "M"}${x.toFixed(3)},${Y(y).toFixed(3)} `;
        if (ok && y >= y0 && y <= y1) samples.push([x, y]);
        pen = ok;
      }
      if (path) g.append(el("path", { d: path, class: "curve" }));
    }
    svg.append(el("clipPath", { id: "pl-clip" }, null));
    svg.lastChild.append(el("rect", { x: x0, y: Y(y1), width: x1 - x0, height: y1 - y0 }));
    g.setAttribute("clip-path", "url(#pl-clip)");
  }

  // Expected points: solid when you got them, dashed rings when missed.
  const exp = etude.$(".pl-expected");
  key.points.forEach((p, i) => {
    const got = match[i] >= 0 && match[i] !== undefined;
    exp.append(el("circle", { cx: p[0], cy: Y(p[1]), r: key.tolerance > 0.2 ? key.tolerance : 0.22, class: "zone" }));
    exp.append(el("circle", { cx: p[0], cy: Y(p[1]), r: got || preview ? 0.16 : 0.24, class: preview ? "want" : got ? "want hit" : "want miss" }));
  });
  draw();
  placedG.querySelectorAll(".pt").forEach((c, i) => {
    if (preview) return;
    c.classList.add(extras.has(i) ? "extra" : "good");
  });
  if (preview) placedG.replaceChildren();

  // Coordinates beside each expected point: try spots around it and keep the one that crosses the least
  // (curve, axes and tick labels, other points, labels already placed).
  const tagEls = key.points.map((p, i) => label(p[0], p[1], `\\left(${p.map((v) => String(Math.round(v * 100) / 100)).join(", ")}\\right)`, "pl-tag" + (!preview && !(match[i] >= 0) ? " missed" : "")));
  const placeTags = () => {
    const unit = svg.getBoundingClientRect().width / VW; // px per grid unit
    if (!unit) return;
    const taken = [];
    const dots = [...key.points, ...placed];
    const hits = (bx) => {
      let c = 0;
      const m = 0.15; // the stroke has width
      for (const [sx, sy] of samples) if (sx > bx[0] - m && sx < bx[2] + m && sy > bx[1] - m && sy < bx[3] + m) c += 3;
      for (const [px, py] of dots) if (px > bx[0] - 0.2 && px < bx[2] + 0.2 && py > bx[1] - 0.2 && py < bx[3] + 0.2) c += 40;
      // the x-axis tick row and the y-axis tick column
      if (bx[1] < ay + 0.1 && bx[3] > ay - 0.6) c += 25;
      if (bx[0] < ax + 0.1 && bx[2] > ax - 0.7) c += 25;
      for (const t of taken) if (bx[0] < t[2] && bx[2] > t[0] && bx[1] < t[3] && bx[3] > t[1]) c += 60;
      if (bx[0] < x0 - PAD + 0.05 || bx[2] > x1 + PAD - 0.05 || bx[1] < y0 - PAD + 0.05 || bx[3] > y1 + PAD - 0.05) c += 200;
      return c;
    };
    key.points.forEach((p, i) => {
      const elT = tagEls[i];
      const w = elT.offsetWidth / unit, h = elT.offsetHeight / unit;
      let best = null;
      for (const r of [0.45, 0.8, 1.2]) {
        for (let k = 0; k < 16; k++) {
          const ang = (k / 16) * 2 * Math.PI;
          // centre such that the box edge is r away from the point in this direction
          const cx = p[0] + Math.cos(ang) * (r + w / 2 * Math.abs(Math.cos(ang))) ;
          const cy = p[1] + Math.sin(ang) * (r + h / 2 * Math.abs(Math.sin(ang)));
          const bx = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
          // A tag should sit nearer its own point than any other, or it reads as someone else's.
          const near = (q) => Math.hypot(Math.max(bx[0], Math.min(q[0], bx[2])) - q[0], Math.max(bx[1], Math.min(q[1], bx[3])) - q[1]);
          const own = near(p);
          const confusing = dots.some((q) => (q[0] !== p[0] || q[1] !== p[1]) && near(q) < own + 0.25) ? 30 : 0;
          const cost = hits(bx) + confusing + r * 3 + (Math.sin(ang) < -0.3 ? 0.5 : 0);
          if (!best || cost < best.cost) best = { cost, cx, cy, bx };
        }
      }
      taken.push(best.bx);
      elT.style.left = ((best.cx - x0 + PAD) / VW) * 100 + "%";
      elT.style.top = ((y1 + PAD - best.cy) / VH) * 100 + "%";
    });
  };
  placeTags();
  new ResizeObserver(placeTags).observe(svg);

  const legend = [];
  if (!preview) {
    legend.push(`<span><i class="dot hit"></i>found</span>`);
    if (match.some((m) => !(m >= 0))) legend.push(`<span><i class="dot miss"></i>missed</span>`);
    if (extras.size) legend.push(`<span><i class="dot extra"></i>extra</span>`);
  }
  if (key.curve) legend.push(`<span><i class="line"></i>the curve</span>`);
  etude.$(".pl-legend").innerHTML = legend.join("");
  const fmtPt = (p) => `\\left(${p.map((v) => String(Math.round(v * 100) / 100)).join(", ")}\\right)`;
  const rows = key.points.map((p, i) => {
    const name = key.labels[i] ? key.labels[i] + ": " : "";
    const mark = preview ? "" : match[i] >= 0 ? " ✓" : " ✗ missed";
    return `- ${name}$${fmtPt(p)}$${mark}`;
  });
  if (!preview) for (const j of extras) rows.push(`- extra: $${fmtPt(placed[j])}$ ✗ costs half a point`);
  etude.$(".pl-list").innerHTML = etude.md(rows.join("\n"));
  if (!preview) {
    const hits = match.filter((m) => m >= 0).length;
    const sc = etude.$(".pl-score");
    sc.innerHTML = `${hits} of ${key.points.length} found${extras.size ? `, ${extras.size} extra` : ""}`;
    sc.classList.add(grade.score >= 1 ? "good" : grade.score > 0 ? "near" : "far");
  }
  etude.$$(".pl-list li").forEach((li) => {
    if (/✓/.test(li.textContent)) li.classList.add("ok");
    else if (/missed/.test(li.textContent)) li.classList.add("miss");
    else if (/✗/.test(li.textContent)) li.classList.add("bad");
  });
});
