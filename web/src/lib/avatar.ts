// Your picture (Settings → Account, the sidebar, first-run setup). The setting lives with the collection, so it
// syncs; a localStorage copy shows it without a flash on load. src/core/avatar.ts checks and describes the values.
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { AVATAR_CHARACTERS, AVATAR_EMOJI_BG, type Avatar } from "../../../src/core/avatar.ts";

export type { Avatar };
export { AVATAR_EMOJI_BG };

const files = import.meta.glob<string>("../assets/avatars/*.webp", { eager: true, query: "?url", import: "default" });
const url = (id: string) => files[`../assets/avatars/${id}.webp`];

/** The 18 painted characters, in the pickers' order, with their art. */
export const CHARACTERS = AVATAR_CHARACTERS.map((c) => ({ ...c, src: url(c.id) }));
export const characterName = (id: string) => AVATAR_CHARACTERS.find((c) => c.id === id)?.name ?? id;
export const characterSrc = (id: string) => url(id);

export const AVATAR_EMOJI = "🦊 🐸 🐱 🐻 🐼 🐨 🦉 🐧 🐢 🐙 🦄 🐝 🌵 🌻 🍄 🌙 ⭐ 🔥 🌊 ⚡ 🍕 🍩 ☕ 🧋 📚 ✏️ 🎹 🎸 ♟️ 🎯 🧠 🔬 🧪 🌍 🚀 🎨 🧩 👾 🤖 👻".split(" ");
/** Emoji backgrounds: the characters' own poster blue first, then the rest of the poster palette. */
export const AVATAR_BGS = ["#3d5fb8", "#24726e", "#6e3f78", "#d8a43a", "#b84a3c", "#3f6b3a", "#e19aa8", "#24304f", "#d97a3a", "#ece3d3"];

/** What a picture is called next to it: the character's name, or the kind. */
export function avatarLabel(a: Avatar | null | undefined): string {
  if (!a) return "Your initial";
  if (a.kind === "char") return characterName(a.id);
  if (a.kind === "emoji") return "Emoji";
  return "Your photo";
}

export const sameAvatar = (a: Avatar | null | undefined, b: Avatar | null | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const KEY = "etude.avatar";
const EVENT = "etude:avatar";
let current: Avatar | null = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "null");
  } catch {
    return null;
  }
})();

function remember(a: Avatar | null) {
  current = a;
  try {
    localStorage.setItem(KEY, JSON.stringify(a));
  } catch {}
  window.dispatchEvent(new CustomEvent(EVENT));
}

export const avatarNow = () => current;

/** Saves the picture to the collection (it syncs) and shows it everywhere at once. */
export async function saveAvatar(a: Avatar | null): Promise<Avatar | null> {
  const s = (await api.saveSettings({ avatar: a })) as { avatar?: Avatar | null };
  remember(s.avatar ?? null);
  return s.avatar ?? null;
}

/** Reads the saved picture, so another device's choice wins over this one's copy. */
export async function loadAvatar() {
  try {
    const s = (await api.settings()) as { avatar?: Avatar | null };
    const a = s.avatar ?? null;
    if (!sameAvatar(a, current)) remember(a);
  } catch {}
}

export function useAvatar(): Avatar | null {
  const [a, setA] = useState(current);
  useEffect(() => {
    const h = () => setA(current);
    window.addEventListener(EVENT, h);
    h();
    return () => window.removeEventListener(EVENT, h);
  }, []);
  return a;
}

/** Asks whoever shows the picture dialog to open it (the sidebar's avatar, Settings → Account). */
export const OPEN_AVATAR_EVENT = "etude:avatar-open";
export const openAvatarDialog = () => window.dispatchEvent(new Event(OPEN_AVATAR_EVENT));
