// An example run for watch mode: a decent player who goes down around the 17th invader.
const pop = (n) => { let c = 0; while (n) { c += n & 1; n >>= 1; } return c; };
const pick = () => { for (;;) { const v = rng.int(3, 255); if (pop(v) > 1) return v; } };
const kills = 14 + rng.int(0, 6);
const log = [];
let ms = 1500;
for (let i = 0; i < kills; i++) {
  const v = pick();
  const t = Math.round(1400 + pop(v) * 380 + rng.int(0, 1600) - i * 30);
  const extra = rng.bool(0.25) ? 2 : 0;
  log.push([v, t, pop(v) + extra]);
  ms += t + rng.int(200, 900);
}
return { log, ms, died: pick() };
