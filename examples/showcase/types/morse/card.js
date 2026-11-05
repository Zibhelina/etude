const mine = etude.$(".mo-mine");
if (etude.view.prosign) etude.$(".mo-letter").classList.add("is-prosign");
const MAX = 9; // the longest code here is SOS, ...---...
let seq = typeof etude.answer === "string" ? etude.answer : "";
const sym = (s, cls = "") => `<span class="mo-sym ${s === "." ? "dot" : "dash"} ${cls}"></span>`;

const draw = (fresh) => {
  mine.innerHTML = seq ? [...seq].map((s, i) => sym(s, fresh && i === seq.length - 1 ? "new" : "")).join("") : `<span class="mo-empty">Tap dot and dash</span>`;
  mine.classList.toggle("long", seq.length > 6);
  etude.setReady(seq.length > 0);
};
const press = (s) => {
  if (etude.mode !== "answer") return;
  seq = s === "del" ? seq.slice(0, -1) : (seq + s).slice(0, MAX);
  draw(s !== "del");
};
etude.$$(".mo-key").forEach((b) => b.addEventListener("click", () => press(b.dataset.s)));
window.addEventListener("keydown", (e) => {
  const s = { ".": ".", "-": "-", j: ".", k: "-", Backspace: "del" }[e.key];
  if (!s || etude.mode !== "answer") return;
  e.preventDefault();
  press(s);
  const b = etude.$(`.mo-key[data-s="${s}"]`);
  b?.classList.add("down");
  setTimeout(() => b?.classList.remove("down"), 120);
});
draw(false);
etude.getAnswer(() => seq);

etude.onResult(({ key, answer }) => {
  const sent = String(answer ?? "");
  const code = key.code;
  // Your taps, marked symbol by symbol; anything you left out shows faded.
  mine.innerHTML = [...sent].map((s, i) => sym(s, s === code[i] ? "is-ok" : "is-bad")).join("") +
    [...code.slice(sent.length)].map((s) => sym(s, "is-missed")).join("");
  mine.classList.toggle("long", Math.max(sent.length, code.length) > 6);
  const right = etude.$(".mo-correct");
  right.classList.toggle("long", code.length > 6);
  right.innerHTML = [...code].map((s) => sym(s)).join("");
  // Blink the right code on the lamp at Morse timing: dot 1 unit, dash 3, gaps 1, then a pause.
  const lamp = etude.$(".mo-lamp");
  const parts = etude.$$(".mo-correct .mo-sym");
  const U = 170;
  const loop = (i) => {
    if (!lamp.isConnected) return;
    if (i === code.length) return setTimeout(() => loop(0), 6 * U);
    lamp.classList.add("on"); parts[i].classList.add("lit");
    setTimeout(() => {
      lamp.classList.remove("on"); parts[i].classList.remove("lit");
      setTimeout(() => loop(i + 1), U);
    }, code[i] === "." ? U : 3 * U);
  };
  setTimeout(() => loop(0), 400);
});
