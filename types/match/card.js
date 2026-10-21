const { view } = etude;
const L = etude.$(".left"), R = etude.$(".right"), svg = etude.$(".wires"), board = etude.$(".board");
const chip = (side, o, i) => `<button type="button" class="e-option chip" data-side="${side}" data-id="${o.id}"><span class="e-key">${side === "l" ? i + 1 : String.fromCharCode(97 + i)}</span><span class="prose">${etude.md(o.text)}</span></button>`;
L.innerHTML = view.left.map((o, i) => chip("l", o, i)).join("");
R.innerHTML = view.right.map((o, i) => chip("r", o, i)).join("");
const links = new Map(Object.entries(etude.answer && typeof etude.answer === "object" ? etude.answer : {}));
let picked = null;
const el = (id) => board.querySelector(`[data-id="${id}"]`);
const COLORS = ["#f472b6", "#60a5fa", "#facc15", "#4ade80", "#c084fc", "#fb923c", "#2dd4bf", "#f87171", "#a3e635", "#e879f9"];
const colorOf = (lid) => COLORS[view.left.findIndex((o) => o.id === lid) % COLORS.length];

function draw(marks) {
  const box = board.getBoundingClientRect();
  svg.setAttribute("viewBox", `0 0 ${svg.clientWidth} ${box.height}`);
  svg.style.height = box.height + "px";
  const sb = svg.getBoundingClientRect();
  let paths = "";
  for (const [l, r] of links) {
    const a = el(l).getBoundingClientRect(), b = el(r).getBoundingClientRect();
    const y1 = a.top + a.height / 2 - sb.top, y2 = b.top + b.height / 2 - sb.top, w = sb.width;
    const stroke = marks ? (marks[l] ? "var(--success)" : "var(--danger)") : colorOf(l);
    paths += `<path d="M0 ${y1} C ${w / 2} ${y1}, ${w / 2} ${y2}, ${w} ${y2}" stroke="${stroke}" stroke-width="2" fill="none" stroke-linecap="round"/>`;
  }
  svg.innerHTML = paths;
  board.querySelectorAll(".chip").forEach((c) => {
    const id = c.dataset.id;
    const lid = c.dataset.side === "l" ? (links.has(id) ? id : null) : [...links].find(([, r]) => r === id)?.[0];
    c.style.setProperty("--wire", lid ? colorOf(lid) : "transparent");
    c.classList.toggle("linked", !!lid);
    c.classList.toggle("is-selected", picked === id);
  });
  etude.setReady(links.size === view.left.length);
}

board.addEventListener("click", (e) => {
  const c = e.target.closest(".chip");
  if (!c || etude.mode !== "answer") return;
  const { side, id } = c.dataset;
  if (side === "l") {
    if (links.has(id)) { links.delete(id); picked = null; }
    else picked = picked === id ? null : id;
  } else {
    const owner = [...links].find(([, r]) => r === id)?.[0];
    if (owner) links.delete(owner);
    else if (picked) { links.set(picked, id); picked = null; }
  }
  draw();
});
window.addEventListener("keydown", (e) => {
  if (etude.mode !== "answer" || e.ctrlKey || e.metaKey || e.altKey) return;
  const n = Number(e.key);
  if (n >= 1 && n <= view.left.length) { el(view.left[n - 1].id).click(); e.preventDefault(); }
  const k = e.key.charCodeAt(0) - 97;
  if (e.key.length === 1 && k >= 0 && k < view.right.length) { el(view.right[k].id).click(); e.preventDefault(); }
  if (e.key === "Enter" && links.size === view.left.length) { e.preventDefault(); etude.submit(); }
});
new ResizeObserver(() => draw(etude.result?.grade?.details?.marks)).observe(board);
etude.getAnswer(() => Object.fromEntries(links));
draw();
etude.onResult(({ grade, key }) => {
  const marks = grade.details?.marks ?? {};
  board.querySelectorAll(".chip").forEach((c) => (c.disabled = true));
  for (const [l, ok] of Object.entries(marks)) {
    el(l).classList.add(ok ? "is-correct" : "is-wrong");
    if (!ok) {
      const fix = document.createElement("span");
      fix.className = "e-why fix";
      fix.innerHTML = "→ " + etude.mdInline(key.text[key.pairs[l]]);
      el(l).querySelector(".prose").append(fix);
    }
  }
  draw(marks);
});
