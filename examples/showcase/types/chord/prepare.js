const LET = "CDEFGAB", PCS = [0, 2, 4, 5, 7, 9, 11];
const pcOf = (n) => (((PCS[LET.indexOf(n.letter)] + n.acc) % 12) + 12) % 12;
const up = (n, steps, semis) => {
  const li = LET.indexOf(n.letter) + steps;
  const t = { letter: LET[li % 7], acc: 0 };
  t.acc = ((pcOf(n) + semis - PCS[li % 7] + 18) % 12) - 6;
  return t;
};
const ACC = { "-2": "𝄫", "-1": "♭", 0: "", 1: "♯", 2: "𝄪" };
const TEX = { "-2": "\\flat\\flat", "-1": "\\flat", 0: "", 1: "\\sharp", 2: "\\sharp\\sharp" };
const txt = (n) => `${n.letter}${ACC[n.acc]}`;
const tex = (n) => `\\mathrm{${n.letter}}${TEX[n.acc]}`;

// quality -> [display name, tex suffix, tones as [degree label, letter steps, semitones]]
const Q = {
  maj: ["major", "", [["1", 0, 0], ["3", 2, 4], ["5", 4, 7]]],
  min: ["minor", "m", [["1", 0, 0], ["♭3", 2, 3], ["5", 4, 7]]],
  dim: ["diminished", "^{\\circ}", [["1", 0, 0], ["♭3", 2, 3], ["♭5", 4, 6]]],
  aug: ["augmented", "^{+}", [["1", 0, 0], ["3", 2, 4], ["♯5", 4, 8]]],
  sus4: ["suspended 4th", "\\mathrm{sus4}", [["1", 0, 0], ["4", 3, 5], ["5", 4, 7]]],
  maj7: ["major 7th", "\\mathrm{maj7}", [["1", 0, 0], ["3", 2, 4], ["5", 4, 7], ["7", 6, 11]]],
  "7": ["dominant 7th", "^{7}", [["1", 0, 0], ["3", 2, 4], ["5", 4, 7], ["♭7", 6, 10]]],
  m7: ["minor 7th", "\\mathrm{m}^{7}", [["1", 0, 0], ["♭3", 2, 3], ["5", 4, 7], ["♭7", 6, 10]]],
  m7b5: ["half-diminished", "^{\\varnothing 7}", [["1", 0, 0], ["♭3", 2, 3], ["♭5", 4, 6], ["♭7", 6, 10]]],
  dim7: ["diminished 7th", "^{\\circ 7}", [["1", 0, 0], ["♭3", 2, 3], ["♭5", 4, 6], ["𝄫7", 6, 9]]],
};
const pool = (Array.isArray(fields.qualities) ? fields.qualities : []).filter((q) => Q[q]);
const quality = rng.pick(pool.length ? pool : Object.keys(Q));
const [qname, qtex, tones] = Q[quality];
// Common roots only, and no spellings with double sharps or flats.
const ROOTS = ["C", "D", "E", "F", "G", "A", "B", "Bb", "Eb", "Ab", "Db", "F#"];
let root, spelled;
do {
  const r = rng.pick(ROOTS);
  root = { letter: r[0], acc: r[1] === "b" ? -1 : r[1] === "#" ? 1 : 0 };
  spelled = tones.map(([deg, steps, semis]) => ({ deg, note: up(root, steps, semis), pc: (pcOf(root) + semis) % 12 }));
} while (spelled.some((t) => Math.abs(t.note.acc) > 1 && !(quality === "dim7" && t.deg === "𝄫7" && Math.abs(t.note.acc) === 2 && root.acc === 0)));

const longName = `${txt(root)} ${qname}`;
return {
  view: { prompt: fields.prompt ?? "", tex: `${tex(root)}${qtex}`, name: longName, size: tones.length },
  key: {
    pcs: spelled.map((t) => t.pc),
    tones: spelled.map((t) => ({ deg: t.deg, name: txt(t.note), tex: tex(t.note), pc: t.pc })),
    explanation: fields.explanation ?? "",
  },
};
