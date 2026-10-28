// Small helpers shared by the engine and its modules.

export const parse = <T>(s: string | null | undefined, fallback: T): T => {
  if (s == null) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export const deckParts = (name: string) => name.split("::").map((s) => s.trim()).filter(Boolean);

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Two piles in one order that finishes both together, given how many of each were done already. Ties go to `a`. */
export function interleave<T>(a: T[], b: T[], doneA = 0, doneB = 0): T[] {
  const out: T[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    const takeA = j >= b.length || (i < a.length && (doneA + i) / (doneA + a.length) <= (doneB + j) / (doneB + b.length));
    out.push(takeA ? a[i++] : b[j++]);
  }
  return out;
}
