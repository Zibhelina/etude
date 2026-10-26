const { view } = etude;
const stage = etude.$(".io-stage");
const canvas = etude.$(".io-canvas");
const img = etude.$(".io-img");
const layer = etude.$(".io-boxes");
const pct = etude.$(".io-pct");
// Short enough that the image and the answer box fit on a laptop screen together; zoom for detail.
const MAX_H = 520;
const MAX_Z = 8;
const touchy = navigator.maxTouchPoints > 0 || matchMedia("(any-pointer: coarse), (hover: none)").matches;

// ---- boxes
const els = new Map();
view.boxes.forEach((b) => {
  const el = document.createElement("div");
  el.className = "io-box" + (b.target ? " is-target" : "") + (b.cover ? " is-cover" : " is-open");
  Object.assign(el.style, { left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` });
  if (b.target && b.cover) el.innerHTML = '<span class="io-q">?</span>';
  layer.append(el);
  els.set(b.id, el);
});

// ---- the answer row
const ask = etude.$(".io-ask");
let input = null;
if (view.removed) {
  ask.innerHTML = '<div class="e-muted io-self">This card\'s box was removed from the image. Its history is kept; suspend or delete the card if you no longer need it.</div>';
} else if (view.selfGraded) {
  ask.innerHTML = `<div class="e-muted io-self">Name the highlighted part${view.asked > 1 ? "s" : ""} to yourself, then show the answer.</div>`;
} else {
  ask.innerHTML = '<input class="e-input io-input" autocomplete="off" autocapitalize="off" spellcheck="false"><div class="io-fix only-result"></div>';
  input = ask.querySelector("input");
  input.placeholder = view.asked > 1 ? `Name the ${view.asked} highlighted boxes (one answer)` : "Name the highlighted box";
  if (typeof etude.answer === "string") input.value = etude.answer;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); etude.submit(); }
  });
}
etude.getAnswer(() => (input ? input.value : ""));
if (!input) stage.setAttribute("data-autofocus", "");

// ---- fit, zoom and pan
let W = 0, H = 0, z = 1, tx = 0, ty = 0;
const clamp = () => {
  tx = Math.min(0, Math.max(W - W * z, tx));
  ty = Math.min(0, Math.max(H - H * z, ty));
};
const apply = () => {
  clamp();
  canvas.style.transform = `translate(${tx}px, ${ty}px) scale(${z})`;
  canvas.style.setProperty("--z", z);
  stage.classList.toggle("is-zoomed", z > 1.001);
  pct.textContent = `${Math.round(z * 100)}%`;
  etude.$('.io-zoom[data-z="out"]').disabled = z <= 1.001;
  etude.$('.io-zoom[data-z="in"]').disabled = z >= MAX_Z - 0.001;
};
const zoomAt = (nz, px, py) => {
  nz = Math.min(MAX_Z, Math.max(1, nz));
  tx = px - (px - tx) * (nz / z);
  ty = py - (py - ty) * (nz / z);
  z = nz;
  apply();
};
function layout() {
  const ratio = img.naturalWidth && img.naturalHeight ? img.naturalHeight / img.naturalWidth : 0.6;
  const avail = etude.root.clientWidth || stage.parentElement.clientWidth;
  let w = avail, h = w * ratio;
  if (h > MAX_H) { h = MAX_H; w = h / ratio; }
  const k = W ? w / W : 1;
  W = w; H = h;
  stage.style.width = `${w}px`;
  stage.style.height = `${h}px`;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  tx *= k; ty *= k;
  view.boxes.forEach((b) => {
    const q = els.get(b.id).querySelector(".io-q");
    if (q) q.style.fontSize = `${Math.max(9, Math.min(18, b.h * H * 0.85, b.w * W * 0.6))}px`;
  });
  apply();
}
img.addEventListener("load", layout);
img.addEventListener("error", () => {
  stage.classList.add("is-broken");
  stage.setAttribute("data-msg", view.image ? "The image couldn't be loaded." : "No image yet.");
  layout();
});
img.src = view.image;
new ResizeObserver(() => layout()).observe(etude.root);
layout();

const local = (e) => {
  const r = stage.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
};
stage.addEventListener("wheel", (e) => {
  // Ctrl+wheel (and trackpad pinch, which arrives as Ctrl+wheel) zooms; a plain wheel pans a zoomed image.
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    const [px, py] = local(e);
    zoomAt(z * Math.exp(-e.deltaY * 0.0025), px, py);
  } else if (z > 1.001) {
    e.preventDefault();
    tx -= e.deltaX; ty -= e.deltaY;
    apply();
  }
}, { passive: false });

const pts = new Map();
let gesture = null;
let lastKind = "mouse";
stage.addEventListener("pointerdown", (e) => {
  lastKind = e.pointerType;
  if (e.pointerType === "touch") etude.$(".io-hint").textContent = "Pinch or double-tap to zoom";
  if (e.button !== 0 && e.pointerType === "mouse") return;
  pts.set(e.pointerId, local(e));
  stage.setPointerCapture?.(e.pointerId);
  begin();
});
function begin() {
  const p = [...pts.values()];
  if (p.length >= 2) {
    const [a, b] = p;
    gesture = { kind: "pinch", d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2, z, tx, ty };
  } else if (p.length === 1) gesture = { kind: "pan", x: p[0][0], y: p[0][1], tx, ty, moved: 0 };
  else gesture = null;
}
stage.addEventListener("pointermove", (e) => {
  if (!pts.has(e.pointerId) || !gesture) return;
  pts.set(e.pointerId, local(e));
  const p = [...pts.values()];
  if (gesture.kind === "pinch" && p.length >= 2) {
    const [a, b] = p;
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const nz = Math.min(MAX_Z, Math.max(1, gesture.z * (d / gesture.d)));
    // Keep the image point under the starting midpoint under the fingers' current midpoint.
    tx = mx - (gesture.mx - gesture.tx) * (nz / gesture.z);
    ty = my - (gesture.my - gesture.ty) * (nz / gesture.z);
    z = nz;
    apply();
  } else if (gesture.kind === "pan" && z > 1.001) {
    tx = gesture.tx + (p[0][0] - gesture.x);
    ty = gesture.ty + (p[0][1] - gesture.y);
    gesture.moved = Math.max(gesture.moved, Math.abs(p[0][0] - gesture.x) + Math.abs(p[0][1] - gesture.y));
    apply();
  }
});
// A double tap zooms in on touch screens (dblclick isn't reliable there); a second one fits again.
let lastTap = { t: 0, x: 0, y: 0 };
const end = (e) => {
  if (!pts.delete(e.pointerId)) return;
  if (e.type === "pointerup" && e.pointerType === "touch" && gesture?.kind === "pan" && (gesture.moved ?? 0) < 8) {
    const [px, py] = local(e);
    if (e.timeStamp - lastTap.t < 320 && Math.hypot(px - lastTap.x, py - lastTap.y) < 30) {
      zoomAt(z > 1.001 ? 1 : 2.5, px, py);
      lastTap = { t: 0, x: 0, y: 0 };
    } else lastTap = { t: e.timeStamp, x: px, y: py };
  }
  begin();
};
stage.addEventListener("pointerup", end);
stage.addEventListener("pointercancel", end);
stage.addEventListener("dblclick", (e) => {
  // Touch double taps are handled on pointerup; the browser's own dblclick would undo them.
  if (lastKind === "touch") return;
  const [px, py] = local(e);
  zoomAt(z > 1.001 ? 1 : 2.5, px, py);
});
etude.$$(".io-zoom").forEach((b) => b.addEventListener("click", () => {
  if (b.dataset.z === "fit") { z = 1; tx = ty = 0; apply(); return; }
  zoomAt(b.dataset.z === "in" ? z * 1.5 : z / 1.5, W / 2, H / 2);
}));
etude.$(".io-hint").textContent = touchy ? "Pinch or double-tap to zoom" : "Ctrl + scroll or double-click to zoom";

// ---- after grading
const chip = (el, text, cls) => {
  if (!text) return;
  const c = document.createElement("span");
  c.className = `io-chip ${cls}`;
  c.textContent = text;
  el.append(c);
};
etude.onResult(({ grade, key }) => {
  const right = grade.score != null && grade.score >= 1;
  const state = grade.score == null ? "is-self" : right ? "is-right" : "is-miss";
  view.boxes.forEach((b) => {
    const el = els.get(b.id);
    el.classList.remove("is-cover");
    el.classList.add("is-open");
    el.querySelector(".io-q")?.remove();
    const label = key.labels?.[b.id] ?? "";
    if (b.target) {
      el.classList.add(state);
      chip(el, label, "big");
    } else if (view.mode === "hide-all") chip(el, label, "small");
  });
  // Keep the first labelled target's chip only, so a group shows its name once.
  const chips = [...layer.querySelectorAll(".is-target .io-chip")];
  chips.slice(1).forEach((c) => { if (c.textContent === chips[0].textContent) c.remove(); });
  if (input) {
    input.disabled = true;
    input.classList.add(right ? "is-correct" : "is-wrong");
    const fix = ask.querySelector(".io-fix");
    if (!right) fix.textContent = (key.answers ?? [])[0] ?? "";
  } else {
    const none = view.asked > 1 ? "These boxes have no label." : "This box has no label.";
    ask.innerHTML = `<div class="e-answer io-said">${etude.escape((key.answers ?? [])[0] ?? "") || `<span class="e-muted">${none} Rate how well you knew it.</span>`}</div>`;
  }
});
