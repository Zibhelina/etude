// Your banner: the cover behind your picture at the top of Settings → Account & Sync. Null follows your picture
// (the characters' poster blue, an emoji's colour, a blurred copy of your photo, a soft green for the initial);
// otherwise one of the colours and patterns below, or an image of your own in the collection's media (so Sync
// carries it), with where it sits vertically.

/** A value that isn't a banner. The engine turns it into a validation error. */
export class BannerError extends Error {}

export type BannerPattern = "spark" | "dots" | "lines" | "waves" | "stars" | "";

/** The colours and patterns, in the order the picker shows them. `bg` is a CSS colour or gradient; `ink` the pattern's colour. */
export const BANNER_PRESETS: { id: string; bg: string; pattern: BannerPattern; ink: string; light?: boolean }[] = [
  { id: "sky", bg: "#3d5fb8", pattern: "spark", ink: "#fff" },
  { id: "teal", bg: "#24726e", pattern: "dots", ink: "#fff" },
  { id: "plum", bg: "#6e3f78", pattern: "spark", ink: "#fff" },
  { id: "mustard", bg: "#d8a43a", pattern: "lines", ink: "#fff" },
  { id: "brick", bg: "#b84a3c", pattern: "waves", ink: "#fff" },
  { id: "moss", bg: "#3f6b3a", pattern: "dots", ink: "#fff" },
  { id: "rose", bg: "#e19aa8", pattern: "spark", ink: "#fff" },
  { id: "night", bg: "#24304f", pattern: "stars", ink: "#fff" },
  { id: "dawn", bg: "linear-gradient(115deg, #f2b36b, #e47a6b 45%, #7a5fb8)", pattern: "", ink: "#fff" },
  { id: "sea", bg: "linear-gradient(120deg, #2d6a8f, #46a6a0 55%, #c9e3a3)", pattern: "", ink: "#fff" },
  { id: "paper", bg: "#ece3d3", pattern: "lines", ink: "#1f1d18", light: true },
  { id: "ink", bg: "#1f1d18", pattern: "stars", ink: "#fff" },
];

export type Banner = { kind: "preset"; id: string } | { kind: "image"; media: string; y: number };

const IMAGE = /^files\/[0-9a-f]{64}\.(?:png|jpg|gif|webp|avif|bmp)$/;

const fail = (why: string): never => {
  throw new BannerError(`banner ${why}. Use null (match your picture), {kind:"preset",id} or {kind:"image",media:"files/<sha256>.<ext>",y:0..100}; or the short forms match, <preset id>, preset:<id>, image:files/…[:y]`);
};

/**
 * Reads a stored or typed banner. Accepts the object forms and, for the CLI, `match`/`auto`/`none`/empty (null),
 * a bare preset id, `preset:<id>` and `image:files/<sha>.<ext>` with an optional `:<y>`.
 */
export function normalizeBanner(v: unknown): Banner | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s || s === "match" || s === "auto" || s === "none" || s === "null") return null;
    if (s.startsWith("image:")) {
      const m = /^image:(?:media:)?(.+?)(?::(-?\d+(?:\.\d+)?))?$/.exec(s)!;
      return normalizeBanner({ kind: "image", media: m[1], y: m[2] === undefined ? 50 : Number(m[2]) });
    }
    return normalizeBanner({ kind: "preset", id: s.replace(/^preset:/, "") });
  }
  if (typeof v !== "object" || Array.isArray(v)) return fail("must be an object or null");
  const o = v as Record<string, unknown>;
  // Sync rebuilds a banner that was cleared as an empty object: its fields are gone, the parent comes back as {}.
  if (!Object.keys(o).length || o.kind === "match" || o.kind === "auto") return null;
  if (o.kind === "preset") {
    const id = String(o.id ?? "").trim().toLowerCase();
    if (!BANNER_PRESETS.some((p) => p.id === id)) fail(`preset "${id.slice(0, 30)}" doesn't exist (presets: ${BANNER_PRESETS.map((p) => p.id).join(", ")})`);
    return { kind: "preset", id };
  }
  if (o.kind === "image") {
    const media = String(o.media ?? "").trim().replace(/^media:/, "");
    if (!IMAGE.test(media)) fail("image must be a picture in the collection's media, files/<sha256>.<ext>");
    const y = o.y === undefined || o.y === null ? 50 : typeof o.y === "string" && o.y.trim() ? Number(o.y) : o.y;
    if (typeof y !== "number" || !Number.isFinite(y) || y < 0 || y > 100) fail("image position y must be a number from 0 (top) to 100 (bottom)");
    return { kind: "image", media, y: Math.round((y as number) * 10) / 10 };
  }
  return fail("kind must be preset or image");
}
