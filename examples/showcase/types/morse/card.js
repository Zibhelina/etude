const mine = etude.$(".mo-mine");
const key = etude.$(".mo-key");
const del = etude.$(".mo-del");
if (etude.view.prosign) etude.$(".mo-letter").classList.add("is-prosign");
const MAX = 9; // the longest code here is SOS, ...---...
const HOLD = 220; // a press longer than this is a dash
let seq = typeof etude.answer === "string" ? etude.answer : "";
const sym = (s, cls = "") => `<i class="${s === "." ? "dot" : "dash"}${cls ? " " + cls : ""}"></i>`;
const touch = matchMedia("(pointer: coarse)").matches;
etude.$(".mo-hint-text").textContent = touch ? "Short tap for a dot, hold for a dash" : "Short press for a dot, hold for a dash · or type . and -";

const draw = (fresh) => {
  mine.innerHTML = seq ? [...seq].map((s, i) => sym(s, fresh && i === seq.length - 1 ? "new" : "")).join("") : `<span class="ph">dots and dashes appear here</span>`;
  mine.classList.toggle("long", seq.length > 6);
  del.classList.toggle("on", seq.length > 0);
  etude.setReady(seq.length > 0);
};
const press = (s) => {
  if (etude.mode !== "answer") return;
  seq = s === "del" ? seq.slice(0, -1) : (seq + s).slice(0, MAX);
  draw(s !== "del");
};

// The key: how long you hold it decides dot or dash, like a real straight key.
let down = 0;
key.addEventListener("pointerdown", (e) => {
  if (etude.mode !== "answer" || e.button > 0) return;
  down = performance.now();
  key.classList.add("down");
  try { key.setPointerCapture(e.pointerId); } catch {}
});
const up = (e, cancel) => {
  if (!down) return;
  const held = performance.now() - down;
  down = 0;
  key.classList.remove("down");
  // A long hold on a phone can end in pointercancel (the system's long-press); it still counts as a dash.
  if (!cancel || held >= HOLD) press(held < HOLD ? "." : "-");
};
key.addEventListener("pointerup", (e) => up(e, false));
key.addEventListener("pointercancel", (e) => up(e, true));
key.addEventListener("click", (e) => e.preventDefault());
key.addEventListener("contextmenu", (e) => e.preventDefault());
del.addEventListener("click", () => press("del"));

const flash = () => { key.classList.add("down"); setTimeout(() => key.classList.remove("down"), 110); };
window.addEventListener("keydown", (e) => {
  const s = { ".": ".", "-": "-", j: ".", k: "-", Backspace: "del" }[e.key];
  if (!s || etude.mode !== "answer" || e.ctrlKey || e.metaKey || e.altKey) return;
  e.preventDefault();
  press(s);
  if (s !== "del") flash();
});
draw(false);
etude.getAnswer(() => seq);

etude.onResult(({ grade, key: k, answer }) => {
  const sent = String(answer ?? seq ?? "").replace(/[^.-]/g, "");
  const code = String(k.code ?? "");
  const ok = (grade?.score ?? (sent === code ? 1 : 0)) >= 1;
  const right = etude.$(".mo-correct");
  right.innerHTML = [...code].map((s) => sym(s)).join("");
  right.classList.toggle("long", code.length > 6);
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) right.classList.add("blink");
  if (!ok) {
    const yours = etude.$(".mo-yours");
    yours.hidden = false;
    etude.$(".mo-sent").innerHTML = sent ? [...sent].map((s) => sym(s)).join("") : "nothing";
  }
});
