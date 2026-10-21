const list = etude.$(".blocks");
let blocks = etude.view.blocks.slice();
if (Array.isArray(etude.answer)) {
  const byId = Object.fromEntries(blocks.map((b) => [b.id, b]));
  blocks = etude.answer.map((id) => byId[id]).filter(Boolean);
}
const render = () => {
  list.innerHTML = blocks.map((b, i) => `
    <li class="block" data-id="${b.id}" tabindex="0">
      <span class="grip" aria-hidden="true">⋮⋮</span>
      <span class="num">${i + 1}</span>
      <span class="prose">${etude.md(b.text)}</span>
    </li>`).join("");
};
render();
etude.getAnswer(() => blocks.map((b) => b.id));

const move = (from, to) => {
  if (to < 0 || to >= blocks.length || from === to) return;
  const [b] = blocks.splice(from, 1);
  blocks.splice(to, 0, b);
  render();
};

list.addEventListener("keydown", (e) => {
  const li = e.target.closest(".block");
  if (!li || etude.mode !== "answer") return;
  const i = blocks.findIndex((b) => b.id === li.dataset.id);
  if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    e.preventDefault();
    const j = e.key === "ArrowUp" ? i - 1 : i + 1;
    move(i, j);
    list.querySelector(`[data-id="${li.dataset.id}"]`)?.focus();
  } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    e.preventDefault();
    list.children[e.key === "ArrowUp" ? i - 1 : i + 1]?.focus();
  }
});

// Pointer dragging: the dragged block follows the pointer, the others make room.
let drag = null;
list.addEventListener("pointerdown", (e) => {
  const li = e.target.closest(".block");
  if (!li || etude.mode !== "answer" || e.button !== 0) return;
  e.preventDefault();
  const rects = [...list.children].map((c) => c.getBoundingClientRect());
  drag = { id: li.dataset.id, li, startY: e.clientY, rects, from: [...list.children].indexOf(li), to: null };
  li.setPointerCapture(e.pointerId);
  li.classList.add("dragging");
});
list.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dy = e.clientY - drag.startY;
  drag.li.style.transform = `translateY(${dy}px)`;
  const center = drag.rects[drag.from].top + drag.rects[drag.from].height / 2 + dy;
  let to = drag.rects.findIndex((r) => center < r.top + r.height / 2);
  if (to === -1) to = drag.rects.length - 1;
  else if (to > drag.from) to -= 1;
  drag.to = to;
  const h = drag.rects[drag.from].height + 8;
  [...list.children].forEach((c, i) => {
    if (c === drag.li) return;
    let shift = 0;
    if (drag.from < to && i > drag.from && i <= to) shift = -h;
    if (drag.from > to && i >= to && i < drag.from) shift = h;
    c.style.transform = shift ? `translateY(${shift}px)` : "";
  });
});
const end = () => {
  if (!drag) return;
  const { from, to } = drag;
  drag = null;
  if (to != null) move(from, to);
  else render();
};
list.addEventListener("pointerup", end);
list.addEventListener("pointercancel", end);

etude.onResult(({ grade, key }) => {
  const pos = Object.fromEntries(key.order.map((id, i) => [id, i]));
  const inRun = new Set(grade.details?.inOrder ?? []);
  list.querySelectorAll(".block").forEach((li, i) => {
    li.removeAttribute("tabindex");
    li.classList.add(pos[li.dataset.id] === i ? "is-correct" : inRun.has(li.dataset.id) ? "near" : "is-wrong");
  });
  etude.$(".solution").innerHTML = key.steps.map((s) => `<li class="prose">${etude.md(s)}</li>`).join("");
});
