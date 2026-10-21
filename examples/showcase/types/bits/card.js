const { view } = etude;
const w = view.width;
const place = (i) => {
  // i counts from the left (most significant). In two's complement the top bit is worth -2^(w-1).
  const p = 2 ** (w - 1 - i);
  return view.signed && i === 0 ? -p : p;
};
const valueOf = (bits) => bits.reduce((s, b, i) => s + (b ? place(i) : 0), 0);
const hexOf = (bits) => "0x" + parseInt(bits.map(Number).join(""), 2).toString(16).toUpperCase().padStart(Math.ceil(w / 4), "0");
const fmtPlace = (v) => (v < 0 ? "−" + Math.abs(v) : String(v));

etude.$(".bt-ask").innerHTML = view.signed
  ? `Make this number in ${w}-bit two's complement:<span class="num">${fmtPlace(view.target)}</span><span class="sub">The top bit is worth ${fmtPlace(place(0))}.</span>`
  : `Set the switches to make<span class="num">${view.target}</span><span class="sub">${w} bits, unsigned.</span>`;

const build = (row, bits, interactive, hex = false) => {
  const groups = [];
  // Nibbles from the right, so 12 bits read 4-4-4 and 6 bits read 2-4.
  let i = w;
  while (i > 0) { groups.unshift([Math.max(0, i - 4), i]); i -= 4; }
  // With hex on, each nibble gets its hex digit underneath: that's the whole trick of hex.
  const digit = ([a, b]) => parseInt(bits.slice(a, b).map(Number).join(""), 2).toString(16).toUpperCase();
  row.innerHTML = groups.map(([a, b]) => `${hex ? '<div class="bt-nib-wrap">' : ""}<div class="bt-nib">${Array.from({ length: b - a }, (_, k) => {
    const j = a + k;
    return `<button type="button" class="bt-bit${place(j) < 0 ? " neg" : ""}" data-i="${j}" aria-pressed="${bits[j]}" aria-label="Bit worth ${fmtPlace(place(j))}" ${interactive ? "" : 'tabindex="-1"'}>
      <span class="pv">${fmtPlace(place(j))}</span><span class="v">${bits[j] ? 1 : 0}</span><span class="led"></span></button>`;
  }).join("")}</div>${hex ? `<span class="bt-hexdigit">${digit([a, b])}</span></div>` : ""}`).join("");
  return [...row.querySelectorAll(".bt-bit")];
};

let bits = Array(w).fill(false);
if (typeof etude.answer === "string" && etude.answer.length === w) bits = [...etude.answer].map((c) => c === "1");
const row = etude.$(".bt-attempt");
const btns = build(row, bits, true);
const total = etude.$(".bt-total");
let touched = bits.some(Boolean);

const paint = () => {
  btns.forEach((b, i) => { b.setAttribute("aria-pressed", String(bits[i])); b.querySelector(".v").textContent = bits[i] ? "1" : "0"; });
  if (view.showTotal || etude.mode !== "answer") total.innerHTML = `<span class="u">= <b>${fmtPlace(valueOf(bits))}</b></span> <span class="u"><span class="t">hex</span> ${hexOf(bits)}</span>`;
  else total.textContent = "";
  etude.setReady(etude.mode === "answer" && touched);
};
const set = (i, v) => {
  if (etude.mode !== "answer") return;
  bits[i] = v;
  touched = true;
  paint();
};
row.addEventListener("click", (e) => {
  const b = e.target.closest(".bt-bit");
  if (b) set(Number(b.dataset.i), !bits[Number(b.dataset.i)]);
});
row.addEventListener("keydown", (e) => {
  const b = e.target.closest(".bt-bit");
  // Ctrl/Cmd+Enter belongs to the app (submit); don't let it toggle the focused bit.
  if (!b || etude.mode !== "answer" || e.ctrlKey || e.metaKey || e.altKey) return;
  const i = Number(b.dataset.i);
  if (e.key === "ArrowRight") { e.preventDefault(); btns[i + 1]?.focus(); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); btns[i - 1]?.focus(); }
  else if (e.key === "0" || e.key === "1") { e.preventDefault(); set(i, e.key === "1"); btns[i + 1]?.focus(); }
  else if (e.key === " " || e.key === "Enter") { e.preventDefault(); set(i, !bits[i]); }
});
paint();
etude.getAnswer(() => bits.map(Number).join(""));

etude.onResult(({ key, answer }) => {
  const attempted = typeof answer === "string" && answer.length === w;
  if (attempted) bits = [...answer].map((c) => c === "1");
  const truth = [...key.pattern].map((c) => c === "1");
  // Previews (Browse, the type editor) have no attempt: show only the answer.
  if (!attempted) {
    row.closest(".bt-board").hidden = true;
  }
  btns.forEach((b, i) => { b.disabled = true; b.classList.toggle("off-by", attempted && bits[i] !== truth[i]); });
  paint();
  const right = bits.every((v, i) => v === truth[i]);
  total.classList.add(right ? "right" : "wrong");
  row.classList.toggle("all-right", right);
  // A wrong attempt shows its own sum, so the missing or extra term is easy to spot.
  if (!right) {
    const mine = bits.map((v, i) => (v ? place(i) : null)).filter((v) => v !== null);
    const terms = mine.map((v, k) => (v < 0 ? `<span class="neg">${fmtPlace(v)}</span>` : k === 0 ? v : ` + ${v}`)).join("") || "0";
    total.innerHTML = `<div class="u">${terms} = <b>${fmtPlace(valueOf(bits))}</b></div><div class="u"><span class="t">hex</span> ${hexOf(bits)}</div>`;
  }
  if (attempted && right) {
    // Nothing to compare: the attempt row gets the hex digits and the second row goes.
    build(row, bits, false, true).forEach((b) => (b.disabled = true));
    etude.$(".bt-truth").hidden = true;
    etude.$(".bt-truth-wrap .e-section-title").textContent = "Why it works";
  } else build(etude.$(".bt-truth"), truth, false, true).forEach((b) => (b.disabled = true));
  const terms = truth.map((v, i) => (v ? place(i) : null)).filter((v) => v !== null);
  const sum = terms.map((v, k) => (v < 0 ? `<span class="neg">${fmtPlace(v)}</span>` : k === 0 ? v : ` + ${v}`)).join("");
  etude.$(".bt-sum").innerHTML =
    `<div class="eq">${sum || "0"} = <b>${fmtPlace(view.target)}</b></div>` +
    (attempted && right ? "" : `<div class="hex"><span class="t">hex</span> <b>${hexOf(truth)}</b></div>`);
});
