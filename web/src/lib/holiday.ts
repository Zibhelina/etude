// Holidays (Settings → Appearance): Minimi's Christmas outfit (Santa hat and scarf, every frame and face),
// a few optional decorations (a garland and a holly sprig on today's session) and
// optional snow. "auto" puts it on from Nov 15 to Jan 6 and takes it off by itself; "on"/"off" force it.
// Saved with the collection (it syncs); a localStorage copy avoids a flash on load. Nothing seasonal shows
// inside a card or the study screen except Minimi's outfit.
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import read from "@/assets/minimi/read.webp";
import look from "@/assets/minimi/look.webp";
import down from "@/assets/minimi/down.webp";
import sitN from "@/assets/minimi/sit-up-n.webp";
import sitL from "@/assets/minimi/sit-up-L.webp";
import sitR from "@/assets/minimi/sit-up-R.webp";
import sitK from "@/assets/minimi/sit-up-blink.webp";
import cheer from "@/assets/library/minimi-cheer.webp";
import xRead from "@/assets/minimi/natal/scan-l.webp"; // his eyes on the left page
import xLook from "@/assets/minimi/natal/look.webp";
import xDown from "@/assets/minimi/natal/scan-r.webp"; // ...and on the right page
import xSitN from "@/assets/minimi/natal/sit-up-n.webp";
import xSitL from "@/assets/minimi/natal/sit-up-L.webp";
import xSitR from "@/assets/minimi/natal/sit-up-R.webp";
import xSitK from "@/assets/minimi/natal/sit-up-blink.webp";
import xCheer from "@/assets/minimi/natal/minimi-cheer.webp";

export const HOLIDAY_MODES = ["auto", "on", "off"] as const;
export const HOLIDAY_DECORS = ["none", "few", "cozy"] as const;
export type HolidayMode = (typeof HOLIDAY_MODES)[number];
export type HolidayDecor = (typeof HOLIDAY_DECORS)[number];
export interface HolidayPrefs {
  holiday: HolidayMode;
  holidayDecor: HolidayDecor;
  holidaySnow: boolean;
}

const KEY = "etude.holiday";
const EVENT = "etude:holiday";
const DEFAULTS: HolidayPrefs = { holiday: "auto", holidayDecor: "few", holidaySnow: false };

const valid = (p: Partial<HolidayPrefs>): HolidayPrefs => ({
  holiday: (HOLIDAY_MODES as readonly string[]).includes(p.holiday as string) ? (p.holiday as HolidayMode) : DEFAULTS.holiday,
  holidayDecor: (HOLIDAY_DECORS as readonly string[]).includes(p.holidayDecor as string) ? (p.holidayDecor as HolidayDecor) : DEFAULTS.holidayDecor,
  holidaySnow: typeof p.holidaySnow === "boolean" ? p.holidaySnow : DEFAULTS.holidaySnow,
});

let prefs: HolidayPrefs = (() => {
  try {
    return valid(JSON.parse(localStorage.getItem(KEY) ?? "{}"));
  } catch {
    return DEFAULTS;
  }
})();

/** Nov 15 to Jan 6, in the device's own calendar. */
export const inSeason = (d = new Date()) => (d.getMonth() === 10 && d.getDate() >= 15) || d.getMonth() === 11 || (d.getMonth() === 0 && d.getDate() <= 6);
export const holidayActive = () => prefs.holiday === "on" || (prefs.holiday === "auto" && inSeason());
export const holidayPrefs = () => prefs;

function apply() {
  const el = document.documentElement;
  if (holidayActive()) el.dataset.holiday = prefs.holidayDecor;
  else delete el.dataset.holiday;
}
apply();

export function setHoliday(patch: Partial<HolidayPrefs>, opts: { save?: boolean } = {}) {
  prefs = valid({ ...prefs, ...patch });
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {}
  apply();
  window.dispatchEvent(new CustomEvent(EVENT, { detail: prefs }));
  if (opts.save !== false) return api.saveSettings(patch);
}

/** Reads the saved value once, so another device's choice wins over this one's cache. */
export async function loadHoliday() {
  try {
    const s = (await api.settings()) as Partial<HolidayPrefs>;
    const next = valid({ ...prefs, ...s });
    if (JSON.stringify(next) !== JSON.stringify(prefs)) setHoliday(next, { save: false });
  } catch {}
}

/** Re-renders when the holiday settings change (and once at midnight, when Auto can flip). */
export function useHoliday(): HolidayPrefs & { active: boolean } {
  const [, tick] = useState(0);
  useEffect(() => {
    const h = () => tick((n) => n + 1);
    window.addEventListener(EVENT, h);
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
    const t = window.setTimeout(() => (apply(), h()), midnight + 1000);
    return () => (window.removeEventListener(EVENT, h), window.clearTimeout(t));
  }, []);
  return { ...prefs, active: holidayActive() };
}

const faces = import.meta.glob("@/assets/minimi/faces/*.webp", { eager: true, import: "default" }) as Record<string, string>;
const xFaces = import.meta.glob("@/assets/minimi/natal/faces/*.webp", { eager: true, import: "default" }) as Record<string, string>;
const OUTFIT = new Map<string, string>([[read, xRead], [look, xLook], [down, xDown], [sitN, xSitN], [sitL, xSitL], [sitR, xSitR], [sitK, xSitK], [cheer, xCheer]]);
for (const [k, v] of Object.entries(faces)) {
  const x = Object.entries(xFaces).find(([xk]) => xk.endsWith("/" + k.split("/").pop()));
  if (x) OUTFIT.set(v, x[1]);
}

/** Minimi's picture in his holiday outfit while the holidays are on; any other URL passes through. */
export const holidayArt = (url: string) => (holidayActive() ? (OUTFIT.get(url) ?? url) : url);

/** holidayArt for components: also re-renders them when the holiday settings change. */
export function useHolidayArt() {
  useHoliday();
  return holidayArt;
}
