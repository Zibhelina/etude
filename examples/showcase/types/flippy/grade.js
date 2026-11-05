// A run of Flippy Bit: every shot-down invader is [value, ms spent on it, bit flips used].
const base = Math.round(Number(view.base) || 16);
const pop = (n) => { let c = 0; while (n) { c += n & 1; n >>= 1; } return c; };
const log = (Array.isArray(answer?.log) ? answer.log : [])
  .slice(0, 5000)
  .filter((e) => Array.isArray(e) && e.length >= 3)
  .map((e) => [Math.round(Number(e[0])), Math.max(0, Math.round(Number(e[1]) || 0)), Math.max(0, Math.round(Number(e[2]) || 0))])
  .filter((e) => e[0] >= 1 && e[0] <= 255)
  .map((e) => [e[0], e[1], Math.max(e[2], pop(e[0]))]);
const ms = Math.min(3600000, Math.max(0, Math.round(Number(answer?.ms) || 0)));
const died = Number.isInteger(answer?.died) && answer.died >= 1 && answer.died <= 255 ? answer.died : null;
const kills = log.length;
if (!kills && ms < 1000) {
  return { score: 0, feedback: "The game didn't start.", details: { kills: 0, seconds: 0, perKill: null, fastest: null, clean: null, died, base, log: [] } };
}
const need = log.reduce((s, e) => s + pop(e[0]), 0);
const used = log.reduce((s, e) => s + e[2], 0);
const r1 = (x) => Math.round(x * 10) / 10;
const target = Number(view.target) || 20;
return {
  score: Math.min(1, kills / target),
  details: {
    kills,
    seconds: r1(ms / 1000),
    // Seconds from when an invader became yours to fix (its arrival or your previous shot) to the shot.
    perKill: kills ? Math.round(log.reduce((s, e) => s + e[1], 0) / kills / 10) / 100 : null,
    fastest: kills ? Math.min(...log.map((e) => e[1])) / 1000 : null,
    // Share of flips that were needed: 100% means every bit was set once and never undone.
    clean: used ? r1((100 * need) / used) : null,
    died,
    base,
    log,
  },
};
