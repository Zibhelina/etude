// Pure bounds and step math for the global app zoom level (0.5–2.0, 1 = 100%).
export const APP_ZOOM_MIN = 0.5;
export const APP_ZOOM_MAX = 2;
export const APP_ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;
export const APP_ZOOM_PRESETS = [0.75, 0.9, 1, 1.1, 1.25, 1.5] as const;

export function clampAppZoom(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.round(Math.min(APP_ZOOM_MAX, Math.max(APP_ZOOM_MIN, n)) * 100) / 100;
}

export function stepAppZoom(current: number, by: 1 | -1 | 0): number {
  if (by === 0) return 1;
  const cur = clampAppZoom(current);
  if (by > 0) return APP_ZOOM_STEPS.find((s) => s > cur + 0.005) ?? APP_ZOOM_MAX;
  for (let i = APP_ZOOM_STEPS.length - 1; i >= 0; i--) {
    if (APP_ZOOM_STEPS[i] < cur - 0.005) return APP_ZOOM_STEPS[i];
  }
  return APP_ZOOM_MIN;
}
