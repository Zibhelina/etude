// Fractional indexing: string keys that sort between any two others, the way Excalidraw orders a canvas's elements
// (`index` on each element). The algorithm of David Greenspan's fractional-indexing (CC0), which Excalidraw uses,
// written out here so the engine doesn't load a package of the web app's.
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO = DIGITS[0];
const SMALLEST = "A" + ZERO.repeat(26);

function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`${a} >= ${b}`);
  if (a.slice(-1) === ZERO || (b && b.slice(-1) === ZERO)) throw new Error("trailing zero");
  if (b) {
    let n = 0;
    while ((a[n] || ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? DIGITS.indexOf(a[0]) : 0;
  const db = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (db - da > 1) return DIGITS[Math.round(0.5 * (da + db))];
  if (b && b.length > 1) return b.slice(0, 1);
  return DIGITS[da] + midpoint(a.slice(1), null);
}

function integerLength(head: string): number {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - 97 + 2;
  if (head >= "A" && head <= "Z") return 90 - head.charCodeAt(0) + 2;
  throw new Error(`invalid order key head: ${head}`);
}

function integerPart(key: string): string {
  const n = integerLength(key[0]);
  if (n > key.length) throw new Error(`invalid order key: ${key}`);
  return key.slice(0, n);
}

/** Whether a key is one fractional indexing could have made. */
export function validKey(key: unknown): key is string {
  if (typeof key !== "string" || !key || key === SMALLEST) return false;
  try {
    const i = integerPart(key);
    if (key.slice(i.length).slice(-1) === ZERO) return false;
    return [...key].every((c) => DIGITS.includes(c));
  } catch {
    return false;
  }
}

function increment(x: string): string | null {
  const [head, ...digs] = x.split("");
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]) + 1;
    if (d === DIGITS.length) digs[i] = ZERO;
    else (digs[i] = DIGITS[d]), (carry = false);
  }
  if (!carry) return head + digs.join("");
  if (head === "Z") return "a" + ZERO;
  if (head === "z") return null;
  const h = String.fromCharCode(head.charCodeAt(0) + 1);
  if (h > "a") digs.push(ZERO);
  else digs.pop();
  return h + digs.join("");
}

function decrement(x: string): string | null {
  const [head, ...digs] = x.split("");
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]) - 1;
    if (d === -1) digs[i] = DIGITS.slice(-1);
    else (digs[i] = DIGITS[d]), (borrow = false);
  }
  if (!borrow) return head + digs.join("");
  if (head === "a") return "Z" + DIGITS.slice(-1);
  if (head === "A") return null;
  const h = String.fromCharCode(head.charCodeAt(0) - 1);
  if (h < "Z") digs.push(DIGITS.slice(-1));
  else digs.pop();
  return h + digs.join("");
}

/** A key that sorts after `a` and before `b` (either may be null: the start or the end). */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null && !validKey(a)) throw new Error(`invalid order key: ${a}`);
  if (b !== null && !validKey(b)) throw new Error(`invalid order key: ${b}`);
  if (a !== null && b !== null && a >= b) throw new Error(`${a} >= ${b}`);
  if (a === null) {
    if (b === null) return "a" + ZERO;
    const ib = integerPart(b);
    const fb = b.slice(ib.length);
    if (ib === SMALLEST) return ib + midpoint("", fb);
    if (ib < b) return ib;
    const r = decrement(ib);
    if (r === null) throw new Error("cannot decrement any more");
    return r;
  }
  if (b === null) {
    const ia = integerPart(a);
    const i = increment(ia);
    return i === null ? ia + midpoint(a.slice(ia.length), null) : i;
  }
  const ia = integerPart(a);
  const fa = a.slice(ia.length);
  const ib = integerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) return ia + midpoint(fa, fb);
  const i = increment(ia);
  if (i === null) throw new Error("cannot increment any more");
  if (i < b) return i;
  return ia + midpoint(fa, null);
}
