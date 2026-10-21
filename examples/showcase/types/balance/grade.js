// Parses the formulas and recounts every element; it doesn't just compare with the stored solution.
function parse(f) {
  let i = 0;
  const s = String(f).replace(/\s+/g, "");
  const num = () => {
    let n = "";
    while (i < s.length && /\d/.test(s[i])) n += s[i++];
    return n ? Number(n) : 1;
  };
  function group() {
    const out = {};
    while (i < s.length && s[i] !== ")") {
      let part;
      if (s[i] === "(") { i++; part = group(); i++; }
      else {
        const m = /^[A-Z][a-z]?/.exec(s.slice(i));
        if (!m) throw new Error("can't read " + f);
        i += m[0].length;
        part = { [m[0]]: 1 };
      }
      const k = num();
      for (const [e, c] of Object.entries(part)) out[e] = (out[e] ?? 0) + c * k;
    }
    return out;
  }
  return group();
}
const species = [...view.reactants, ...view.products];
const atoms = species.map(parse);
const nl = view.reactants.length;
const elements = [];
for (const a of atoms) for (const e of Object.keys(a)) if (!elements.includes(e)) elements.push(e);

const c = Array.isArray(answer) ? answer.map(Number) : [];
if (c.length !== species.length || !c.every((x) => Number.isInteger(x) && x >= 1))
  return { score: 0, feedback: "Every species needs a whole-number coefficient of at least 1.", details: { tally: [] } };

const tally = elements.map((e) => {
  let left = 0, right = 0;
  atoms.forEach((a, k) => (k < nl ? (left += (a[e] ?? 0) * c[k]) : (right += (a[e] ?? 0) * c[k])));
  return { element: e, left, right };
});
const off = tally.filter((t) => t.left !== t.right);
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const g = c.reduce((a, b) => gcd(a, b));
if (off.length) {
  return {
    score: 0,
    feedback: `Not balanced: ${off.map((t) => `${t.element} is ${t.left} on the left, ${t.right} on the right`).join("; ")}.`,
    details: { tally, balanced: false },
  };
}
if (g > 1) {
  return {
    score: 0.75,
    feedback: `Balanced, but every coefficient divides by ${g}. The convention is the smallest whole numbers: ${c.map((x) => x / g).join(", ")}.`,
    details: { tally, balanced: true, reduced: false, divisor: g },
  };
}
return { score: 1, details: { tally, balanced: true, reduced: true } };
