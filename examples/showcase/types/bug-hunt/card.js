const { view } = etude;
const box = etude.$(".bh-lines");
const raw = view.code.split("\n");
const need = view.count;
etude.$(".bh-ask").innerHTML = need === 1 ? "Pick <b>the line</b> with the bug." : `Pick <b>${need} lines</b>: the bug spans more than one.`;

// Split highlighted HTML into lines, reopening any span that crosses a newline.
const splitHtml = (html) => {
  const out = [];
  let open = [];
  for (const line of html.split("\n")) {
    let s = open.join("");
    for (const m of line.matchAll(/<\/?span\b[^>]*>/g)) {
      if (m[0].startsWith("</")) open.pop();
      else open.push(m[0]);
    }
    s += line + "</span>".repeat(open.length);
    out.push(s);
  }
  return out;
};
let lineHtml = raw.map((l) => etude.escape(l));
if (typeof etude.highlight === "function") {
  try {
    const html = await etude.highlight(view.code, view.language);
    const split = splitHtml(String(html));
    if (split.length === raw.length) lineHtml = split;
  } catch { /* keep plain text */ }
}
// Leading indentation sits in its own span, so a strike-through only covers the code itself.
const body = (html) => {
  const m = String(html).match(/^[ \t]*/)[0];
  return `<span class="ind">${m}</span><span class="txt">${String(html).slice(m.length) || " "}</span>`;
};
const row = (n, html, cls = "") => `<div class="bh-line ${cls}" data-n="${n}" role="option" aria-selected="false" tabindex="-1"><span class="ln">${n}</span><span class="src">${body(html)}</span></div>`;
box.innerHTML = lineHtml.map((h, i) => row(i + 1, h)).join("");
const lines = etude.$$(".bh-line");
lines[0].tabIndex = 0;

const picked = new Set(Array.isArray(etude.answer) ? etude.answer.map(Number) : []);
const paint = () => {
  for (const el of lines) {
    const on = picked.has(Number(el.dataset.n));
    el.classList.toggle("picked", on);
    el.setAttribute("aria-selected", String(on));
  }
  etude.setReady(etude.mode === "answer" && picked.size > 0);
};
const toggle = (n) => {
  if (etude.mode !== "answer") return;
  if (picked.has(n)) picked.delete(n);
  else {
    // Picking past the limit replaces the oldest choice.
    if (picked.size >= need) picked.delete(picked.values().next().value);
    picked.add(n);
  }
  paint();
};
box.addEventListener("click", (e) => {
  const el = e.target.closest(".bh-line");
  if (el && !el.classList.contains("fixline")) toggle(Number(el.dataset.n));
});
box.addEventListener("keydown", (e) => {
  const el = e.target.closest(".bh-line");
  if (!el || etude.mode !== "answer" || e.ctrlKey || e.metaKey || e.altKey) return;
  const i = lines.indexOf(el);
  const go = (j) => { if (lines[j]) { el.tabIndex = -1; lines[j].tabIndex = 0; lines[j].focus(); } };
  if (e.key === "ArrowDown") { e.preventDefault(); go(i + 1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); go(i - 1); }
  else if (e.key === " " || (e.key === "Enter" && !picked.size)) { e.preventDefault(); toggle(Number(el.dataset.n)); }
});
paint();
etude.getAnswer(() => [...picked].sort((a, b) => a - b));

etude.onResult(async ({ key, answer }) => {
  if (Array.isArray(answer)) { picked.clear(); answer.forEach((n) => picked.add(Number(n))); }
  const bugs = new Set(key.bugs);
  for (const el of lines) {
    const n = Number(el.dataset.n);
    el.removeAttribute("tabindex");
    el.classList.remove("picked");
    if (bugs.has(n) && picked.has(n)) el.classList.add("r-right");
    else if (picked.has(n)) el.classList.add("r-wrong");
    else if (bugs.has(n)) el.classList.add("r-missed");
    if (bugs.has(n) && key.fix?.[n] != null) el.classList.add("r-bug");
  }
  // The fixed version goes right under each bug line.
  for (const n of key.bugs) {
    const fix = key.fix?.[n];
    if (fix == null) continue;
    let html = etude.escape(fix);
    if (typeof etude.highlight === "function") {
      try { html = splitHtml(String(await etude.highlight(String(fix), view.language)))[0] ?? html; } catch { /* plain */ }
    }
    const el = lines[n - 1];
    el?.insertAdjacentHTML("afterend", row("+", html, "fixline").replace('tabindex="-1"', "").replace('role="option" aria-selected="false"', 'aria-label="Fixed line"'));
  }
});
