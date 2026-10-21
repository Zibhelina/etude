const { view } = etude;
const svg = etude.$(".uc-svg");
const NS = "http://www.w3.org/2000/svg";
const el = (tag, attrs) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};
const tex = (s) => etude.mdInline("$" + s + "$");

etude.$(".uc-theta").innerHTML = tex("\\theta = " + view.thetaTex);

// Tick marks every 15°, longer on the axes and the 30°/45° families.
const ticks = etude.$(".uc-ticks");
for (let d = 0; d < 360; d += 15) {
  const a = (d * Math.PI) / 180;
  const len = d % 90 === 0 ? 0.09 : d % 45 === 0 || d % 30 === 0 ? 0.06 : 0.035;
  const c = Math.cos(a), s = -Math.sin(a);
  ticks.append(el("line", { x1: c * (1 - len), y1: s * (1 - len), x2: c * (1 + len), y2: s * (1 + len), class: d % 90 === 0 ? "major" : "" }));
}

// Axis labels as HTML so they get KaTeX.
const labels = etude.$(".uc-labels");
const place = (x, y, html, cls = "") => {
  const span = document.createElement("span");
  span.className = "uc-label " + cls;
  span.style.left = ((x + 1.4) / 2.8) * 100 + "%";
  span.style.top = ((y + 1.4) / 2.8) * 100 + "%";
  span.innerHTML = html;
  labels.append(span);
  return span;
};
place(1.3, 0.12, tex("x"));
place(-0.1, -1.3, tex("y"));
place(1.08, 0.12, tex("1"), "small");

let deg = null;
const mine = etude.$(".uc-mine");
const draw = () => {
  mine.style.display = deg === null ? "none" : "";
  if (deg === null) return;
  const a = (deg * Math.PI) / 180;
  const x = Math.cos(a), y = -Math.sin(a);
  mine.querySelector(".uc-ray").setAttribute("x2", x);
  mine.querySelector(".uc-ray").setAttribute("y2", y);
  for (const c of mine.querySelectorAll("circle")) c.setAttribute("cx", x), c.setAttribute("cy", y);
  svg.setAttribute("aria-valuenow", deg);
  svg.setAttribute("aria-valuetext", deg + " degrees");
};
const set = (d) => {
  if (etude.mode !== "answer") return;
  deg = ((Math.round(d / 15) * 15) % 360 + 360) % 360;
  draw();
  etude.setReady(true);
};

const angleAt = (e) => {
  const pt = svg.createSVGPoint();
  pt.x = e.clientX;
  pt.y = e.clientY;
  const p = pt.matrixTransform(svg.getScreenCTM().inverse());
  if (Math.hypot(p.x, p.y) < 0.12) return null; // the centre has no direction
  return (Math.atan2(-p.y, p.x) * 180) / Math.PI;
};
let dragging = false;
svg.addEventListener("pointerdown", (e) => {
  if (etude.mode !== "answer") return;
  const a = angleAt(e);
  if (a === null) return;
  dragging = true;
  svg.setPointerCapture(e.pointerId);
  svg.classList.add("dragging");
  set(a);
  e.preventDefault();
});
svg.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const a = angleAt(e);
  if (a !== null) set(a);
});
const end = () => { dragging = false; svg.classList.remove("dragging"); };
svg.addEventListener("pointerup", end);
svg.addEventListener("pointercancel", end);

window.addEventListener("keydown", (e) => {
  if (etude.mode !== "answer" || e.ctrlKey || e.metaKey || e.altKey) return;
  const step = { ArrowLeft: 15, ArrowUp: 15, ArrowRight: -15, ArrowDown: -15 }[e.key];
  if (step === undefined) return;
  e.preventDefault();
  set((deg ?? 0) + (deg === null ? 0 : step));
});

if (etude.answer && Number.isFinite(Number(etude.answer.deg))) set(Number(etude.answer.deg));
else etude.setReady(false);
draw();
etude.getAnswer(() => (deg === null ? null : { deg }));

const gcd = (p, q) => (q ? gcd(q, p % q) : p);
const radOf = (d) => {
  const k = d / 15;
  if (!k) return "0";
  const g = gcd(k, 12), n = k / g, m = 12 / g;
  const top = n === 1 ? "\\pi" : n + "\\pi";
  return m === 1 ? top : `\\frac{${top}}{${m}}`;
};

etude.onResult(({ grade, key, answer }) => {
  svg.classList.add("done");
  if (answer && Number.isFinite(Number(answer.deg))) {
    deg = ((Math.round(Number(answer.deg) / 15) * 15) % 360 + 360) % 360;
    draw();
  }
  const preview = document.body.dataset.preview === "1";
  const score = grade?.score;
  if (deg !== null && !preview) mine.classList.add(score >= 1 ? "right" : score > 0 ? "near" : "wrong");
  if (score >= 1 || preview) mine.style.display = "none";

  // The arc from 0 to θ, spiralling outward when θ goes past a full turn.
  const truth = etude.$(".uc-truth");
  const D = key.degrees;
  const turns = Math.abs(D) / 360;
  const pts = [];
  const n = Math.max(2, Math.ceil(Math.abs(D) / 4));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = ((D * t) * Math.PI) / 180;
    const r = 0.3 + (turns > 1 ? 0.13 * t * turns : 0);
    pts.push([r * Math.cos(a), -r * Math.sin(a)]);
  }
  if (Math.abs(D) > 0) {
    truth.append(el("polyline", { points: pts.map((p) => p.join(",")).join(" "), class: "uc-arc" }));
    const [ex, ey] = pts[pts.length - 1];
    const [px, py] = pts[pts.length - 2];
    // Aim the head along the last few samples so it follows the curve.
    const [qx, qy] = pts[Math.max(0, pts.length - 4)];
    const ang = Math.atan2(ey - qy, ex - qx);
    const h = 0.1;
    truth.append(el("path", {
      d: `M${ex},${ey} L${ex - h * Math.cos(ang - 0.5)},${ey - h * Math.sin(ang - 0.5)} L${ex - h * Math.cos(ang + 0.5)},${ey - h * Math.sin(ang + 0.5)} Z`,
      class: "uc-arrow",
    }));
  }
  const a = (key.target * Math.PI) / 180;
  const x = Math.cos(a), y = -Math.sin(a);
  truth.append(el("line", { x1: x, y1: 0, x2: x, y2: y, class: "uc-drop" }));
  truth.append(el("line", { x1: 0, y1: 0, x2: x, y2: y, class: "uc-truth-ray" }));
  truth.append(el("circle", { cx: x, cy: y, r: 0.065, class: "uc-truth-dot" }));

  // Your ray goes under the correct one.
  svg.insertBefore(mine, truth);

  // Coordinates near the point, in the nearest spot outside the circle that clears the axes and labels.
  const lab = place(0, 0, tex(key.coordsTex), "coords");
  const stage = etude.$(".uc-stage");
  const leader = el("line", { class: "uc-leader" });
  truth.prepend(leader);
  const fit = () => {
    const W = stage.clientWidth;
    const u = W / 2.8; // px per unit
    const c = 1.4 * u; // centre, px
    const px = c + x * u, py = c + y * u;
    const w = lab.offsetWidth, h = lab.offsetHeight;
    const busy = [...labels.querySelectorAll(".uc-label:not(.coords)")].map((n) => {
      const r = n.getBoundingClientRect(), s = stage.getBoundingClientRect();
      return [r.left - s.left - 4, r.top - s.top - 4, r.right - s.left + 4, r.bottom - s.top + 4];
    });
    const clear = (l, t) => {
      const r = l + w, b = t + h;
      if (l < 2 || t < 2 || r > W - 2 || b > W - 2) return false;
      // nearest point of the box to the centre must be outside the circle
      const nx = Math.max(l, Math.min(c, r)), ny = Math.max(t, Math.min(c, b));
      if (Math.hypot(nx - c, ny - c) < u + 10) return false;
      // axes run from -1.3 to 1.3
      const ax = 1.3 * u;
      if (t < c + 3 && b > c - 3 && r > c - ax && l < c + ax) return false;
      if (l < c + 3 && r > c - 3 && b > c - ax && t < c + ax) return false;
      return !busy.some(([bl, bt, br, bb]) => l < br && r > bl && t < bb && b > bt);
    };
    let best = null;
    for (let t = 0; t <= W - h; t += 4)
      for (let l = 0; l <= W - w; l += 4) {
        if (!clear(l, t)) continue;
        const nx = Math.max(l, Math.min(px, l + w)), ny = Math.max(t, Math.min(py, t + h));
        const d = Math.hypot(nx - px, ny - py);
        if (!best || d < best.d) best = { l, t, d, nx, ny };
      }
    if (!best) {
      lab.style.display = "none";
      leader.style.display = "none";
      return;
    }
    lab.style.display = "";
    lab.style.left = best.l + w / 2 + "px";
    lab.style.top = best.t + h / 2 + "px";
    const far = best.d > 0.3 * u;
    leader.style.display = far ? "" : "none";
    if (far) {
      const toU = (v) => v / u - 1.4;
      leader.setAttribute("x1", x);
      leader.setAttribute("y1", y);
      leader.setAttribute("x2", toU(best.nx));
      leader.setAttribute("y2", toU(best.ny));
    }
  };
  fit();
  new ResizeObserver(fit).observe(stage);

  const same = key.degrees === key.target;
  const facts = [
    `$\\theta = ${view.thetaTex}${view.units === "radians" ? " = " + key.degrees + "^\\circ" : " = " + key.radTex}$`,
    same ? "" : `which lands in the same place as $${key.targetTex}$ (${key.degrees < 0 ? "negative angles turn clockwise" : "one full turn is $360^\\circ$"}).`,
  ].filter(Boolean).join(", ");
  etude.$(".uc-facts").innerHTML = etude.md(
    facts + `\n\n$(\\cos\\theta, \\sin\\theta) = ${key.coordsTex}$` +
    (deg !== null && !preview && score < 1 ? `\n\nYou placed ${view.units === "radians" ? `$${radOf(deg)}$ ($${deg}^\\circ$)` : `$${deg}^\\circ$`}: ${score > 0 ? "one $15^\\circ$ step off, half credit." : `$${grade.details?.off ?? ""}^\\circ$ off.`}` : ""),
  );
});
