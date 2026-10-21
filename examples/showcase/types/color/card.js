const sliders = Object.fromEntries(etude.$$(".co-slider").map((el) => [el.dataset.k, el.querySelector("input")]));
const mine = etude.$(".co-swatch.mine");
const start = etude.answer && [etude.answer.h, etude.answer.s, etude.answer.l].every(Number.isFinite) ? etude.answer : { h: 180, s: 0, l: 50 };
sliders.h.value = start.h;
sliders.s.value = start.s;
sliders.l.value = start.l;
let touched = !!etude.answer;

const val = () => ({ h: Number(sliders.h.value), s: Number(sliders.s.value), l: Number(sliders.l.value) });
const css = ({ h, s, l }) => `hsl(${h} ${s}% ${l}%)`;
// Track gradients show where each slider would take the color, given the other two.
const paint = () => {
  const v = val();
  mine.style.background = css(v);
  const hues = [0, 60, 120, 180, 240, 300, 360].map((h) => css({ h, s: Math.max(v.s, 25), l: Math.min(Math.max(v.l, 30), 70) })).join(", ");
  sliders.h.style.setProperty("--track", `linear-gradient(90deg, ${hues})`);
  sliders.s.style.setProperty("--track", `linear-gradient(90deg, ${css({ ...v, s: 0 })}, ${css({ ...v, s: 100 })})`);
  sliders.l.style.setProperty("--track", `linear-gradient(90deg, #000, ${css({ ...v, l: 50 })}, #fff)`);
  for (const [k, el] of Object.entries(sliders)) el.style.setProperty("--thumb", css(v));
};
for (const el of Object.values(sliders)) {
  el.addEventListener("input", () => {
    touched = true;
    paint();
    etude.setReady(true);
  });
  el.addEventListener("keydown", (e) => {
    if (!e.shiftKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const d = e.key === "ArrowRight" || e.key === "ArrowUp" ? 10 : -10;
    el.value = String(Math.max(Number(el.min), Math.min(Number(el.max), Number(el.value) + d)));
    el.dispatchEvent(new Event("input"));
  });
}
paint();
etude.setReady(touched);
etude.getAnswer(() => val());

function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}
const hex = (rgb) => "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();

etude.onResult(({ grade, key, answer }) => {
  const a = answer && Number.isFinite(answer.h) ? answer : val();
  sliders.h.value = a.h; sliders.s.value = a.s; sliders.l.value = a.l;
  paint();
  for (const el of Object.values(sliders)) el.disabled = true;
  const [th, ts, tl] = key.hsl;
  const target = etude.$(".co-swatch.target");
  target.style.background = `rgb(${key.rgb.join(" ")})`;
  etude.$(".co-swatches").classList.add("both");
  const preview = document.body.dataset.preview === "1";
  const myHex = hex(hslToRgb(a.h, a.s, a.l));

  // Target positions on each slider, as small ticks.
  for (const [k, v, max] of [["h", th, 359], ["s", ts, 100], ["l", tl, 100]]) {
    const wrap = etude.$(`.co-slider[data-k="${k}"]`);
    const tick = document.createElement("i");
    tick.className = "co-tick";
    tick.style.left = `calc(${(v / max) * 100}% + ${(0.5 - v / max) * 1.4}rem)`;
    wrap.querySelector("input").after(tick);
  }

  if (preview) {
    mine.style.background = `rgb(${key.rgb.join(" ")})`;
    mine.querySelector(".co-cap").textContent = "Target";
    target.remove();
    etude.$(".co-swatches").classList.remove("both");
  } else mine.querySelector(".co-cap").textContent = "Yours · " + myHex;

  const d = grade?.details ?? {};
  const v = etude.$(".co-verdict");
  if (preview) v.innerHTML = etude.md(`$\\mathrm{hsl}(${th}^\\circ,\\ ${ts}\\%,\\ ${tl}\\%)$`);
  else {
    const tone = grade.score >= 1 ? "good" : grade.score > 0 ? "near" : "far";
    const words = d.notes?.length ? d.notes.join(", ") : grade.score >= 1 ? "nothing a quick glance would notice" : "";
    v.innerHTML = `<div class="co-big ${tone}">${etude.escape(d.verdict ?? "")}</div><div class="e-muted">${etude.escape(words.charAt(0).toUpperCase() + words.slice(1))}${words ? "." : ""}</div>`;
    etude.$(".co-compare").innerHTML = etude.md(
      `| | hue | saturation | lightness |\n|---|---|---|---|\n| target | $${th}^\\circ$ | $${ts}\\%$ | $${tl}\\%$ |\n| yours | $${a.h}^\\circ$ | $${a.s}\\%$ | $${a.l}\\%$ |\n\nDistance in OKLab: $\\Delta E = ${d.dE}$ (full credit up to $0.05$, nothing past $0.22$).`,
    );
    etude.$(".co-compare").classList.add("prose");
  }
});
