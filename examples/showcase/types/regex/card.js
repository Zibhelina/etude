const { view } = etude;
const pat = etude.$(".rx-pattern");
const flg = etude.$(".rx-flags");
const field = etude.$(".rx-field");
const status = etude.$(".rx-status");
flg.value = view.flags ?? "";

const tests = [
  ...view.match.map((s) => ({ s, want: true })),
  ...view.reject.map((s) => ({ s, want: false })),
];

// Show the string with spaces made visible and the matched span marked.
const strHtml = (s, span) => {
  if (s === "") return `<span class="rx-empty">empty string</span>`;
  const esc = (t) => etude.escape(t).replace(/ /g, `<span class="sp">·</span>`);
  if (!span || span[1] <= span[0]) return esc(s);
  return esc(s.slice(0, span[0])) + `<mark class="hit">${esc(s.slice(span[0], span[1]))}</mark>` + esc(s.slice(span[1]));
};
const row = (t, i) => `<li class="rx-test" data-i="${i}"><span class="rx-mark" aria-hidden="true"></span><code>${strHtml(t.s)}</code></li>`;
for (const kind of ["match", "reject"]) {
  etude.$(`.rx-list[data-kind="${kind}"]`).innerHTML = tests.map((t, i) => ((t.want === (kind === "match")) ? row(t, i) : "")).join("");
}
const rowEls = etude.$$(".rx-tests .rx-test");
const byIndex = Object.fromEntries(rowEls.map((li) => [li.dataset.i, li]));

const paint = (results) => {
  for (const [i, t] of tests.entries()) {
    const li = byIndex[i];
    li.classList.remove("pass", "fail");
    const r = results?.[i];
    li.querySelector("code").innerHTML = strHtml(t.s, view.mode === "find" && r?.got ? r.span : null);
    if (!r) continue;
    li.classList.add(r.got === t.want ? "pass" : "fail");
  }
};

// Matching runs in a worker so a pattern with catastrophic backtracking can't freeze the card.
const workerSrc = `onmessage = (e) => {
  const { id, pattern, flags, mode, strings } = e.data;
  let re;
  try { re = new RegExp(mode === "find" ? pattern : "^(?:" + pattern + ")$", flags); }
  catch (err) { postMessage({ id, error: String(err.message) }); return; }
  postMessage({ id, results: strings.map((s) => { re.lastIndex = 0; const m = re.exec(s); return { got: !!m, span: m ? [m.index, m.index + m[0].length] : null }; }) });
};`;
let worker = null;
const spawn = () => {
  try {
    worker = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: "text/javascript" })));
  } catch {
    worker = null;
  }
};
spawn();
const runInline = (pattern, flags) => {
  let re;
  try { re = new RegExp(view.mode === "find" ? pattern : `^(?:${pattern})$`, flags); }
  catch (err) { return { error: String(err.message) }; }
  return { results: tests.map((t) => { const m = re.exec(t.s); return { got: !!m, span: m ? [m.index, m.index + m[0].length] : null }; }) };
};

const ruleText = view.mode === "find" ? "A match anywhere in the string counts." : "The whole string has to match (no need for ^ and $).";
let seq = 0;
let timer = null;
const cleanFlags = () => [...new Set(flg.value.replace(/[^imsu]/g, ""))].join("");
// Engine messages repeat the pattern ("Invalid regular expression: /x/: Unterminated group"); keep the reason.
const reason = (m) => String(m).replace(/^Invalid regular expression: \/[\s\S]*\/[a-z]*: /, "").replace(/^Invalid regular expression: /, "");
const show = (res) => {
  if (res.error) {
    field.classList.add("bad");
    status.innerHTML = `<span class="err">${etude.escape(reason(res.error))}</span>`;
    paint(null);
    return;
  }
  field.classList.remove("bad");
  paint(res.results);
  const ok = res.results.filter((r, i) => r.got === tests[i].want).length;
  status.innerHTML = (ok === tests.length
    ? `<span class="all">All ${tests.length} visible tests pass.</span>`
    : `${ok} of ${tests.length} visible tests pass.`) + ` <span class="rule">${ruleText}</span>`;
};
// The pattern box grows with its content, so a long pattern stays fully visible.
const fit = () => { pat.style.height = "auto"; pat.style.height = `${pat.scrollHeight}px`; };
const evaluate = () => {
  // A pasted newline would make the pattern unreadable; keep it on one logical line.
  if (pat.value.includes("\n")) pat.value = pat.value.replace(/\n/g, "");
  fit();
  const pattern = pat.value;
  etude.setReady(pattern.length > 0 && etude.mode === "answer");
  if (!pattern) {
    field.classList.remove("bad");
    paint(null);
    status.innerHTML = `<span class="rule">${ruleText}</span>`;
    return;
  }
  const flags = cleanFlags();
  if (!worker) return show(runInline(pattern, flags));
  const id = ++seq;
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (id !== seq) return;
    worker.terminate();
    spawn();
    field.classList.add("bad");
    status.innerHTML = `<span class="err">Took too long: this pattern backtracks catastrophically.</span>`;
    paint(null);
  }, 400);
  worker.onmessage = (e) => {
    if (e.data.id !== seq) return;
    clearTimeout(timer);
    show(e.data);
  };
  worker.postMessage({ id, pattern, flags, mode: view.mode, strings: tests.map((t) => t.s) });
};

if (etude.answer && typeof etude.answer === "object") {
  pat.value = etude.answer.pattern ?? "";
  flg.value = etude.answer.flags ?? flg.value;
}
pat.addEventListener("input", evaluate);
flg.addEventListener("input", () => { flg.value = cleanFlags(); evaluate(); });
for (const el of [pat, flg]) el.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); if (pat.value) etude.submit(); }
});
evaluate();
etude.getAnswer(() => ({ pattern: pat.value, flags: cleanFlags() }));

etude.onResult(({ grade, key, answer }) => {
  pat.disabled = flg.disabled = true;
  if (answer && typeof answer === "object") { pat.value = answer.pattern ?? ""; flg.value = answer.flags ?? ""; }
  fit();
  const details = grade?.details;
  if (details?.tests) {
    paint(details.tests.slice(0, tests.length).map((t) => ({ got: t.got, span: null })));
    if (details.error) {
      field.classList.add("bad");
      status.innerHTML = `<span class="err">${etude.escape(reason(details.error))}</span>`;
    } else {
      status.textContent = `${details.right} of ${details.total} tests pass, hidden ones included.`;
    }
  } else if (!pat.value) status.textContent = "";
  const hidden = details?.tests ? details.tests.slice(tests.length) : [
    ...key.hidden.match.map((s) => ({ s, want: true, got: null })),
    ...key.hidden.reject.map((s) => ({ s, want: false, got: null })),
  ];
  if (!hidden.length) return;
  const li = (t) => `<li class="rx-test ${t.got == null ? "" : t.got === t.want ? "pass" : "fail"}"><span class="rx-mark" aria-hidden="true"></span><code>${strHtml(t.s)}</code></li>`;
  const col = (want, title) => {
    const items = hidden.filter((t) => t.want === want);
    return items.length ? `<div><div class="sub">${title}</div><ul class="rx-list">${items.map(li).join("")}</ul></div>` : "<div></div>";
  };
  etude.$(".rx-hidden-results").innerHTML = `<div class="e-section-title">Hidden tests</div><div class="rx-tests">${col(true, "Should match")}${col(false, "Should not match")}</div>`;
});
