// Little pictures of each block for the "/" menu (src: projects/etude/design/slash-thumbs). Each has a neutral
// picture and an accent mask per scheme; the mask is painted with --primary, so it follows the user's accent.
const files = import.meta.glob<string>("../assets/slash/*.webp", { eager: true, query: "?no-inline", import: "default" });
type Pic = { base: string; accent: string };
const thumbs: Record<string, { light?: Partial<Pic>; dark?: Partial<Pic> }> = {};
for (const [path, url] of Object.entries(files)) {
  const m = /\/([\w-]+?)-(light|dark)(-accent)?\.webp$/.exec(path);
  if (!m) continue;
  const scheme = ((thumbs[m[1]] ??= {})[m[2] as "light" | "dark"] ??= {});
  scheme[m[3] ? "accent" : "base"] = url;
}
const full = (p?: Partial<Pic>): p is Pic => !!p?.base && !!p.accent;
export function slashThumb(id: string): { light: Pic; dark: Pic } | null {
  const t = thumbs[id];
  return t && full(t.light) && full(t.dark) ? { light: t.light, dark: t.dark } : null;
}
