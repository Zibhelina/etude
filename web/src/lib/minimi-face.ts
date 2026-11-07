// The face Minimi wears around the app (settings.minimiFace, synced). Holding him opens a fan of faces to
// pick from (components/minimi-faces.tsx). A localStorage copy avoids a flash of the default on load.
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

const files = import.meta.glob("@/assets/minimi/faces/*.webp", { eager: true, import: "default" }) as Record<string, string>;

/** id → image URL, in the order of the fan. */
export const FACES = ["deadpan", "wink", "proud", "smug", "hi", "wand", "close", "curious", "reading", "sleepy", "shocked", "thinking"] as const;
export type FaceId = (typeof FACES)[number];
export const FACE_NAMES: Record<FaceId, string> = { deadpan: "Deadpan", wink: "Wink", proud: "Proud", smug: "Smug", hi: "Hi", wand: "Wand", close: "Close", curious: "Curious", reading: "Reading", sleepy: "Sleepy", shocked: "Shocked", thinking: "Thinking" };
export const faceSrc = (id: FaceId): string => files[Object.keys(files).find((k) => k.endsWith(`/${id}.webp`))!];

const KEY = "etude.minimiFace";
const EVENT = "etude:minimi-face";
const valid = (v: unknown): v is FaceId => typeof v === "string" && (FACES as readonly string[]).includes(v);
let face: FaceId = (() => {
  try {
    const v = localStorage.getItem(KEY);
    return valid(v) ? v : "deadpan";
  } catch {
    return "deadpan";
  }
})();

export const minimiFaceId = () => face;

export function setMinimiFace(id: FaceId, opts: { save?: boolean } = {}) {
  face = id;
  try {
    localStorage.setItem(KEY, id);
  } catch {}
  window.dispatchEvent(new CustomEvent(EVENT, { detail: id }));
  if (opts.save !== false) return api.saveSettings({ minimiFace: id });
}

/** Reads the saved value once, so another device's choice wins over this one's cache. */
export async function loadMinimiFace() {
  try {
    const s = (await api.settings()) as { minimiFace?: string };
    if (valid(s.minimiFace) && s.minimiFace !== face) setMinimiFace(s.minimiFace, { save: false });
  } catch {}
}

export function useMinimiFaceId(): FaceId {
  const [id, setId] = useState(face);
  useEffect(() => {
    const h = () => setId(face);
    window.addEventListener(EVENT, h);
    return () => window.removeEventListener(EVENT, h);
  }, []);
  return id;
}

/** The image URL of the face Minimi wears right now. */
export const useMinimiFace = () => faceSrc(useMinimiFaceId());
