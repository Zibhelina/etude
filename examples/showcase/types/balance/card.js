const { view } = etude;
const nl = view.reactants.length;
const species = [...view.reactants, ...view.products];
const max = view.max;
// Digits after an element or a closing bracket are subscripts: Al2(SO4)3 → \mathrm{Al_2(SO_4)_3}.
const formulaTex = (f) => "\\mathrm{" + String(f).replace(/([A-Za-z)])(\d+)/g, "$1_{$2}") + "}";
const tex = (s) => etude.mdInline("$" + s + "$");
const chevron = (d) => `<svg viewBox="0 0 16 10" aria-hidden="true"><path d="${d > 0 ? "M3 7.5 8 2.5l5 5" : "M3 2.5 8 7.5l5-5"}"/></svg>`;

let coef = Array.isArray(etude.answer) && etude.answer.length === species.length ? etude.answer.map((x) => Math.max(1, Math.min(max, Number(x) || 1))) : species.map(() => 1);

// The equation: two sides that each stay on one line, so a narrow card breaks at the arrow.
const term = (f, k) => `
  <span class="bl-term" data-k="${k}">
    <span class="bl-coef-box">
      <button type="button" class="bl-step up" data-d="1" tabindex="-1" aria-label="More ${etude.escape(f)}">${chevron(1)}</button>
      <input class="bl-coef" inputmode="numeric" enterkeyhint="done" aria-label="Coefficient of ${etude.escape(f)}" value="${coef[k]}" autocomplete="off">
      <button type="button" class="bl-step down" data-d="-1" tabindex="-1" aria-label="Fewer ${etude.escape(f)}">${chevron(-1)}</button>
    </span>
    <span class="bl-formula">${tex(formulaTex(f))}</span>
  </span>`;
const side = (list, offset) => list.map((f, i) => (i ? `<span class="bl-plus">${tex("+")}</span>` : "") + term(f, offset + i)).join("");
const eq = etude.$(".bl-eq");
eq.innerHTML =
  `<span class="bl-side">${side(view.reactants, 0)}</span>` +
  `<span class="bl-side"><span class="bl-arrow">${tex("\\longrightarrow")}</span>${side(view.products, nl)}</span>`;
const inputs = etude.$$(".bl-coef");
const terms = etude.$$(".bl-term");

// The ledger: one row per element. The two counts meet in the middle around =, < or >, and a bar
// grows outward from each, so a balanced row is symmetric at a glance.
const ledger = etude.$(".bl-ledger");
ledger.innerHTML =
  `<div class="bl-row bl-head"><span class="el">Atom</span><span class="hl">Reactants</span><span class="rel">vs</span><span class="hr">Products</span></div>` +
  view.elements.map((e) => `
    <div class="bl-row" data-e="${etude.escape(e)}">
      <span class="el">${tex("\\mathrm{" + e + "}")}</span>
      <span class="track l"><i class="bar"></i></span>
      <span class="n l"></span>
      <span class="rel"></span>
      <span class="n r"></span>
      <span class="track r"><i class="bar"></i></span>
      <span class="st" aria-hidden="true"></span>
    </div>`).join("") +
  `<div class="bl-sum"></div>`;
const rows = etude.$$(".bl-row:not(.bl-head)");
const sum = etude.$(".bl-sum");
const CHECK = `<svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7"/></svg>`;

const count = () =>
  view.elements.map((e) => {
    let left = 0, right = 0;
    view.atoms.forEach((a, k) => (k < nl ? (left += (a[e] ?? 0) * coef[k]) : (right += (a[e] ?? 0) * coef[k])));
    return { e, left, right };
  });
const render = () => {
  inputs.forEach((el, k) => {
    if (document.activeElement !== el || el.value !== "") el.value = String(coef[k]);
    el.style.width = `${Math.max(1, String(coef[k]).length) * 0.52 + 0.42}em`;
    terms[k].classList.toggle("is-one", coef[k] === 1);
    terms[k].querySelector(".down").disabled = etude.mode !== "answer" || coef[k] <= 1;
    terms[k].querySelector(".up").disabled = etude.mode !== "answer" || coef[k] >= max;
  });
  const t = count();
  const scale = Math.max(1, ...t.map((x) => Math.max(x.left, x.right)));
  let ok = 0;
  t.forEach((x, i) => {
    const r = rows[i], good = x.left === x.right;
    ok += good;
    r.classList.toggle("ok", good);
    r.classList.toggle("more-l", x.left > x.right);
    r.classList.toggle("more-r", x.right > x.left);
    r.querySelector(".n.l").textContent = x.left;
    r.querySelector(".n.r").textContent = x.right;
    r.querySelector(".track.l .bar").style.width = `${(x.left / scale) * 100}%`;
    r.querySelector(".track.r .bar").style.width = `${(x.right / scale) * 100}%`;
    r.querySelector(".rel").textContent = good ? "=" : x.left < x.right ? "<" : ">";
    r.querySelector(".st").innerHTML = good ? CHECK : "";
    r.setAttribute("aria-label", `${x.e}: ${x.left} on the left, ${x.right} on the right${good ? ", balanced" : ""}`);
  });
  const done = ok === t.length;
  ledger.classList.toggle("all-ok", done);
  sum.textContent = done ? "Every element balances." : `${ok} of ${t.length} balanced.`;
};
const set = (k, v) => {
  if (etude.mode !== "answer") return;
  coef[k] = Math.max(1, Math.min(max, Math.round(v) || 1));
  render();
};

eq.addEventListener("click", (e) => {
  const b = e.target.closest(".bl-step");
  if (!b || b.disabled) return;
  const k = Number(b.closest(".bl-term").dataset.k);
  set(k, coef[k] + Number(b.dataset.d));
});
// A tap on the formula focuses its coefficient, so the whole term is a target.
eq.addEventListener("pointerdown", (e) => {
  const f = e.target.closest(".bl-formula");
  if (!f || etude.mode !== "answer") return;
  e.preventDefault();
  f.closest(".bl-term").querySelector(".bl-coef").focus();
});
inputs.forEach((el, k) => {
  el.addEventListener("input", () => {
    const v = el.value.replace(/\D/g, "").slice(0, 2);
    el.value = v;
    if (v) set(k, Number(v));
  });
  el.addEventListener("blur", render);
  el.addEventListener("focus", () => el.select());
  el.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      set(k, coef[k] + (e.key === "ArrowUp" ? 1 : -1));
      el.select();
    } else if (e.key === "ArrowRight" && el.selectionStart === el.value.length) {
      e.preventDefault();
      inputs[(k + 1) % inputs.length].focus();
    } else if (e.key === "ArrowLeft" && el.selectionStart === 0) {
      e.preventDefault();
      inputs[(k - 1 + inputs.length) % inputs.length].focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      etude.submit();
    }
  });
});

render();
etude.getAnswer(() => coef.slice());

etude.onResult(({ grade, key, answer }) => {
  const preview = document.body.dataset.preview === "1";
  const sol = key.solution;
  const given = Array.isArray(answer) && answer.length === species.length;
  // A preview with no attempt shows the balanced equation itself.
  coef = given ? answer.map(Number) : sol.slice();
  inputs.forEach((el) => (el.disabled = true));
  render();
  const d = grade?.details ?? {};
  const state = preview || !given ? "" : grade?.score >= 1 ? "right" : d.balanced ? "near" : "wrong";
  if (state) eq.classList.add(state);
  if (state === "near") {
    ledger.classList.add("near");
    sum.textContent = `Every element balances, but every coefficient divides by ${d.divisor}.`;
  }
  if (state === "wrong" || state === "near") terms.forEach((t, k) => t.classList.toggle("off", coef[k] !== sol[k]));
  // The balanced equation, typeset; coefficients that differ from the learner's are marked.
  const mark = state === "wrong" || state === "near";
  const piece = (k) => {
    const c = sol[k], hit = mark && c !== coef[k];
    const n = c === 1 && !hit ? "" : `<span class="c${hit ? " hit" : ""}">${c}</span>`;
    return `<span class="t">${n}${tex(formulaTex(species[k]))}</span>`;
  };
  const half = (from, to) => [...Array(to - from).keys()].map((i) => (i ? `<span class="op">${tex("+")}</span>` : "") + piece(from + i)).join("");
  // Right answers are already on screen above; say so instead of repeating the equation.
  if (state === "right") {
    etude.$(".bl-answer").innerHTML = `<p class="bl-note ok">${CHECK}Balanced, with the smallest whole numbers.</p>`;
    return;
  }
  etude.$(".bl-answer").innerHTML =
    `<div class="e-section-title">${state === "near" ? "In lowest terms" : "The balanced equation"}</div>` +
    `<div class="bl-final"><span class="s">${half(0, nl)}</span><span class="s"><span class="op">${tex("\\longrightarrow")}</span>${half(nl, species.length)}</span></div>` +
    (state === "near" ? `<p class="bl-note">Divide each of yours by ${d.divisor}.</p>` : "") +
    (state === "wrong" ? `<p class="bl-note">The numbers in pink are where yours differed.</p>` : "");
});
