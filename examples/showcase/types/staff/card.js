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
const ACC_TEX = { "-2": "\\flat\\flat", "-1": "\\flat", 0: "", 1: "\\sharp", 2: "\\sharp\\sharp" };
const noteText = (n) => `${n.letter}${ACC[n.acc]}${n.oct ?? ""}`;
const noteTex = (n) => `\\mathrm{${n.letter}}${ACC_TEX[n.acc]}${n.oct != null ? `_{${n.oct}}` : ""}`;

// Clefs and accidentals traced from Noto Music (OFL); 1000 units per em, 250 per staff space, origin on the bottom line.
const GLYPH = {"gclef": "M314 801Q300 854 291 906Q282 958 282 1012Q282 1059 288 1100Q295 1142 307 1177Q320 1217 341 1252Q362 1288 386 1311Q409 1334 427 1334Q451 1334 493 1249Q514 1206 524 1156Q534 1106 534 1049Q534 978 515 908Q496 837 460 775Q423 713 372 666L407 498Q422 500 432 501Q442 502 447 502Q508 502 556 468Q604 433 632 377Q661 321 661 254Q661 177 622 116Q582 54 503 25Q508 8 532 -117Q538 -147 541 -164Q544 -182 545 -195Q546 -208 546 -225Q546 -275 522 -314Q497 -354 456 -376Q414 -398 363 -398Q311 -398 271 -378Q231 -359 208 -324Q185 -290 185 -245Q185 -197 212 -165Q238 -133 287 -133Q329 -133 356 -164Q382 -194 382 -236Q382 -272 357 -299Q332 -326 292 -326H282Q308 -365 364 -365Q433 -365 472 -320Q511 -275 511 -205Q511 -188 507 -160Q503 -131 493 -91Q483 -51 478 -25Q472 1 470 12Q436 2 390 2Q304 2 222 52Q142 102 96 184Q50 266 50 361Q50 451 91 530Q132 609 192 675Q253 741 314 801ZM341 826Q364 838 390 870Q416 903 440 945Q464 987 479 1030Q494 1072 494 1106Q494 1142 483 1163Q472 1184 445 1184Q421 1184 398 1162Q376 1140 358 1104Q341 1067 331 1022Q321 977 321 930Q321 898 328 872Q334 846 341 826ZM398 379Q371 373 347 354Q323 334 308 306Q294 279 294 248Q294 223 307 196Q320 170 339 154Q352 142 365 136Q380 129 380 123Q380 120 370 117Q332 126 302 151Q271 176 254 212Q236 247 236 287Q236 330 254 370Q271 410 302 442Q334 474 374 490L345 641Q229 547 174 456Q120 366 120 277Q120 212 154 156Q188 100 247 66Q306 31 380 31Q400 31 420 35Q441 39 464 45ZM495 55Q593 97 593 227Q593 270 571 306Q549 341 512 362Q475 383 429 383Z", "fclef": "M50 123Q216 231 288 301Q336 348 373 408Q410 469 432 536Q453 603 453 669Q453 728 435 774Q417 819 383 845Q349 871 302 871Q284 871 264 867Q245 863 224 855Q181 839 158 814Q135 788 135 765Q135 756 143 752Q151 748 158 748Q168 748 183 752Q190 754 196 755Q203 756 210 756Q248 756 272 734Q296 711 296 674Q296 638 266 612Q236 586 195 586Q146 586 111 617Q76 648 76 697Q76 756 109 802Q142 848 198 874Q255 900 324 900Q400 900 460 867Q520 834 556 776Q591 719 591 646Q591 551 538 464Q511 419 476 379Q442 339 389 298Q336 256 256 208Q176 160 57 101ZM687 809Q710 809 726 793Q742 777 742 754Q742 731 726 716Q710 700 687 700Q664 700 648 716Q632 731 632 754Q632 777 648 793Q664 809 687 809ZM687 589Q710 589 726 573Q742 557 742 534Q742 511 726 496Q710 480 687 480Q664 480 648 496Q632 511 632 534Q632 557 648 573Q664 589 687 589Z", "sharp": "M97 46V189L50 177V277L97 290V486H128V298L195 314V509H226V322L275 333V234L226 220V77L275 89V-14L226 -26V-214H195V-34L128 -52V-247H97V-59L50 -71V32ZM195 70V214L128 197V54Z", "flat": "M50 615H81V225Q118 262 165 262Q197 262 223 240Q249 219 249 178Q249 146 230 119Q211 92 179 65L110 6Q91 -10 76 -26Q61 -41 50 -55ZM81 12Q107 40 125 64Q143 87 153 105Q164 124 170 140Q175 156 175 170Q175 198 162 210Q149 223 134 223Q118 223 102 212Q87 200 81 180Z"};
const { view } = etude;
// Staff geometry in SVG units: a space is 10, position p (0 = bottom line, 8 = top line) sits at y = B - 5p.
const B = 100, SP = 10, SC = SP / 250, X0 = 4, W = 168;
const yOf = (p) => B - 5 * p;
const glyph = (d, x, y, cls = "") => `<path class="${cls}" transform="translate(${x} ${y}) scale(${SC} ${-SC})" d="${d}"/>`;

const draw = (noteCls = "") => {
  let s = "";
  for (let i = 0; i < 5; i++) s += `<line class="sl" x1="${X0}" x2="${X0 + W}" y1="${yOf(2 * i)}" y2="${yOf(2 * i)}"/>`;
  // The treble clef's curl wraps the G line; the bass clef's dots straddle the F line.
  s += view.clef === "treble" ? glyph(GLYPH.gclef, X0 + 3, B, "clef") : glyph(GLYPH.fclef, X0 + 4, B - 105 * SC, "clef");
  const nx = X0 + 104, p = view.pos;
  for (let q = -2; q >= p; q -= 2) s += `<line class="ledger" x1="${nx - 11}" x2="${nx + 11}" y1="${yOf(q)}" y2="${yOf(q)}"/>`;
  for (let q = 10; q <= p; q += 2) s += `<line class="ledger" x1="${nx - 11}" x2="${nx + 11}" y1="${yOf(q)}" y2="${yOf(q)}"/>`;
  const y = yOf(p);
  let n = "";
  if (view.acc === 1) n += glyph(GLYPH.sharp, nx - 22, y + 134 * SC);
  if (view.acc === -1) n += glyph(GLYPH.flat, nx - 20, y + 105 * SC);
  // Quarter note: stem up below the middle line, down from it.
  const up = p < 4;
  n += `<ellipse cx="${nx}" cy="${y}" rx="6.1" ry="4.3" transform="rotate(-20 ${nx} ${y})"/>`;
  n += up ? `<line class="stem" x1="${nx + 5.6}" x2="${nx + 5.6}" y1="${y - 1.2}" y2="${y - 35}"/>` : `<line class="stem" x1="${nx - 5.6}" x2="${nx - 5.6}" y1="${y + 1.2}" y2="${y + 35}"/>`;
  s += `<g class="note ${noteCls}">${n}</g>`;
  // Fit the drawing: staff plus whatever ledger lines and stem stick out.
  const top = Math.min(yOf(8) - 22, y - 42), bot = Math.max(yOf(0) + 20, y + 42);
  etude.$(".st-staff").innerHTML = `<svg viewBox="0 ${top} ${W + 2 * X0} ${bot - top}" role="img" aria-label="A note on a ${view.clef} staff">${s}</svg>`;
};
draw();

let picked = Number.isInteger(etude.answer) ? etude.answer : null;
const LET_PC = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const LO = 60;
const kb = keyboard(etude.$(".st-kb"), {
  lo: LO, octaves: 1, labels: "all", wrap: false,
  onPress: (m) => choose(m, true),
});
const choose = (m, sound) => {
  if (etude.mode !== "answer") return;
  picked = m;
  kb.clear("sel");
  kb.set(m, "sel");
  if (sound) Piano.play([{ m, len: 0.9 }]);
  etude.setReady(true);
};
etude.$(".st-help").innerHTML = view.accidentals
  ? "Tap a key, or press <kbd>A</kbd>–<kbd>G</kbd> for the white keys."
  : "Tap a key, or press <kbd>A</kbd>–<kbd>G</kbd>.";
window.addEventListener("keydown", (e) => {
  if (etude.mode !== "answer" || e.ctrlKey || e.metaKey || e.altKey) return;
  const pc = LET_PC[e.key.toLowerCase()];
  if (pc !== undefined) { e.preventDefault(); choose(LO + pc, true); }
});
etude.setReady(false);
if (picked !== null) choose(picked, false);
etude.getAnswer(() => picked);

etude.onResult(({ key, answer, grade }) => {
  const ok = grade?.score >= 1;
  const attempted = Number.isInteger(answer);
  etude.$(".st-kb").classList.add("static");
  kb.clear("sel");
  const target = LO + key.pc;
  if (attempted && !ok) kb.set(LO + (((answer % 12) + 12) % 12), "bad");
  kb.set(target, attempted ? (ok ? "ok" : "miss") : "ok");
  draw(attempted && ok ? "ok" : "");
  etude.$(".st-answer").innerHTML = etude.md(`The note is $${key.tex}$${key.midi === 60 ? " (middle C)" : ""}.`);
  const b = etude.$(".st-play");
  b.querySelector(".ic").innerHTML = PLAY_ICON;
  b.addEventListener("click", () => Piano.play([{ m: key.midi, len: 1.4 }]));
});
