// Runs user-authored JavaScript (generators, prepare and grade scripts) in QuickJS,
// with no host access, a memory cap and a time limit. Only JSON crosses the boundary.
import { getQuickJS, shouldInterruptAfterDeadline, type QuickJSWASMModule } from "quickjs-emscripten";

let quickjs: QuickJSWASMModule | null = null;

export async function initSandbox() {
  quickjs ??= await getQuickJS();
}

export class ScriptError extends Error {
  readonly where: string;
  constructor(message: string, where: string) {
    super(`${where}: ${message}`);
    this.where = where;
  }
}

/** Helpers every script can use. Kept small, pure and deterministic. */
const PRELUDE = String.raw`
function __mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function __makeRng(seed) {
  const next = __mulberry32(seed);
  const rng = {
    seed,
    next,
    int: (min, max) => Math.floor(next() * (max - min + 1)) + min,
    float: (min, max, d = 2) => Number((min + next() * (max - min)).toFixed(d)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    shuffle: (arr) => {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const t = a[i]; a[i] = a[j]; a[j] = t;
      }
      return a;
    },
    bool: (p = 0.5) => next() < p,
  };
  return rng;
}
const std = {
  /** Lowercase, trim, collapse whitespace, drop trailing punctuation. */
  normalize(s) {
    return String(s ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!?;:,]+$/, "").trim();
  },
  looseEqual(a, b) { return std.normalize(a) === std.normalize(b); },
  /** Parses "1.5", "1,5", "3e-3", "1/8", "2*10^3", "(1+2)/4". Returns NaN when it can't. */
  parseNumber(input) {
    let s = String(input ?? "").trim().replace(/\s+/g, "");
    if (!s) return NaN;
    if (/^-?\d+,\d+$/.test(s)) s = s.replace(",", ".");
    s = s.replace(/×|x(?=\d)/g, "*").replace(/\^/g, "**").replace(/−/g, "-");
    if (!/^[0-9eE+\-*/().]+$/.test(s)) return NaN;
    if (/[a-df-zA-DF-Z]/.test(s)) return NaN;
    try {
      const v = Function('"use strict"; return (' + s + ');')();
      return typeof v === "number" && Number.isFinite(v) ? v : NaN;
    } catch { return NaN; }
  },
  /** Relative tolerance check with an absolute floor for answers near zero. */
  within(value, target, tolerance = 0.01) {
    if (!Number.isFinite(value) || !Number.isFinite(target)) return false;
    const diff = Math.abs(value - target);
    return diff <= Math.abs(target) * tolerance || diff <= 1e-12;
  },
  /** Length of the longest increasing subsequence of positions (order partial credit). */
  lis(seq) {
    const tails = [];
    for (const x of seq) {
      let lo = 0, hi = tails.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (tails[m] < x) lo = m + 1; else hi = m; }
      tails[lo] = x;
    }
    return tails.length;
  },
  round(x, digits = 3) {
    if (!Number.isFinite(x) || x === 0) return x;
    const d = Math.max(0, digits - 1 - Math.floor(Math.log10(Math.abs(x))));
    return Number(x.toFixed(Math.min(d, 15)));
  },
};
`;

export interface RunOptions {
  /** Function parameter names, bound in order to `args`. `rng` is created from `seed` when listed. */
  params: string[];
  args: Record<string, unknown>;
  seed?: number;
  timeoutMs?: number;
  where: string;
}

/** Runs `body` as the body of `function (...params)` and returns its JSON-serializable result. */
export function runScript<T = unknown>(body: string, opts: RunOptions): T {
  if (!quickjs) throw new Error("sandbox not initialised; call initSandbox() first");
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(64 * 1024 * 1024);
  runtime.setMaxStackSize(1024 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + (opts.timeoutMs ?? 500)));
  const ctx = runtime.newContext();
  try {
    const bindings = opts.params
      .map((p) => (p === "rng" ? `__makeRng(${Number(opts.seed ?? 1) >>> 0})` : `__args[${JSON.stringify(p)}]`))
      .join(", ");
    const source = `${PRELUDE}
const __args = ${JSON.stringify(opts.args ?? {})};
const __fn = function (${opts.params.join(", ")}) {
${body}
};
JSON.stringify(__fn(${bindings}) ?? null);`;
    const result = ctx.evalCode(source, `${opts.where}.js`);
    if (result.error) {
      const err = ctx.dump(result.error) as { message?: string; name?: string } | string;
      result.error.dispose();
      const msg = typeof err === "string" ? err : `${err?.name ?? "Error"}: ${err?.message ?? JSON.stringify(err)}`;
      throw new ScriptError(msg === "InternalError: interrupted" ? "timed out" : msg, opts.where);
    }
    const text = ctx.getString(result.value);
    result.value.dispose();
    return (text === "undefined" ? null : JSON.parse(text)) as T;
  } finally {
    ctx.dispose();
    runtime.dispose();
  }
}

/** Checks that a script body compiles, without running it. */
export function checkSyntax(body: string, params: string[], where: string): string | null {
  try {
    runScript(`return 0; ${"\n"}function __check(${params.join(", ")}) {\n${body}\n}`, { params: [], args: {}, where });
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
