// Colors for other people in a shared space: their caret, selection, avatar and activity bars. Stable per account
// (a hash of its id), from a fixed palette of 8 that leaves out the hues near this user's own accent, so a
// collaborator never looks like the app's own highlight.
import { ACCENTS } from "../themes.ts";

/** Mid tones that read on light and dark backgrounds alike, dark enough for a white name on them. */
const CANDIDATES = ["#4775d6", "#8058de", "#d6467f", "#d04a3c", "#c9661c", "#b4870f", "#1d968a", "#33994a", "#5562cc", "#1a8fb3", "#a64c95", "#6f8024"];

const hue = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return null;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};
const apart = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

/** The 8 colors for an accent (a preset id, #rrggbb, or null for the theme's own: Etude's green). */
export function presencePalette(accent: string | null | undefined): string[] {
  const hex = ACCENTS.find((a) => a.id === (accent ?? "green"))?.light ?? (/^#[0-9a-f]{6}$/i.test(accent ?? "") ? accent! : null);
  const h = hex ? hue(hex) : null;
  // Graphite and greys have no hue to avoid: the first 8 are fine.
  const ok = h === null ? CANDIDATES : CANDIDATES.filter((c) => apart(hue(c)!, h) >= 28);
  return [...ok, ...CANDIDATES.filter((c) => !ok.includes(c))].slice(0, 8);
}

/** FNV-1a over the account id: the same person gets the same color on every device with the same accent. */
export function presenceColor(accountId: string, accent: string | null | undefined): string {
  let x = 0x811c9dc5;
  for (let i = 0; i < accountId.length; i++) x = Math.imul(x ^ accountId.charCodeAt(i), 0x01000193) >>> 0;
  const p = presencePalette(accent);
  return p[x % p.length];
}
