const { view } = etude;
const log = view.scale === "log";
const slider = etude.$(".es-slider");
const out = etude.$(".es-value");
const N = 1000;
const lmin = log ? Math.log10(view.min) : 0, lmax = log ? Math.log10(view.max) : 0;

// A step of 1, 2 or 5 times a power of ten, about a thousandth of the range.
const niceStep = (span) => {
  const raw = span / N, p = Math.pow(10, Math.floor(Math.log10(raw)));
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw);
};
const step = view.step || niceStep(view.max - view.min);
const sig = (x, d) => (x === 0 ? 0 : Number(x.toPrecision(d)));
const toValue = (p) => {
  const t = p / N;
  if (log) return sig(Math.pow(10, lmin + (lmax - lmin) * t), 2);
  return Math.round((view.min + (view.max - view.min) * t) / step) * step;
};
const toPos = (v) => {
  const t = log ? (Math.log10(v) - lmin) / (lmax - lmin) : (v - view.min) / (view.max - view.min);
  return Math.max(0, Math.min(1, t));
};

// "3.2 million", "8,850", "0.004".
const WORDS = [[1e12, "trillion"], [1e9, "billion"], [1e6, "million"]];
const fmt = (v) => {
  const a = Math.abs(v);
  for (const [n, w] of WORDS) if (a >= n) return `${sig(v / n, a / n >= 100 ? 3 : 2).toLocaleString("en")} ${w}`;
  if (a >= 1) return sig(v, log ? 2 : 6).toLocaleString("en");
  return String(sig(v, 2));
};
const sci = (v) => {
  const e = Math.floor(Math.log10(Math.abs(v)));
  const m = sig(v / Math.pow(10, e), 2);
  return m === 1 ? `10^{${e}}` : `${m} \\times 10^{${e}}`;
};
const unit = view.unit ? " " + view.unit : "";

const show = () => {
  const v = toValue(Number(slider.value));
  out.innerHTML = `<span class="num">${etude.escape(fmt(v))}</span><span class="unit">${etude.escape(unit)}</span>` +
    (log && Math.abs(v) >= 1e4 ? `<span class="sci">${etude.mdInline("$" + sci(v) + "$")}</span>` : "");
  slider.setAttribute("aria-valuetext", fmt(v) + unit);
};

// Ends, and powers of ten along a log track.
etude.$(".es-ends .lo").textContent = fmt(view.min) + unit;
etude.$(".es-ends .hi").textContent = fmt(view.max) + unit;
const marks = etude.$(".es-marks");
const at = (t) => `calc(${t * 100}% + ${(0.5 - t) * 1.5}rem)`;
if (log) {
  const decades = Math.floor(lmax) - Math.ceil(lmin);
  const every = decades > 8 ? 2 : 1;
  for (let e = Math.ceil(lmin); e <= Math.floor(lmax); e++) {
    if ((e - Math.ceil(lmin)) % every) continue;
    const t = (e - lmin) / (lmax - lmin);
    const m = document.createElement("span");
    m.className = "es-decade";
    m.style.left = at(t);
    m.innerHTML = `<i></i><b>${etude.mdInline(`$10^{${e}}$`)}</b>`;
    marks.append(m);
  }
  etude.$(".es-hint").textContent = "Each tick is ten times the last. Arrow keys nudge the slider.";
} else etude.$(".es-hint").textContent = "Drag the slider, or use the arrow keys.";
etude.$(".es").classList.toggle("is-log", log);

let touched = false;
const startPos = Number.isFinite(Number(etude.answer)) && etude.answer !== null ? Math.round(toPos(Number(etude.answer)) * N) : N / 2;
slider.value = String(startPos);
slider.addEventListener("input", () => {
  touched = true;
  show();
  etude.setReady(true);
});
show();
etude.setReady(etude.answer !== null);
etude.getAnswer(() => toValue(Number(slider.value)));

etude.onResult(({ grade, key, answer }) => {
  slider.disabled = true;
  const preview = document.body.dataset.preview === "1";
  const truth = key.answer;
  const guess = Number.isFinite(Number(answer)) && answer !== null ? Number(answer) : toValue(Number(slider.value));
  if (Number.isFinite(guess)) slider.value = String(Math.round(toPos(guess) * N));
  show();

  // The full-credit band and the true value on the track.
  const t = key.tolerance;
  const [a, b] = log
    ? [toPos(truth / Math.pow(10, t)), toPos(truth * Math.pow(10, t))]
    : [toPos(truth - t * (view.max - view.min)), toPos(truth + t * (view.max - view.min))];
  const band = document.createElement("span");
  band.className = "es-band";
  band.style.left = at(a);
  band.style.width = `calc(${(b - a) * 100}% - ${(b - a) * 1.5}rem)`;
  marks.append(band);
  const tm = document.createElement("span");
  tm.className = "es-truth";
  tm.style.left = at(toPos(truth));
  marks.append(tm);

  const tone = preview ? "" : grade.score >= 1 ? "good" : grade.score > 0 ? "near" : "far";
  if (tone) out.classList.add(tone);
  if (preview) slider.classList.add("hide-thumb");
  const words = grade?.details?.words;
  const truthTex = log && Math.abs(truth) >= 1e4 ? ` <span class="e-muted">${etude.mdInline("$" + sci(truth) + "$")}</span>` : "";
  etude.$(".es-verdict").innerHTML =
    `<div class="e-section-title">Actual</div><div class="es-actual">${etude.escape(fmt(truth) + unit)}${truthTex}</div>` +
    (!preview && words ? `<div class="es-words ${tone}">You said ${etude.escape(fmt(guess) + unit)}: ${etude.escape(words)}.</div>` : "");
});
