// Your picture: one of Etude's characters, an emoji on a colour, a photo of your own (a cropped image in the
// collection's media, so Sync carries it), or nothing, which shows the first letter of your name.
/** A value that isn't an avatar. The engine turns it into a validation error. */
export class AvatarError extends Error {}

/** The painted characters the app ships, in the order the pickers show them. */
export const AVATAR_CHARACTERS: { id: string; name: string }[] = [
  { id: "wizard", name: "Wiz" },
  { id: "seal", name: "Selkie" },
  { id: "bear", name: "Bramble" },
  { id: "bunny", name: "Folio" },
  { id: "owl", name: "Dean" },
  { id: "frog", name: "Lily" },
  { id: "ash", name: "Ash" },
  { id: "crown", name: "Your Majesty" },
  { id: "fox", name: "Rook" },
  { id: "juniper", name: "Juniper" },
  { id: "theo", name: "Theo" },
  { id: "rosa", name: "Rosa" },
  { id: "kenji", name: "Kenji" },
  { id: "walter", name: "Walter" },
  { id: "amira", name: "Amira" },
  { id: "sam", name: "Sam" },
  { id: "ines", name: "Inês" },
  { id: "omar", name: "Omar" },
];

/** The background an emoji gets when none is given. */
export const AVATAR_EMOJI_BG = "#3d5fb8";

export type Avatar = { kind: "char"; id: string } | { kind: "emoji"; e: string; bg: string } | { kind: "photo"; media: string };

const HEX = /^#[0-9a-f]{6}$/;
const PHOTO = /^files\/[0-9a-f]{64}\.(?:png|jpg|gif|webp|avif|bmp)$/;

/** One emoji, which can be several code points (flags, skin tones, joined sequences), and nothing else. */
export function isOneEmoji(s: string): boolean {
  return [...s].length <= 12 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s) && !/[\s\p{L}\p{N}]/u.test(s.replace(/[\u{1F1E6}-\u{1F1FF}]/gu, ""));
}

const fail = (why: string): never => {
  throw new AvatarError(`avatar ${why}. Use null (your initial), {kind:"char",id}, {kind:"emoji",e,bg} or {kind:"photo",media:"files/<sha256>.<ext>"}; or the short forms char:<id>, emoji:<emoji>[:#rrggbb], photo:files/…`);
};

/**
 * Reads a stored or typed avatar. Accepts the object forms and, for the CLI, `initial`/`none`/empty (null),
 * a bare character id, `char:<id>`, `emoji:<emoji>` or `emoji:<emoji>:#rrggbb`, and `photo:files/<sha>.<ext>`.
 */
export function normalizeAvatar(v: unknown): Avatar | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s || s === "initial" || s === "none" || s === "null") return null;
    if (s.startsWith("emoji:")) {
      const rest = s.slice(6);
      const m = /^(.*?)(?::(#[0-9a-fA-F]{6}))?$/su.exec(rest)!;
      return normalizeAvatar({ kind: "emoji", e: m[1], bg: m[2] ?? AVATAR_EMOJI_BG });
    }
    if (s.startsWith("photo:")) return normalizeAvatar({ kind: "photo", media: s.slice(6) });
    return normalizeAvatar({ kind: "char", id: s.replace(/^char:/, "") });
  }
  if (typeof v !== "object" || Array.isArray(v)) return fail("must be an object or null");
  const o = v as Record<string, unknown>;
  // Sync rebuilds a picture that was cleared as an empty object: its fields are gone, the parent comes back as {}.
  if (!Object.keys(o).length) return null;
  if (o.kind === "char") {
    const id = String(o.id ?? "").trim().toLowerCase();
    if (!AVATAR_CHARACTERS.some((c) => c.id === id)) fail(`character "${id.slice(0, 30)}" doesn't exist (characters: ${AVATAR_CHARACTERS.map((c) => c.id).join(", ")})`);
    return { kind: "char", id };
  }
  if (o.kind === "emoji") {
    const e = String(o.e ?? "").trim();
    const bg = String(o.bg ?? AVATAR_EMOJI_BG).trim().toLowerCase();
    if (!e || !isOneEmoji(e)) fail("emoji must be one emoji");
    if (!HEX.test(bg)) fail("emoji background must be a #rrggbb color");
    return { kind: "emoji", e, bg };
  }
  if (o.kind === "photo") {
    const media = String(o.media ?? "").trim().replace(/^media:/, "");
    if (!PHOTO.test(media)) fail("photo must be an image in the collection's media, files/<sha256>.<ext>");
    return { kind: "photo", media };
  }
  return fail(`kind must be char, emoji or photo`);
}
