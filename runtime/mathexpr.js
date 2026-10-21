// Math answers written in LaTeX or plain text: parse them, evaluate them, print them back as LaTeX,
// and decide whether two answers are the same mathematical object. Plain JavaScript with no
// imports, because it runs in two places: the card runtime imports it, and the server's script
// sandbox includes it as `std.math`.
//
// Equivalence is decided numerically: both expressions are evaluated at many random points and
// must agree wherever both are defined. Equations are equivalent when one is a nonzero multiple of
// the other; lists compare as sets; tuples compare in order.

const FUNCS = ["arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "sqrt", "asin", "acos", "atan", "sin", "cos", "tan", "sec", "csc", "cot", "exp", "abs", "log", "ln"];
const FUNC_ALIAS = { asin: "arcsin", acos: "arccos", atan: "arctan" };
const GREEK = ["varepsilon", "vartheta", "varphi", "epsilon", "upsilon", "lambda", "Lambda", "alpha", "gamma", "Gamma", "delta", "Delta", "theta", "Theta", "kappa", "sigma", "Sigma", "omega", "Omega", "beta", "zeta", "iota", "eta", "rho", "tau", "phi", "Phi", "chi", "psi", "Psi", "mu", "nu", "xi", "Xi"];
const UNICODE = [["⁻¹", "^{-1}"], ["π", "\\pi "], ["θ", "\\theta "], ["α", "\\alpha "], ["β", "\\beta "], ["γ", "\\gamma "], ["δ", "\\delta "], ["λ", "\\lambda "], ["μ", "\\mu "], ["σ", "\\sigma "], ["φ", "\\phi "], ["ω", "\\omega "], ["Δ", "\\Delta "], ["·", "*"], ["⋅", "*"], ["×", "*"], ["÷", "/"], ["−", "-"], ["√", "\\sqrt "], ["∞", "\\infty "], ["²", "^2"], ["³", "^3"]];
const SPACING = new Set(["left", "right", "middle", "big", "Big", "bigl", "bigr", "Bigl", "Bigr", "displaystyle", "textstyle", "quad", "qquad"]);
const WORDS = new Set(["mathrm", "operatorname", "mathit", "mathbf", "text", "textrm"]);

export class MathSyntaxError extends Error {}
const fail = (msg) => { throw new MathSyntaxError(msg); };

// ---------------------------------------------------------------- tokens

function tokenize(input) {
  let s = String(input ?? "");
  for (const [k, v] of UNICODE) s = s.split(k).join(v);
  s = s.replace(/\*\*/g, "^").replace(/\\!|\\,|\\;|\\:|\\ |~/g, " ");
  const out = [];
  const word = (w) => {
    // A run of letters: function names, Greek names, pi, inf, then single-letter variables.
    let i = 0;
    while (i < w.length) {
      const rest = w.slice(i);
      const f = FUNCS.find((n) => rest.startsWith(n));
      if (f) { out.push(f === "sqrt" ? { k: "sqrt" } : { k: "fn", v: FUNC_ALIAS[f] ?? f }); i += f.length; continue; }
      if (rest.startsWith("pi")) { out.push({ k: "const", v: "pi" }); i += 2; continue; }
      const inf = /^inf(inity|ty)?/.exec(rest);
      if (inf) { out.push({ k: "const", v: "inf" }); i += inf[0].length; continue; }
      const g = GREEK.find((n) => n.length > 2 && rest.startsWith(n));
      if (g) { out.push({ k: "id", v: g }); i += g.length; continue; }
      out.push(w[i] === "e" ? { k: "const", v: "e" } : { k: "id", v: w[i] });
      i++;
    }
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "\\") {
      const m = /^\\([A-Za-z]+)/.exec(s.slice(i));
      if (!m) {
        const n = s[i + 1];
        if (n === "{") out.push({ k: "lset" });
        else if (n === "}") out.push({ k: "rset" });
        else if (n === "|") out.push({ k: "|" });
        else fail(`unexpected \\${n ?? ""}`);
        i += 2;
        continue;
      }
      const cmd = m[1];
      i += m[0].length;
      if (SPACING.has(cmd)) {
        // \left( and \right. : drop the command, keep the bracket (or skip the dot).
        while (s[i] === " ") i++;
        if (s[i] === ".") i++;
        continue;
      }
      if (WORDS.has(cmd)) {
        const g = /^\s*\{([^{}]*)\}/.exec(s.slice(i));
        if (!g) fail(`\\${cmd} needs {…}`);
        i += g[0].length;
        const inner = g[1].replace(/\s+/g, "");
        if (inner && /^[A-Za-z]+$/.test(inner)) word(inner);
        continue;
      }
      if (cmd === "cdot" || cmd === "times" || cmd === "ast") out.push({ k: "op", v: "*" });
      else if (cmd === "div") out.push({ k: "op", v: "/" });
      else if (cmd === "frac" || cmd === "dfrac" || cmd === "tfrac") out.push({ k: "frac" });
      else if (cmd === "sqrt") out.push({ k: "sqrt" });
      else if (cmd === "pi") out.push({ k: "const", v: "pi" });
      else if (cmd === "infty") out.push({ k: "const", v: "inf" });
      else if (FUNCS.includes(cmd)) out.push({ k: "fn", v: FUNC_ALIAS[cmd] ?? cmd });
      else if (GREEK.includes(cmd)) out.push({ k: "id", v: cmd });
      else if (cmd === "vert" || cmd === "lvert" || cmd === "rvert") out.push({ k: "|" });
      else if (cmd === "lbrace") out.push({ k: "lset" });
      else if (cmd === "rbrace") out.push({ k: "rset" });
      else fail(`unknown command \\${cmd}`);
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)/.exec(s.slice(i));
      if (!m) fail(`stray "."`);
      out.push({ k: "num", v: Number(m[1]), raw: m[1] });
      i += m[1].length;
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      const m = /^[A-Za-z]+/.exec(s.slice(i));
      word(m[0]);
      i += m[0].length;
      continue;
    }
    if ("+-*/^!_=,".includes(c)) { out.push({ k: "op", v: c }); i++; continue; }
    if ("()[]{}|".includes(c)) { out.push({ k: c }); i++; continue; }
    fail(`unexpected "${c}"`);
  }
  return out;
}

// ---------------------------------------------------------------- parser

/** Parses an answer into a tree. Throws MathSyntaxError with a short message when it can't. */
export function parse(input) {
  const toks = tokenize(input);
  if (!toks.length) fail("empty");
  let i = 0;
  let absDepth = 0;
  const peek = (o = 0) => toks[i + o];
  const isOp = (t, v) => !!t && t.k === "op" && t.v === v;
  const take = (k, what) => {
    if (peek()?.k !== k) fail(`expected ${what}`);
    i++;
  };
  const startsAtom = (t) => !!t && (t.k === "num" || t.k === "id" || t.k === "const" || t.k === "fn" || t.k === "frac" || t.k === "sqrt" || t.k === "(" || t.k === "[" || t.k === "{" || (t.k === "|" && absDepth === 0));

  function top() {
    let set = false;
    if (peek()?.k === "lset") { i++; set = true; }
    const items = [equation()];
    while (isOp(peek(), ",")) { i++; items.push(equation()); }
    if (set) take("rset", "\\}");
    return items.length > 1 || set ? { t: "list", items } : items[0];
  }
  function equation() {
    const a = sum();
    if (isOp(peek(), "=")) { i++; return { t: "eq", a, b: sum() }; }
    return a;
  }
  function sum() {
    let left = product();
    for (;;) {
      if (isOp(peek(), "+")) { i++; left = { t: "add", a: left, b: product() }; }
      else if (isOp(peek(), "-")) { i++; left = { t: "sub", a: left, b: product() }; }
      else return left;
    }
  }
  function product() {
    let left = unary();
    for (;;) {
      const t = peek();
      if (isOp(t, "*")) { i++; left = { t: "mul", a: left, b: unary() }; }
      else if (isOp(t, "/")) { i++; left = { t: "div", a: left, b: unary() }; }
      else if (startsAtom(t)) left = { t: "mul", a: left, b: power(), implicit: true };
      else return left;
    }
  }
  function unary() {
    if (isOp(peek(), "-")) { i++; return { t: "neg", a: unary() }; }
    if (isOp(peek(), "+")) { i++; return unary(); }
    return power();
  }
  function power() {
    const base = postfix();
    if (isOp(peek(), "^")) { i++; return { t: "pow", a: base, b: exponent() }; }
    return base;
  }
  function exponent() {
    if (peek()?.k === "{") { i++; const e = sum(); take("}", "}"); return e; }
    if (isOp(peek(), "-")) { i++; return { t: "neg", a: exponent() }; }
    if (isOp(peek(), "+")) { i++; return exponent(); }
    const b = postfix();
    return isOp(peek(), "^") ? (i++, { t: "pow", a: b, b: exponent() }) : b;
  }
  function postfix() {
    let p = atom();
    while (isOp(peek(), "!")) { i++; p = { t: "fact", a: p }; }
    return p;
  }
  /** Argument of \frac and \sqrt: {…}, (…), or a single token (\frac12 is ½). */
  function group(splitDigits) {
    const t = peek();
    if (t?.k === "{") { i++; const e = sum(); take("}", "}"); return e; }
    if (splitDigits && t?.k === "num" && /^\d{2,}$/.test(t.raw)) {
      toks[i] = { k: "num", v: Number(t.raw.slice(1)), raw: t.raw.slice(1) };
      return { t: "num", v: Number(t.raw[0]) };
    }
    return postfix();
  }
  function subscript() {
    if (!isOp(peek(), "_")) return null;
    i++;
    if (peek()?.k === "{") {
      i++;
      let text = "";
      while (peek() && peek().k !== "}") { const u = toks[i++]; text += u.raw ?? u.v ?? ""; }
      take("}", "}");
      return text;
    }
    const t = toks[i++];
    if (!t || !(t.k === "num" || t.k === "id")) fail("bad subscript");
    if (t.k === "num" && t.raw.length > 1) {
      toks.splice(i, 0, { k: "num", v: Number(t.raw.slice(1)), raw: t.raw.slice(1) });
      return t.raw[0];
    }
    return String(t.raw ?? t.v);
  }
  function bracketed(close, what) {
    const items = [equation()];
    while (isOp(peek(), ",")) { i++; items.push(equation()); }
    take(close, what);
    return items.length > 1 ? { t: "tuple", items } : { t: "paren", a: items[0] };
  }
  function fnArgument() {
    if (peek()?.k === "(") { i++; const e = sum(); take(")", "closing )"); return { t: "paren", a: e }; }
    // \sin 2x and \ln x: the following implicit product, up to the next function.
    let arg = power();
    while (startsAtom(peek()) && peek().k !== "fn") arg = { t: "mul", a: arg, b: power(), implicit: true };
    return arg;
  }
  function atom() {
    const t = peek();
    if (!t) fail("unexpected end");
    i++;
    switch (t.k) {
      case "num": return { t: "num", v: t.v, raw: t.raw };
      case "const": return { t: "const", n: t.v };
      case "id": {
        const sub = subscript();
        return { t: "var", n: sub == null ? t.v : `${t.v}_${sub}` };
      }
      case "(": return bracketed(")", "closing )");
      case "[": return bracketed("]", "closing ]");
      case "{": { const e = sum(); take("}", "}"); return e; }
      case "|": { absDepth++; const e = sum(); absDepth--; take("|", "closing |"); return { t: "fn", n: "abs", a: e }; }
      case "frac": { const a = group(true); const b = group(true); return { t: "div", a, b }; }
      case "sqrt": {
        if (peek()?.k === "[") {
          i++;
          const n = sum();
          take("]", "]");
          return { t: "root", n, a: group(false) };
        }
        return { t: "fn", n: "sqrt", a: group(false) };
      }
      case "fn": {
        let base = null;
        let exp = null;
        if (t.v === "log") { const b = subscript(); if (b != null) base = parse(b); }
        if (isOp(peek(), "^")) { i++; exp = exponent(); }
        const a = fnArgument();
        const inverse = exp && exp.t === "neg" && exp.a.t === "num" && exp.a.v === 1 && ["sin", "cos", "tan"].includes(t.v);
        const node = { t: "fn", n: inverse ? "arc" + t.v : t.v, a };
        if (base) node.base = base;
        return exp && !inverse ? { t: "pow", a: node, b: exp } : node;
      }
      default:
        fail(t.k === "op" ? `unexpected "${t.v}"` : t.k === ")" || t.k === "]" || t.k === "}" ? "unmatched closing bracket" : `unexpected ${t.k}`);
    }
  }

  const tree = top();
  if (i < toks.length) {
    const t = toks[i];
    fail(t.k === "op" ? `unexpected "${t.v}"` : t.k === ")" || t.k === "]" || t.k === "}" ? "unmatched closing bracket" : `unexpected ${t.k}`);
  }
  return tree;
}

// ---------------------------------------------------------------- evaluation

function factorial(n) {
  if (!Number.isInteger(n) || n < 0 || n > 170) return NaN;
  let r = 1;
  for (let k = 2; k <= n; k++) r *= k;
  return r;
}

/** Evaluates an expression tree with variable values from `env`. NaN outside the domain. */
export function evaluate(node, env = {}) {
  const ev = (n) => evaluate(n, env);
  switch (node.t) {
    case "num": return node.v;
    case "const": return node.n === "pi" ? Math.PI : node.n === "e" ? Math.E : Infinity;
    case "var": return node.n in env ? env[node.n] : NaN;
    case "paren": return ev(node.a);
    case "add": return ev(node.a) + ev(node.b);
    case "sub": return ev(node.a) - ev(node.b);
    case "mul": return ev(node.a) * ev(node.b);
    case "div": return ev(node.a) / ev(node.b);
    case "neg": return -ev(node.a);
    case "fact": return factorial(ev(node.a));
    case "pow": {
      const b = ev(node.a), e = ev(node.b);
      if (b < 0 && !Number.isInteger(e)) {
        // Odd roots of negatives, like (-8)^(1/3), are real.
        const inv = 1 / e;
        if (Math.abs(inv - Math.round(inv)) < 1e-9 && Math.round(inv) % 2 !== 0) return -Math.pow(-b, e);
        return NaN;
      }
      return Math.pow(b, e);
    }
    case "root": {
      const n = ev(node.n), a = ev(node.a);
      if (a < 0) return Number.isInteger(n) && n % 2 !== 0 ? -Math.pow(-a, 1 / n) : NaN;
      return Math.pow(a, 1 / n);
    }
    case "fn": {
      const x = ev(node.a);
      switch (node.n) {
        case "sin": return Math.sin(x);
        case "cos": return Math.cos(x);
        case "tan": return Math.tan(x);
        case "sec": return 1 / Math.cos(x);
        case "csc": return 1 / Math.sin(x);
        case "cot": return 1 / Math.tan(x);
        case "arcsin": return Math.asin(x);
        case "arccos": return Math.acos(x);
        case "arctan": return Math.atan(x);
        case "sinh": return Math.sinh(x);
        case "cosh": return Math.cosh(x);
        case "tanh": return Math.tanh(x);
        case "exp": return Math.exp(x);
        case "ln": return x > 0 ? Math.log(x) : NaN;
        case "log": {
          const b = node.base ? ev(node.base) : 10;
          return x > 0 && b > 0 && b !== 1 ? Math.log(x) / Math.log(b) : NaN;
        }
        case "sqrt": return x >= 0 ? Math.sqrt(x) : NaN;
        case "abs": return Math.abs(x);
      }
      return NaN;
    }
    default:
      return NaN;
  }
}

/** Variable names used in a tree. */
export function variables(node, out = new Set()) {
  if (!node || typeof node !== "object") return out;
  if (node.t === "var") out.add(node.n);
  for (const k of ["a", "b", "n", "base"]) if (node[k]) variables(node[k], out);
  if (node.items) for (const it of node.items) variables(it, out);
  return out;
}

// ---------------------------------------------------------------- LaTeX

const PREC = { eq: 0, list: 0, tuple: 9, add: 1, sub: 1, mul: 2, div: 9, neg: 3, pow: 4, fact: 5, fn: 6, root: 9, num: 9, var: 9, const: 9, paren: 9 };
const VAR_TEX = (n) => {
  const [base, sub] = n.split("_");
  const b = GREEK.includes(base) ? `\\${base}` : base;
  return sub != null ? `${b}_{${sub}}` : b;
};
const FN_TEX = { arcsin: "\\arcsin", arccos: "\\arccos", arctan: "\\arctan", sinh: "\\sinh", cosh: "\\cosh", tanh: "\\tanh", sin: "\\sin", cos: "\\cos", tan: "\\tan", sec: "\\sec", csc: "\\csc", cot: "\\cot", ln: "\\ln", log: "\\log" };

/** Prints a tree as LaTeX. What the learner sees is exactly what gets graded. */
export function toLatex(node) {
  const bare = (n) => (n.t === "paren" ? toLatex(n.a) : toLatex(n));
  const wrap = (n, min) => (PREC[n.t] < min ? `\\left(${toLatex(n)}\\right)` : toLatex(n));
  switch (node.t) {
    case "num": return node.raw ?? String(node.v);
    case "const": return node.n === "pi" ? "\\pi" : node.n === "e" ? "e" : "\\infty";
    case "var": return VAR_TEX(node.n);
    case "paren": return `\\left(${toLatex(node.a)}\\right)`;
    case "add": return `${toLatex(node.a)} + ${toLatex(node.b)}`;
    case "sub": return `${toLatex(node.a)} - ${wrap(node.b, 2)}`;
    case "mul": {
      const a = wrap(node.a, 2);
      const b = wrap(node.b, 2);
      const rightNumeric = /^[\d.]/.test(b) || /^-/.test(b);
      const leftEndsNumeric = /[\d.]$/.test(a) && /^[\d.]/.test(b);
      return rightNumeric || leftEndsNumeric || !node.implicit ? (node.implicit && !rightNumeric ? `${a}${b}` : `${a} \\cdot ${b}`) : `${a}${/^[A-Za-z]$/.test(a.slice(-1)) && /^[A-Za-z]/.test(b) ? "\\," : ""}${b}`;
    }
    case "div": return `\\frac{${bare(node.a)}}{${bare(node.b)}}`;
    case "neg": return `-${wrap(node.a, 2)}`;
    case "pow": {
      if (node.a.t === "fn" && FN_TEX[node.a.n] && !node.a.base) return `${FN_TEX[node.a.n]}^{${toLatex(node.b)}}${fnArg(node.a.a)}`;
      return `${wrap(node.a, 5)}^{${bare(node.b)}}`;
    }
    case "fact": return `${wrap(node.a, 9)}!`;
    case "root": return `\\sqrt[${bare(node.n)}]{${bare(node.a)}}`;
    case "fn": {
      if (node.n === "sqrt") return `\\sqrt{${bare(node.a)}}`;
      if (node.n === "abs") return `\\left|${bare(node.a)}\\right|`;
      if (node.n === "exp") return `e^{${bare(node.a)}}`;
      const name = node.n === "log" && node.base ? `\\log_{${toLatex(node.base)}}` : FN_TEX[node.n];
      return `${name}${fnArg(node.a)}`;
    }
    case "eq": return `${toLatex(node.a)} = ${toLatex(node.b)}`;
    case "tuple": return `\\left(${node.items.map(toLatex).join(", ")}\\right)`;
    case "list": return node.items.map(toLatex).join(",\\ ");
  }
  return "";
}
function fnArg(a) {
  if (a.t === "paren") return `\\left(${toLatex(a.a)}\\right)`;
  if (a.t === "var" || a.t === "num" || a.t === "const") return ` ${toLatex(a)}`;
  return `\\left(${toLatex(a)}\\right)`;
}

// ---------------------------------------------------------------- canonical form

/** A string that is equal for two trees with the same structure up to the order of sums and products. */
export function canonical(node) {
  const terms = (n, sign, out) => {
    if (n.t === "paren") return terms(n.a, sign, out);
    if (n.t === "add") { terms(n.a, sign, out); terms(n.b, sign, out); return out; }
    if (n.t === "sub") { terms(n.a, sign, out); terms(n.b, -sign, out); return out; }
    if (n.t === "neg") return terms(n.a, -sign, out);
    out.push((sign < 0 ? "-" : "+") + canonical(n));
    return out;
  };
  const factors = (n, out) => {
    if (n.t === "paren") return factors(n.a, out);
    if (n.t === "mul") { factors(n.a, out); factors(n.b, out); return out; }
    out.push(canonical(n));
    return out;
  };
  switch (node.t) {
    case "paren": return canonical(node.a);
    case "num": return String(node.v);
    case "const": return node.n;
    case "var": return node.n;
    case "add": case "sub": case "neg": {
      const ts = terms(node, 1, []);
      if (ts.length === 1 && node.t === "neg") return `neg(${ts[0].slice(1)})`;
      return `sum(${ts.sort().join(",")})`;
    }
    case "mul": return `prod(${factors(node, []).sort().join(",")})`;
    case "div": return `div(${canonical(node.a)},${canonical(node.b)})`;
    case "pow": return `pow(${canonical(node.a)},${canonical(node.b)})`;
    case "fact": return `fact(${canonical(node.a)})`;
    case "root": return `root(${canonical(node.n)},${canonical(node.a)})`;
    case "fn": return `${node.n}${node.base ? "_" + canonical(node.base) : ""}(${canonical(node.a)})`;
    case "eq": return `eq(${[canonical(node.a), canonical(node.b)].sort().join(",")})`;
    case "tuple": return `tuple(${node.items.map(canonical).join(",")})`;
    case "list": return `list(${node.items.map(canonical).sort().join(",")})`;
  }
  return "?";
}

/** True when the tree contains a decimal number such as 0.5. */
export function hasDecimal(node) {
  if (!node || typeof node !== "object") return false;
  if (node.t === "num" && !Number.isInteger(node.v)) return true;
  return ["a", "b", "n", "base"].some((k) => hasDecimal(node[k])) || (node.items ?? []).some(hasDecimal);
}

// ---------------------------------------------------------------- equivalence

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const close = (x, y, tol) => x === y || Math.abs(x - y) <= tol * Math.max(1, Math.abs(x), Math.abs(y));

/** Random points to compare at: a mixed range first, then positive values for logs and roots. */
function* samples(vars, count) {
  const rnd = prng(0x5eed);
  const names = [...vars];
  for (let k = 0; k < count; k++) {
    const env = {};
    const positive = k >= count / 2;
    for (const n of names) env[n] = positive ? 0.05 + rnd() * 3.95 : -3.7 + rnd() * 7.4;
    yield env;
  }
}

function sameFunction(f, g, vars, tol) {
  let valid = 0;
  for (const env of samples(vars, 48)) {
    const x = evaluate(f, env), y = evaluate(g, env);
    const fx = Number.isFinite(x), fy = Number.isFinite(y);
    if (fx && fy) {
      if (!close(x, y, tol)) return false;
      valid++;
    } else if (fx !== fy) {
      // Defined on one side only. Rounding near a pole can do this, so allow a near-infinite value.
      const v = fx ? x : y;
      if (Math.abs(v) < 1e8) return false;
    }
    if (valid >= 14) return true;
  }
  return valid >= 2;
}

function proportional(f, g, vars, tol) {
  let ratio = null;
  let valid = 0;
  for (const env of samples(vars, 48)) {
    const x = evaluate(f, env), y = evaluate(g, env);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (Math.abs(y) < 1e-12 || Math.abs(x) < 1e-12) {
      if (Math.abs(y) < 1e-9 !== Math.abs(x) < 1e-9) return false;
      continue;
    }
    const r = x / y;
    if (ratio == null) ratio = r;
    else if (!close(r, ratio, tol)) return false;
    if (++valid >= 14) break;
  }
  return valid >= 2 && ratio !== 0;
}

/**
 * Compares two answers (strings or parsed trees). Returns `{ equal, score }`; `score` is partial
 * for lists where only some items match. Options: `tolerance` (relative, default 1e-6) and
 * `ordered` (compare lists in order).
 */
export function equivalent(a, b, opts = {}) {
  const tol = opts.tolerance ?? 1e-6;
  const A = typeof a === "string" ? parse(a) : a;
  const B = typeof b === "string" ? parse(b) : b;
  const vars = new Set([...variables(A), ...variables(B)]);
  const same = (x, y) => equivalent(x, y, { ...opts, ordered: true }).equal;
  if (A.t === "list" || B.t === "list") {
    const xs = A.t === "list" ? A.items : [A];
    const ys = B.t === "list" ? B.items : [B];
    let hits = 0;
    if (opts.ordered) {
      for (let k = 0; k < Math.min(xs.length, ys.length); k++) if (same(xs[k], ys[k])) hits++;
    } else {
      const used = new Set();
      for (const x of xs) {
        const j = ys.findIndex((y, idx) => !used.has(idx) && same(x, y));
        if (j >= 0) { used.add(j); hits++; }
      }
    }
    const score = hits / Math.max(xs.length, ys.length);
    return { equal: score === 1, score };
  }
  if (A.t === "tuple" || B.t === "tuple") {
    const ok = A.t === "tuple" && B.t === "tuple" && A.items.length === B.items.length && A.items.every((x, k) => same(x, B.items[k]));
    return { equal: ok, score: ok ? 1 : 0 };
  }
  if (A.t === "eq" && B.t === "eq") {
    const ok = proportional({ t: "sub", a: A.a, b: A.b }, { t: "sub", a: B.a, b: B.b }, vars, tol);
    return { equal: ok, score: ok ? 1 : 0 };
  }
  if (A.t === "eq" || B.t === "eq") {
    // "x = 3" and "3" agree when the equation just names its variable.
    const [eq, ex] = A.t === "eq" ? [A, B] : [B, A];
    const side = eq.a.t === "var" ? eq.b : eq.b.t === "var" ? eq.a : null;
    const ok = !!side && sameFunction(side, ex, vars, tol);
    return { equal: ok, score: ok ? 1 : 0 };
  }
  const ok = sameFunction(A, B, vars, tol);
  return { equal: ok, score: ok ? 1 : 0 };
}

/** Fewest decimal places among the answer's decimal numbers (how precisely it was rounded), or null. */
function decimals(node, best = null) {
  if (!node || typeof node !== "object") return best;
  if (node.t === "num" && !Number.isInteger(node.v)) {
    const d = (node.raw ?? String(node.v)).split(".")[1]?.length ?? 0;
    best = best == null ? d : Math.min(best, d);
  }
  for (const k of ["a", "b", "n", "base"]) best = decimals(node[k], best);
  for (const it of node.items ?? []) best = decimals(it, best);
  return best;
}

/** Top-level factors of a product, without constant factors. */
function factorsOf(node, out = []) {
  if (node.t === "paren") return factorsOf(node.a, out);
  if (node.t === "neg") return factorsOf(node.a, out);
  if (node.t === "mul") { factorsOf(node.a, out); factorsOf(node.b, out); return out; }
  if (node.t === "pow" && node.b.t === "num" && Number.isInteger(node.b.v) && node.b.v > 1) {
    for (let k = 0; k < node.b.v; k++) factorsOf(node.a, out);
    return out;
  }
  if (variables(node).size) out.push(node);
  return out;
}

/** Same form for "factor this" questions: the same factors, each up to a constant (x - 2 or 2 - x). */
function sameForm(A, B) {
  if (canonical(A) === canonical(B)) return true;
  const fa = factorsOf(A), fb = factorsOf(B);
  if (fb.length < 2 || fa.length !== fb.length) return false;
  const vars = new Set([...variables(A), ...variables(B)]);
  const used = new Set();
  return fa.every((f) => {
    const j = fb.findIndex((g, k) => !used.has(k) && proportional(f, g, vars, 1e-6));
    if (j < 0) return false;
    used.add(j);
    return true;
  });
}

/**
 * Grades an answer against accepted answers. `form`: "any" (any equivalent expression), "exact"
 * (no decimals unless the accepted answer has them) or "same" (also the same form, e.g. factored,
 * up to the order and sign of factors). A decimal that is the right value rounded to the digits
 * given gets half credit when the accepted answer is exact. Returns `{ score, feedback, latex }`.
 */
export function check(answer, accepted, opts = {}) {
  let A;
  try {
    A = parse(answer);
  } catch (e) {
    return { score: 0, feedback: `Couldn't read the answer: ${e.message}.`, latex: null };
  }
  const list = (Array.isArray(accepted) ? accepted : [accepted]).filter((x) => String(x ?? "").trim());
  const places = decimals(A);
  let best = { score: 0, feedback: undefined };
  for (const ref of list) {
    let B;
    try { B = parse(ref); } catch { continue; }
    let r = equivalent(A, B, opts);
    let rounded = false;
    if (!r.equal && places != null && !hasDecimal(B) && !variables(A).size && !variables(B).size && A.t !== "list" && B.t !== "list") {
      // -0.87 for -√3/2: the right value, rounded to the digits given.
      const x = evaluate(A), y = evaluate(B);
      if (Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= 0.5 * 10 ** -places + 1e-12) (r = { equal: true, score: 1 }), (rounded = true);
    }
    let score = r.score;
    let feedback;
    if (r.equal) {
      if (rounded || (opts.form === "exact" && hasDecimal(A) && !hasDecimal(B))) {
        score = 0.5;
        feedback = "Right value, but as a decimal; the question wants it exact.";
      } else if (opts.form === "same" && !sameForm(A, B)) {
        score = 0.5;
        feedback = "Equivalent, but not in the form the question asks for.";
      }
    } else if (score > 0) feedback = "Some of the values are right, not all.";
    if (score > best.score) best = { score, feedback };
    if (best.score === 1) break;
  }
  return { ...best, latex: toLatex(A) };
}

export const math = { parse, evaluate, variables, toLatex, canonical, hasDecimal, equivalent, check, MathSyntaxError };
export default math;
