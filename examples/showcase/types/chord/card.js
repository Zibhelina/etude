// A soft piano voice: a handful of harmonics, a quick hammer attack and a two-stage decay.
// The AudioContext is created on the first gesture inside the frame (browsers require one).
const Piano = (() => {
  let ctx = null, out = null, wave = null, noise = null;
  const setup = (c, dest) => {
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -18; comp.knee.value = 14; comp.ratio.value = 3;
    comp.attack.value = 0.003; comp.release.value = 0.3;
    const g = c.createGain();
    g.gain.value = 0.7;
    g.connect(comp); comp.connect(dest);
    const amps = [0, 1, 0.45, 0.28, 0.17, 0.1, 0.06, 0.035, 0.02, 0.012];
    const w = c.createPeriodicWave(new Float32Array(amps.length), Float32Array.from(amps));
    const n = c.createBuffer(1, Math.ceil(c.sampleRate * 0.04), c.sampleRate);
    const d = n.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    return { out: g, wave: w, noise: n };
  };
  const get = () => {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!ctx) {
      ctx = new AC();
      ({ out, wave, noise } = setup(ctx, ctx.destination));
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  };
  const voice = (c, dest, w, nz, midi, t, len, vel) => {
    const f = 440 * 2 ** ((midi - 69) / 12);
    const ring = Math.max(0.6, 2.8 - (midi - 48) * 0.045); // low notes ring longer
    const peak = 0.2 * vel;
    const env = c.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + 0.005);
    env.gain.setTargetAtTime(peak * 0.4, t + 0.005, 0.08);
    env.gain.setTargetAtTime(0.0001, t + 0.2, ring / 4);
    const stop = t + Math.min(len ?? ring, ring) ;
    env.gain.setTargetAtTime(0.0001, stop, 0.09);
    const lp = c.createBiquadFilter();
    lp.type = "lowpass"; lp.Q.value = 0.5;
    lp.frequency.setValueAtTime(Math.min(f * 10, 15000), t);
    lp.frequency.setTargetAtTime(Math.min(f * 3.2, 8000), t + 0.01, 0.3);
    lp.connect(env); env.connect(dest);
    [[0, 1], [5, 0.55], [-4, 0.35]].forEach(([cents, a]) => {
      const o = c.createOscillator();
      o.setPeriodicWave(w); o.frequency.value = f; o.detune.value = cents;
      const g = c.createGain(); g.gain.value = a;
      o.connect(g); g.connect(lp);
      o.start(t); o.stop(stop + 0.6);
    });
    const h = c.createBufferSource(); h.buffer = nz;
    const bp = c.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = Math.min(f * 4, 6000); bp.Q.value = 1.2;
    const hg = c.createGain(); hg.gain.value = 0.05 * vel;
    h.connect(bp); bp.connect(hg); hg.connect(dest);
    h.start(t);
  };
  return {
    /** notes: [{ m: midi, at: seconds from now, len?: seconds, vel?: 0..1 }]. Returns the total length. */
    play(notes) {
      const c = get();
      if (!c) return 0;
      const t0 = c.currentTime + 0.04;
      let end = 0;
      for (const n of notes) {
        voice(c, out, wave, noise, n.m, t0 + (n.at ?? 0), n.len, n.vel ?? 0.8);
        end = Math.max(end, (n.at ?? 0) + (n.len ?? 1.2));
      }
      return end;
    },
    /** Renders notes offline (for checking the sound without speakers). */
    async render(notes, seconds = 3) {
      const c = new OfflineAudioContext(1, Math.ceil(44100 * seconds), 44100);
      const s = setup(c, c.destination);
      for (const n of notes) voice(c, s.out, s.wave, s.noise, n.m, n.at ?? 0, n.len, n.vel ?? 0.8);
      return c.startRendering();
    },
  };
})();

const PLAY_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" fill="currentColor"/></svg>`;

// Piano keyboard drawn one octave (C to B) per SVG, so narrow screens can stack octaves.
// keyboard(host, { lo, octaves, wrap, labels, onPress }) returns { el(midi), all(), set(midi, cls, on), label(midi, text) }.
function keyboard(host, { lo = 48, octaves = 2, wrap = true, labels = "c", onPress = null } = {}) {
  const W = 24, H = 104, BW = 14.5, BH = 66, R = 3;
  const WHITE = [0, 2, 4, 5, 7, 9, 11];
  const BLACK = { 1: [1, -0.12], 3: [2, 0.12], 6: [4, -0.16], 8: [5, 0], 10: [6, 0.16] }; // pc -> [boundary, offset]
  const LETTER = { 0: "C", 2: "D", 4: "E", 5: "F", 7: "G", 9: "A", 11: "B" };
  const SPOKEN = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
  const aria = (m) => `role="button" aria-label="${SPOKEN[m % 12]}${Math.floor(m / 12) - 1}"`;
  const whitePath = (x) => `M${x + 0.5} 0.5H${x + W - 0.5}V${H - R - 0.5}Q${x + W - 0.5} ${H - 0.5} ${x + W - R - 0.5} ${H - 0.5}H${x + R + 0.5}Q${x + 0.5} ${H - 0.5} ${x + 0.5} ${H - R - 0.5}Z`;
  host.classList.add("kb");
  if (!wrap) host.classList.add("kb-nowrap");
  let html = "";
  for (let k = 0; k < octaves; k++) {
    const base = lo + 12 * k;
    let s = `<svg class="kb-oct" viewBox="0 0 ${7 * W} ${H}" role="group" aria-label="Octave ${Math.floor(base / 12) - 1}">`;
    WHITE.forEach((pc, i) => {
      const m = base + pc, x = i * W;
      const text = labels === "all" ? LETTER[pc] : labels === "c" && pc === 0 ? `C${Math.floor(m / 12) - 1}` : "";
      s += `<g class="key white" data-m="${m}" ${aria(m)}><path d="${whitePath(x)}"/><text x="${x + W / 2}" y="${H - 9}" class="kl">${text}</text></g>`;
    });
    for (const [pc, [b, off]] of Object.entries(BLACK)) {
      const m = base + Number(pc), x = (b + off) * W - BW / 2;
      s += `<g class="key black" data-m="${m}" ${aria(m)}><path d="M${x} 0H${x + BW}V${BH - 2}Q${x + BW} ${BH} ${x + BW - 2} ${BH}H${x + 2}Q${x} ${BH} ${x} ${BH - 2}Z"/><text x="${x + BW / 2}" y="${BH - 7}" class="kl"></text></g>`;
    }
    html += s + "</svg>";
  }
  host.innerHTML = html;
  const map = new Map([...host.querySelectorAll(".key")].map((g) => [Number(g.dataset.m), g]));
  if (onPress) {
    host.addEventListener("pointerdown", (e) => {
      const g = e.target.closest?.(".key");
      if (!g || e.button > 0) return;
      e.preventDefault();
      g.classList.add("down");
      setTimeout(() => g.classList.remove("down"), 160);
      onPress(Number(g.dataset.m));
    });
  }
  return {
    el: (m) => map.get(m),
    all: () => [...map.keys()],
    set(m, cls, on = true) { map.get(m)?.classList.toggle(cls, on); },
    clear(cls) { for (const g of map.values()) g.classList.remove(cls); },
    label(m, text) { const t = map.get(m)?.querySelector("text"); if (t) t.textContent = text; },
  };
}

// Spelled note names: { letter: "E", acc: -1, oct: 4 } -> "E♭4", or KaTeX "\mathrm{E}\flat_{4}".
const ACC = { "-2": "𝄫", "-1": "♭", 0: "", 1: "♯", 2: "𝄪" };
const ACC_TEX = { "-2": "{\\flat\\flat}", "-1": "{\\flat}", 0: "", 1: "{\\sharp}", 2: "{\\sharp\\sharp}" };
const noteText = (n) => `${n.letter}${ACC[n.acc]}${n.oct ?? ""}`;
const noteTex = (n) => `\\mathrm{${n.letter}}${ACC_TEX[n.acc]}${n.oct != null ? `_{${n.oct}}` : ""}`;

const { view } = etude;
const LO = 48; // C3
etude.$(".cd-sym").innerHTML = etude.mdInline(`$${view.tex}$`);
let sel = new Set(Array.isArray(etude.answer) ? etude.answer : []);
const count = etude.$(".cd-count");
const paint = () => {
  kb.all().forEach((m) => kb.set(m, "sel", sel.has(m)));
  count.textContent = sel.size ? `${sel.size} key${sel.size === 1 ? "" : "s"}` : "";
  etude.setReady(etude.mode === "answer" && sel.size > 0);
};
const kb = keyboard(etude.$(".cd-kb"), {
  lo: LO, octaves: 2, labels: "c",
  onPress: (m) => {
    if (etude.mode !== "answer") return;
    if (sel.has(m)) sel.delete(m);
    else { sel.add(m); Piano.play([{ m, len: 0.9 }]); }
    paint();
  },
});
const chordNotes = (ms) => [...ms].sort((a, b) => a - b).map((m, i) => ({ m, at: i * 0.07, len: 1.8, vel: 0.65 }));
const playSel = etude.$(".cd-play");
playSel.querySelector(".ic").innerHTML = PLAY_ICON;
playSel.addEventListener("click", () => sel.size && Piano.play(chordNotes(sel)));
etude.$(".cd-clear").addEventListener("click", () => { sel.clear(); paint(); });
paint();
etude.getAnswer(() => [...sel].sort((a, b) => a - b));

etude.onResult(({ key, answer }) => {
  const played = Array.isArray(answer) ? answer : [];
  const want = new Set(key.pcs);
  etude.$(".cd-kb").classList.add("static");
  kb.clear("sel");
  const SP = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
  for (const m of played) { kb.set(m, want.has(m % 12) ? "ok" : "bad"); if (!want.has(m % 12)) kb.label(m, SP[m % 12]); }
  const found = new Set(played.map((m) => m % 12));
  // Missing tones are shown in the lowest octave where they fit above the root.
  const rootPc = key.pcs[0];
  key.tones.forEach((t) => {
    const m = LO + rootPc + ((t.pc - rootPc + 12) % 12);
    if (!found.has(t.pc)) kb.set(m, "miss");
    kb.label(played.find((p) => p % 12 === t.pc) ?? m, t.name);
  });
  etude.$(".cd-tones").innerHTML = `<div class="cd-row">${key.tones.map((t) => `<div class="cd-tone ${found.has(t.pc) ? "ok" : "miss"}"><span class="deg">${t.deg}</span><span class="nm">${etude.mdInline(`$${t.tex}$`)}</span></div>`).join("")}</div>`;
  if (!played.length) etude.$(".cd-legend").hidden = true;
  const ans = etude.$(".cd-ans");
  ans.querySelector(".ic").innerHTML = PLAY_ICON;
  ans.addEventListener("click", () => Piano.play(chordNotes(key.tones.map((t) => LO + 12 + rootPc + ((t.pc - rootPc + 12) % 12)))));
});
