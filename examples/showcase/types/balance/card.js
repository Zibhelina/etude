const { view } = etude;
const nl = view.reactants.length;
const species = [...view.reactants, ...view.products];
const max = view.max;
// Digits after an element or a closing bracket are subscripts: Al2(SO4)3 → \mathrm{Al_2(SO_4)_3}.
const formulaTex = (f) => "\\mathrm{" + String(f).replace(/([A-Za-z)])(\d+)/g, "$1_{$2}") + "}";
const tex = (s) => etude.mdInline("$" + s + "$");

let coef = Array.isArray(etude.answer) && etude.answer.length === species.length ? etude.answer.map((x) => Math.max(1, Math.min(max, Number(x) || 1))) : species.map(() => 1);

const eq = etude.$(".bl-eq");
const parts = [];
species.forEach((f, k) => {
  if (k === nl) parts.push(`<span class="bl-op arrow">${tex("\\longrightarrow")}</span>`);
  else if (k > 0) parts.push(`<span class="bl-op">${tex("+")}</span>`);
  parts.push(`
    <div class="bl-term" data-k="${k}">
      <button type="button" class="bl-step up" data-d="1" aria-label="More ${etude.escape(f)}">+</button>
      <div class="bl-mid">
        <input class="bl-coef" inputmode="numeric" aria-label="Coefficient of ${etude.escape(f)}" value="${coef[k]}" autocomplete="off">
        <span class="bl-formula">${tex(formulaTex(f))}</span>
      </div>
      <button type="button" class="bl-step down" data-d="-1" aria-label="Fewer ${etude.escape(f)}">\u2212</button>
    </div>`);
});
eq.innerHTML = parts.join("");
const inputs = etude.$$(".bl-coef");

const tallyBox = etude.$(".bl-tally");
const count = () =>
  view.elements.map((e) => {
    let left = 0, right = 0;
    view.atoms.forEach((a, k) => (k < nl ? (left += (a[e] ?? 0) * coef[k]) : (right += (a[e] ?? 0) * coef[k])));
    return { e, left, right };
  });
const render = () => {
  inputs.forEach((el, k) => {
    if (document.activeElement !== el || el.value !== "") el.value = String(coef[k]);
    el.closest(".bl-term").classList.toggle("is-one", coef[k] === 1);
    el.closest(".bl-term").querySelector(".down").disabled = etude.mode !== "answer" || coef[k] <= 1;
    el.closest(".bl-term").querySelector(".up").disabled = etude.mode !== "answer" || coef[k] >= max;
  });
  const t = count();
  const done = t.every((x) => x.left === x.right);
  tallyBox.innerHTML =
    `<div class="bl-tally-head"><span>${done ? "Every element balances" : "Atoms, left vs right"}</span></div>` +
    `<div class="bl-chips">${t
      .map((x) => {
        const cls = x.left === x.right ? "ok" : "";
        const tilt = Math.max(-1, Math.min(1, (x.right - x.left) / Math.max(x.left, x.right, 1)));
        return `<div class="bl-chip ${cls}" style="--tilt:${tilt}">
          <span class="n">${x.left}</span>
          <span class="el">${tex("\\mathrm{" + x.e + "}")}<i class="beam"></i></span>
          <span class="n">${x.right}</span>
        </div>`;
      })
      .join("")}</div>`;
  tallyBox.classList.toggle("all-ok", done);
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
  if (Array.isArray(answer) && answer.length === species.length) coef = answer.map(Number);
  inputs.forEach((el) => (el.disabled = true));
  render();
  const preview = document.body.dataset.preview === "1";
  const sol = key.solution;
  if (!preview) {
    const d = grade?.details ?? {};
    eq.classList.add(grade?.score >= 1 ? "right" : d.balanced ? "near" : "wrong");
  }
  const show = sol.map((c, k) => (c === 1 ? "" : c + "\\,") + formulaTex(species[k]));
  const left = show.slice(0, nl).join(" + "), right = show.slice(nl).join(" + ");
  const same = !preview && grade?.score >= 1;
  etude.$(".bl-answer").innerHTML =
    `<div class="e-section-title">${same ? "Balanced" : "Balanced with the smallest whole numbers"}</div>` +
    `<div class="bl-final">${etude.md("$$" + left + " \\longrightarrow " + right + "$$")}</div>`;
});
