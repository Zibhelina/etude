// Parses every formula into atom counts (public: the species are the question) and solves the
// balanced coefficients exactly, by Gaussian elimination over fractions. The solution stays in the key.
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
      if (s[i] === "(") {
        i++;
        part = group();
        if (s[i] !== ")") throw new Error("unclosed ( in " + f);
        i++;
      } else {
        const m = /^[A-Z][a-z]?/.exec(s.slice(i));
        if (!m) throw new Error("can't read " + f + " at " + s.slice(i));
        i += m[0].length;
        part = { [m[0]]: 1 };
      }
      const k = num();
      for (const [e, c] of Object.entries(part)) out[e] = (out[e] ?? 0) + c * k;
    }
    return out;
  }
  const r = group();
  if (i < s.length) throw new Error("stray ) in " + f);
  return r;
}

const species = [...fields.reactants, ...fields.products];
const atoms = species.map(parse);
const nl = fields.reactants.length;
const elements = [];
for (const c of atoms) for (const e of Object.keys(c)) if (!elements.includes(e)) elements.push(e);

// Fractions as [num, den] with small integers.
const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));
const fr = (n, d = 1) => { const g = gcd(n, d) || 1; return d < 0 ? [-n / g, -d / g] : [n / g, d / g]; };
const sub = (a, b) => fr(a[0] * b[1] - b[0] * a[1], a[1] * b[1]);
const mul = (a, b) => fr(a[0] * b[0], a[1] * b[1]);
const div = (a, b) => fr(a[0] * b[1], a[1] * b[0]);

// Rows: elements. Columns: species, products negated. Solve M c = 0.
const n = species.length;
const M = elements.map((e) => atoms.map((c, k) => fr((c[e] ?? 0) * (k < nl ? 1 : -1))));
const pivots = [];
let row = 0;
for (let col = 0; col < n && row < M.length; col++) {
  const p = M.findIndex((r, i) => i >= row && r[col][0] !== 0);
  if (p < 0) continue;
  [M[row], M[p]] = [M[p], M[row]];
  const pv = M[row][col];
  M[row] = M[row].map((x) => div(x, pv));
  for (let i = 0; i < M.length; i++) {
    if (i === row || M[i][col][0] === 0) continue;
    const f = M[i][col];
    M[i] = M[i].map((x, j) => sub(x, mul(f, M[row][j])));
  }
  pivots.push(col);
  row++;
}
let solution = null;
const free = [...Array(n).keys()].filter((c) => !pivots.includes(c));
if (free.length === 1) {
  const fc = free[0];
  const c = new Array(n).fill(null);
  c[fc] = fr(1);
  pivots.forEach((pc, r) => (c[pc] = fr(-M[r][fc][0], M[r][fc][1])));
  const lcm = c.reduce((l, x) => (l * x[1]) / gcd(l, x[1]), 1);
  let ints = c.map((x) => (x[0] * lcm) / x[1]);
  const g = ints.reduce((a, b) => gcd(a, b));
  ints = ints.map((x) => x / g);
  if (ints.every((x) => x < 0)) ints = ints.map((x) => -x);
  if (ints.every((x) => x > 0)) solution = ints;
}
if (!solution) throw new Error("this equation has no single balanced form; check the formulas");

const max = Math.max(Math.max(...solution), Math.min(30, Number(fields.max) || 12));
return {
  view: {
    prompt: fields.prompt ?? "",
    reactants: fields.reactants,
    products: fields.products,
    atoms,
    elements,
    max,
  },
  key: { solution, explanation: fields.explanation ?? "" },
};
