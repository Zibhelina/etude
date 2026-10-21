const LET = "CDEFGAB", PCS = [0, 2, 4, 5, 7, 9, 11];
const clef = fields.clef === "bass" ? "bass" : fields.clef === "both" ? rng.pick(["treble", "bass"]) : "treble";
// Diatonic index of the bottom line: E4 in treble, G2 in bass.
const bottom = clef === "treble" ? 7 * 4 + 2 : 7 * 2 + 4;
const ledger = Math.max(0, Math.min(3, Math.round(Number(fields.ledger ?? 2))));
// Position 0 is the bottom line, 8 the top line; each ledger line adds two positions.
const lo = -2 * ledger - 1, hi = 8 + 2 * ledger + 1;
// Mostly on the staff, sometimes on ledger lines.
const pos = ledger && rng.bool(0.35) ? rng.pick([...Array(hi - lo + 1).keys()].map((k) => k + lo).filter((p) => p < -1 || p > 9)) : rng.int(-1, 9);
const d = bottom + pos;
const letter = LET[d % 7], oct = Math.floor(d / 7);
let acc = 0;
if (fields.accidentals === true && rng.bool(0.4)) acc = rng.pick([-1, 1]);
const midi = 12 * (oct + 1) + PCS[d % 7] + acc;
const ACC = { "-1": "♭", 0: "", 1: "♯" }, TEX = { "-1": "\\flat", 0: "", 1: "\\sharp" };
return {
  view: { prompt: fields.prompt ?? "", clef, pos, acc, accidentals: fields.accidentals === true },
  key: {
    pc: ((midi % 12) + 12) % 12, midi,
    name: `${letter}${ACC[acc]}`, full: `${letter}${ACC[acc]}${oct}`, tex: `\\mathrm{${letter}}${TEX[acc]}_{${oct}}`,
    explanation: fields.explanation ?? "",
  },
};
