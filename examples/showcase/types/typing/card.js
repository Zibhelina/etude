const { view } = etude;
const words = (view.words ?? []).map(String);
const timed = Number(view.seconds) > 0;
const total = timed ? view.seconds * 1000 : 0;
const last = words.length - 1;
const r2 = (x) => Math.round(x * 100) / 100;

// Same definitions as the grader: WPM counts correct words and the spaces after them, raw counts every key.
function measure(typed, cur, current, ms, complete) {
  let chars = 0;
  for (let i = 0; i < cur; i++) if (typed[i] === words[i]) chars += words[i].length + (i < last ? 1 : 0);
  if (cur <= last && current) {
    if (complete && current === words[cur]) chars += current.length;
    else if (words[cur].startsWith(current)) chars += Array.from(current).length;
  }
  return ms > 0 ? chars / 5 / (ms / 60000) : 0;
}

if (etude.mode === "answer") {
  const stage = etude.$(".ty-stage");
  const box = etude.$(".ty-box");
  const holder = etude.$(".ty-words");
  const input = etude.$(".ty-input");
  const live = etude.$(".ty-live");
  const speed = etude.$(".ty-speed");

  let typed, cur, current, keys, started, finished, t0, history, secChars, secErr, nextSec, timer, endTimer;
  let track, caret, wordEls, caretIdle = 0;

  const build = () => {
    holder.innerHTML = "";
    track = document.createElement("div");
    track.className = "ty-track";
    wordEls = words.map((w) => {
      const el = document.createElement("div");
      el.className = "w";
      el.innerHTML = Array.from(w).map((c) => `<span class="l">${etude.escape(c)}</span>`).join("");
      track.appendChild(el);
      return el;
    });
    caret = document.createElement("div");
    caret.className = "ty-caret";
    track.appendChild(caret);
    holder.appendChild(track);
  };

  const reset = () => {
    clearInterval(timer);
    clearTimeout(endTimer);
    typed = [];
    cur = 0;
    current = "";
    keys = { correct: 0, incorrect: 0 };
    started = false;
    finished = false;
    t0 = 0;
    history = [];
    secChars = 0;
    secErr = 0;
    nextSec = 1;
    input.value = "";
    input.disabled = false;
    stage.classList.remove("done");
    build();
    paint();
    live.classList.remove("on");
    live.textContent = timed ? String(view.seconds) : `0/${words.length}`;
    speed.textContent = "";
    etude.setReady(false);
  };

  // Redraws the current word, moves the caret and scrolls so the active line is the second one.
  const paint = (prev) => {
    for (const i of new Set([prev, cur].filter((x) => x !== undefined && x <= last))) {
      const w = Array.from(words[i]);
      const a = Array.from(i === cur ? current : typed[i] ?? "");
      const done = i < cur;
      let html = "";
      for (let j = 0; j < Math.max(w.length, a.length); j++) {
        if (j >= w.length) html += `<span class="l extra">${etude.escape(a[j])}</span>`;
        else if (j >= a.length) html += `<span class="l">${etude.escape(w[j])}</span>`;
        else html += `<span class="l ${a[j] === w[j] ? "ok" : "bad"}">${etude.escape(w[j])}</span>`;
      }
      wordEls[i].innerHTML = html;
      wordEls[i].classList.toggle("err", done && typed[i] !== words[i]);
    }
    if (cur > last) return;
    const el = wordEls[cur];
    const letters = el.querySelectorAll(".l");
    const n = Array.from(current).length;
    // Letters and words are both measured from the track (the nearest positioned ancestor).
    let x, y = el.offsetTop;
    if (n < letters.length) x = letters[n].offsetLeft;
    else { const l = letters[letters.length - 1]; x = l.offsetLeft + l.offsetWidth; }
    caret.style.transform = `translate(${x}px, ${y}px)`;
    if (started) { caret.classList.add("moving"); clearTimeout(caretIdle); caretIdle = setTimeout(() => caret.classList.remove("moving"), 600); }
    const lh = el.offsetHeight;
    track.style.transform = `translateY(${-Math.max(0, y - lh)}px)`;
  };

  const elapsed = () => (started ? performance.now() - t0 : 0);

  const sample = (sec, span) => {
    const ms = sec * 1000;
    const wpm = measure(typed, cur, current, ms, false);
    history.push([r2(sec), r2(wpm), r2((secChars / 5) * (60 / span)), secErr]);
    secChars = 0;
    secErr = 0;
  };

  const tick = () => {
    const ms = elapsed();
    while (ms >= nextSec * 1000 && (!timed || nextSec <= view.seconds)) sample(nextSec++, 1);
    if (timed) {
      const left = Math.max(0, Math.ceil((total - ms) / 1000));
      live.textContent = String(left);
      if (ms >= total) return finish(false);
    }
    speed.textContent = ms > 1000 ? `${Math.round(measure(typed, cur, current, ms, false))} wpm` : "";
  };

  const start = () => {
    started = true;
    t0 = performance.now();
    live.classList.add("on");
    etude.setReady(true);
    timer = setInterval(tick, 100);
    if (timed) endTimer = setTimeout(() => finish(false), total + 30);
  };

  let quietUntil = 0;
  const finish = (complete) => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    clearTimeout(endTimer);
    const ms = timed ? total : elapsed();
    // Seconds the interval hadn't sampled yet, then the last partial second.
    while (ms >= nextSec * 1000 && (!timed || nextSec <= view.seconds)) sample(nextSec++, 1);
    const rest = ms / 1000 - (nextSec - 1);
    if (rest >= 0.25 && (!timed || nextSec - 1 < view.seconds)) sample(ms / 1000, rest);
    if (current) typed[cur] = current;
    input.disabled = true;
    input.blur();
    stage.classList.add("done");
    caret.style.display = "none";
    quietUntil = performance.now() + 1500;
    etude.submit(answerOf(ms, complete));
  };

  const answerOf = (ms, complete) => ({
    typed: [...typed.slice(0, cur), ...(cur <= last && current ? [current] : [])],
    ms: Math.round(ms),
    complete,
    keys: { ...keys },
    history: history.slice(),
  });

  const counter = () => { if (!timed) live.textContent = `${Math.min(cur, words.length)}/${words.length}`; };

  const type = (ch) => {
    if (finished || cur > last) return;
    if (/\s/.test(ch)) {
      // A space at the start of a word does nothing, as in Monkeytype.
      if (!current) return;
      const ok = current === words[cur];
      keys[ok ? "correct" : "incorrect"]++;
      secChars++;
      if (!ok) secErr++;
      typed[cur] = current;
      if (cur === last) { cur++; current = ""; counter(); return finish(true); }
      const prev = cur++;
      current = "";
      paint(prev);
      counter();
      return;
    }
    if (!started) start();
    const pos = Array.from(current).length;
    const w = Array.from(words[cur]);
    // Monkeytype caps extra letters so a word can't run off the line.
    if (pos >= w.length + 10) return;
    const ok = pos < w.length && ch === w[pos];
    keys[ok ? "correct" : "incorrect"]++;
    secChars++;
    if (!ok) secErr++;
    current += ch;
    paint();
    if (cur === last && current === words[cur]) { typed[cur] = current; cur++; current = ""; counter(); finish(true); }
  };

  input.addEventListener("input", (e) => {
    if (finished) { input.value = ""; return; }
    if (e.inputType?.startsWith("insert") && e.data != null && e.inputType !== "insertReplacementText") {
      for (const ch of Array.from(e.data)) type(ch);
    } else if (e.inputType?.startsWith("delete")) {
      current = input.value.replace(/\s+/g, "");
      paint();
    } else {
      // Autocorrect or paste replacing the word: take the field as it is, without counting keys.
      const v = input.value;
      const parts = v.split(/(\s+)/);
      current = "";
      for (const p of parts) { if (/^\s+$/.test(p)) type(" "); else if (p) { current = p; paint(); } }
    }
    if (!finished) {
      input.value = current;
      input.setSelectionRange(input.value.length, input.value.length);
    }
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Tab") { e.preventDefault(); if (!finished) { reset(); input.focus(); } return; }
    if (e.key === "Enter") { e.preventDefault(); return; }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End" || e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); return; }
    // Backspace at the start of a word goes back into the previous one, but only if it was wrong.
    if (e.key === "Backspace" && current === "" && cur > 0 && typed[cur - 1] !== words[cur - 1]) {
      e.preventDefault();
      const prev = cur--;
      current = e.ctrlKey || e.altKey || e.metaKey ? "" : typed[cur] ?? "";
      typed.length = cur;
      input.value = current;
      paint(prev);
      counter();
    }
  });

  const blur = () => box.classList.toggle("blurred", document.activeElement !== input && !finished);
  input.addEventListener("focus", blur);
  input.addEventListener("blur", () => setTimeout(blur, 0));
  box.addEventListener("pointerdown", () => { if (!finished) setTimeout(() => input.focus({ preventScroll: true }), 0); });
  // Typing anywhere on the card goes into the test.
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.key === "Enter" || e.key === " ") && (performance.now() < quietUntil || (finished && etude.mode === "answer"))) { e.preventDefault(); return; }
    if (etude.mode !== "answer" || finished || document.activeElement === input) return;
    if (e.key === "Tab") { e.preventDefault(); reset(); input.focus({ preventScroll: true }); return; }
    if (e.key.length === 1) { input.focus({ preventScroll: true }); }
  }, true);

  reset();
  requestAnimationFrame(() => { paint(); blur(); });
  new ResizeObserver(() => { if (!finished) paint(); }).observe(holder);

  etude.getAnswer(() => answerOf(elapsed(), false));
  etude.onResult(() => {
    if (!finished) { finished = true; clearInterval(timer); clearTimeout(endTimer); }
    quietUntil = Math.max(quietUntil, performance.now() + 1200);
  });
}

etude.onResult(({ grade, answer }) => {
  const d = grade?.details;
  const kind = { common: "english", list: "word list", text: "passage" }[view.kind] ?? "words";
  etude.$(".ty-type").innerHTML = `${timed ? `time ${view.seconds}` : view.kind === "text" ? "quote" : `words ${words.length}`}<br><span class="e-muted">${kind}</span>`;
  etude.$(".ty-type").classList.add("small");
  if (!d) {
    etude.$(".ty-wpm").textContent = "–";
    etude.$(".ty-acc").textContent = "–";
    for (const s of [".ty-raw", ".ty-chars", ".ty-cons", ".ty-time"]) etude.$(s).textContent = "–";
    etude.$(".ty-chart").innerHTML = `<div class="e-muted" style="padding-top:4.5rem;font-size:.85rem">Your speed second by second shows up here after a test. Target: ${view.target} wpm.</div>`;
    etude.$(".ty-hw").innerHTML = words.slice(0, 40).map((w) => `<span class="w"><span class="l miss">${etude.escape(w)}</span></span>`).join("");
    return;
  }
  etude.$(".ty-wpm").textContent = Math.round(d.wpm);
  etude.$(".ty-wpm").title = `${d.wpm.toFixed(2)} wpm`;
  etude.$(".ty-acc").textContent = `${Math.round(d.acc)}%`;
  etude.$(".ty-acc").title = `${d.acc.toFixed(2)}%`;
  etude.$(".ty-raw").textContent = Math.round(d.raw);
  etude.$(".ty-chars").innerHTML = `<span class="c">${d.correct}</span><span class="sl">/</span><span class="i">${d.incorrect}</span><span class="sl">/</span><span class="x">${d.extra}</span><span class="sl">/</span><span class="m">${d.missed}</span>`;
  etude.$(".ty-cons").textContent = d.consistency == null ? "–" : `${Math.round(d.consistency)}%`;
  etude.$(".ty-time").textContent = `${Math.round(d.ms / 1000)}s`;
  etude.$(".ty-time").title = `${(d.ms / 1000).toFixed(2)} s`;

  const typedList = Array.isArray(d.typed) ? d.typed : answer?.typed ?? [];
  etude.$(".ty-hw").innerHTML = typedList.map((t, i) => {
    const w = Array.from(words[i] ?? ""), a = Array.from(String(t));
    const cut = i === typedList.length - 1 && !d.complete;
    let html = "";
    for (let j = 0; j < Math.max(w.length, a.length); j++) {
      if (j >= w.length) html += `<span class="l extra">${etude.escape(a[j])}</span>`;
      else if (j >= a.length) html += `<span class="l miss">${etude.escape(w[j])}</span>`;
      else html += `<span class="l${a[j] === w[j] ? "" : " bad"}">${etude.escape(w[j])}</span>`;
    }
    const err = t !== words[i] && !(cut && words[i]?.startsWith(t));
    return `<span class="w${err ? " err" : ""}${cut ? " cut" : ""}" title="${etude.escape(String(t))}">${html}</span>`;
  }).join("") || `<span class="e-muted">No words typed.</span>`;

  const chart = etude.$(".ty-chart");
  const h = (d.history ?? []).filter((p) => Array.isArray(p) && p[0] > 0);
  const draw = () => {
    const W = Math.max(200, chart.clientWidth), H = chart.clientHeight || 190;
    if (!h.length) { chart.innerHTML = `<div class="e-muted" style="padding-top:4.5rem;font-size:.85rem">Too short for a chart.</div>`; return; }
    const pl = 30, pr = 8, pt = 8, pb = 22;
    const xmax = h[h.length - 1][0];
    const top = Math.max(view.target, ...h.map((p) => Math.max(p[1], p[2])));
    const step = top > 150 ? 50 : top > 60 ? 20 : 10;
    const ymax = Math.ceil((top * 1.08) / step) * step;
    const X = (s) => pl + ((s - (h.length > 1 ? h[0][0] : 0)) / Math.max(0.001, xmax - (h.length > 1 ? h[0][0] : 0))) * (W - pl - pr);
    const Y = (v) => pt + (1 - v / ymax) * (H - pt - pb);
    let g = "";
    for (let v = 0; v <= ymax; v += step) g += `<line class="grid" x1="${pl}" x2="${W - pr}" y1="${Y(v)}" y2="${Y(v)}"/><text class="ax" x="${pl - 6}" y="${Y(v) + 3.5}" text-anchor="end">${v}</text>`;
    const ticks = Math.min(h.length, Math.max(2, Math.floor((W - pl - pr) / 34)));
    const every = Math.ceil(h.length / ticks);
    // The last label is right-aligned so it stays inside the card; labels too close to it are skipped.
    h.forEach((p, i) => {
      const end = i === h.length - 1;
      if (!end && (i % every !== 0 || X(h[h.length - 1][0]) - X(p[0]) < 26)) return;
      g += `<text class="ax" x="${X(p[0])}" y="${H - 6}" text-anchor="${end ? "end" : "middle"}">${Number.isInteger(p[0]) ? p[0] : p[0].toFixed(1)}</text>`;
    });
    const line = (k) => h.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[k]).toFixed(1)}`).join("");
    const area = `${line(1)}L${X(xmax).toFixed(1)},${Y(0)}L${X(h[0][0]).toFixed(1)},${Y(0)}Z`;
    let errs = "";
    for (const p of h) if (p[3] > 0) { const x = X(p[0]), y = Y(p[2]), s = 3.2 + Math.min(2, p[3] - 1) * 0.8; errs += `<path class="errx" d="M${x - s},${y - s}L${x + s},${y + s}M${x + s},${y - s}L${x - s},${y + s}"><title>${p[3]} error${p[3] > 1 ? "s" : ""}</title></path>`; }
    const target = view.target <= ymax ? `<line class="rule" x1="${pl}" x2="${W - pr}" y1="${Y(view.target)}" y2="${Y(view.target)}"/>` : "";
    chart.innerHTML = `<div class="ty-legend"><span><i style="background:var(--highlight)"></i>wpm</span><span><i style="background:var(--muted-foreground)"></i>raw</span><span><b class="x">×</b>errors</span><span><i style="background:none;border-top:1px dashed var(--muted-foreground)"></i>target</span></div>
<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${g}${target}<path class="wpm-a" d="${area}"/><path class="raw" d="${line(2)}"/><path class="wpm" d="${line(1)}"/>${errs}<circle class="dot" r="3.5" cx="0" cy="0" visibility="hidden"/></svg><div class="ty-tip" hidden></div>`;
    const svg = chart.querySelector("svg"), tip = chart.querySelector(".ty-tip"), dot = chart.querySelector(".dot");
    svg.addEventListener("pointermove", (ev) => {
      const r = svg.getBoundingClientRect();
      const mx = ((ev.clientX - r.left) / r.width) * W;
      let best = 0;
      h.forEach((p, i) => { if (Math.abs(X(p[0]) - mx) < Math.abs(X(h[best][0]) - mx)) best = i; });
      const p = h[best];
      dot.setAttribute("visibility", "visible");
      dot.setAttribute("cx", X(p[0]));
      dot.setAttribute("cy", Y(p[1]));
      tip.hidden = false;
      tip.innerHTML = `${Number.isInteger(p[0]) ? p[0] : p[0].toFixed(1)}s<br><b>wpm ${Math.round(p[1])}</b><br>raw ${Math.round(p[2])}${p[3] ? `<br><span class="e">errors ${p[3]}</span>` : ""}`;
      const left = (X(p[0]) / W) * r.width;
      tip.style.left = `${Math.min(r.width - tip.offsetWidth, Math.max(0, left + 10))}px`;
    });
    svg.addEventListener("pointerleave", () => { tip.hidden = true; dot.setAttribute("visibility", "hidden"); });
  };
  draw();
  let lastW = chart.clientWidth;
  new ResizeObserver(() => { if (Math.abs(chart.clientWidth - lastW) > 2) { lastW = chart.clientWidth; draw(); } }).observe(chart);
});
