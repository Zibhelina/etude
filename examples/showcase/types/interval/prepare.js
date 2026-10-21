const LET = "CDEFGAB", PCS = [0, 2, 4, 5, 7, 9, 11];
const midiOf = (n) => 12 * (n.oct + 1) + PCS[LET.indexOf(n.letter)] + n.acc;
const above = (n, steps, semis) => {
  const li = LET.indexOf(n.letter) + steps;
  const t = { letter: LET[li % 7], oct: n.oct + Math.floor(li / 7), acc: 0 };
  t.acc = midiOf(n) + semis - midiOf(t);
  return t;
};
const ACC = { "-2": "𝄫", "-1": "♭", 0: "", 1: "♯", 2: "𝄪" };
const TEX = { "-2": "\\flat\\flat", "-1": "\\flat", 0: "", 1: "\\sharp", 2: "\\sharp\\sharp" };
const txt = (n) => `${n.letter}${ACC[n.acc]}${n.oct}`;
const tex = (n) => `\\mathrm{${n.letter}}${TEX[n.acc]}_{${n.oct}}`;

// [id, name, letter steps, semitones]
const ALL = [
  ["m2", "minor 2nd", 1, 1], ["M2", "major 2nd", 1, 2], ["m3", "minor 3rd", 2, 3], ["M3", "major 3rd", 2, 4],
  ["P4", "perfect 4th", 3, 5], ["TT", "tritone", 3, 6], ["P5", "perfect 5th", 4, 7], ["m6", "minor 6th", 5, 8],
  ["M6", "major 6th", 5, 9], ["m7", "minor 7th", 6, 10], ["M7", "major 7th", 6, 11], ["P8", "octave", 7, 12],
];
const BASIC = ["M2", "m3", "M3", "P4", "P5", "M6", "P8"];
const set = fields.set === "all" ? ALL : ALL.filter((i) => BASIC.includes(i[0]));
const [id, name, steps, semis] = rng.pick(set);

// A root between C3 and G4, mostly natural, spelled so the top note needs at most one sharp or flat.
let root, top;
do {
  root = { letter: rng.pick([...LET]), oct: rng.pick([3, 3, 4]), acc: rng.bool(0.25) ? rng.pick([-1, 1]) : 0 };
  top = above(root, steps, semis);
} while (Math.abs(top.acc) > 1 || midiOf(root) < 48 || midiOf(root) > 67 || (root.letter === "B" && root.acc === 1) || (root.letter === "E" && root.acc === 1) || (root.letter === "C" && root.acc === -1) || (root.letter === "F" && root.acc === -1));

const dirs = { up: "up", down: "down", harmonic: "harmonic" };
const direction = dirs[fields.direction] ?? rng.pick(["up", "up", "down", "harmonic"]);
return {
  view: {
    prompt: fields.prompt ?? "",
    direction,
    low: midiOf(root),
    high: midiOf(top),
    options: set.map(([i, n]) => ({ id: i, name: n })),
  },
  key: {
    answer: id, name, semis,
    first: direction === "down" ? txt(top) : txt(root), second: direction === "down" ? txt(root) : txt(top),
    firstTex: direction === "down" ? tex(top) : tex(root), secondTex: direction === "down" ? tex(root) : tex(top),
    lowText: txt(root), highText: txt(top),
    explanation: fields.explanation ?? "",
  },
};
