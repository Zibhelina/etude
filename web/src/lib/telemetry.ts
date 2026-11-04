// The app window's side of the anonymous error reports and usage counts (src/core/telemetry.ts has the rules and
// the queue). Uncaught errors, rejected promises and React render errors go to the core as reports; `track()` adds
// to a usage counter. The core drops them unless the Privacy toggles allow, scrubs them and sends them in batches.
// Nothing here runs in a dev build, in an automated browser (unless ETUDE_TELEMETRY=1) or when the core says this app
// doesn't send (the `etude serve` an agent started, ETUDE_TELEMETRY=0).
import { api } from "@/lib/api";

let state: "unknown" | "on" | "off" = "unknown";
let ready: Promise<void> | null = null;
let checkedAt = 0;
const recent = new Map<string, number>();
let sentThisMinute = 0;
let minute = 0;

// Noise browsers raise that says nothing about Etude.
const IGNORE = [/ResizeObserver loop/i, /^Script error\.?$/i, /Load failed$/i, /Failed to fetch$/i, /NetworkError when attempting/i, /The operation was aborted/i];

function check(): Promise<void> {
  // "Off" is looked at again after a minute (an engine restarting, a core still starting up).
  if (ready && state === "off" && Date.now() - checkedAt > 60_000) ready = null;
  if (!ready) checkedAt = Date.now();
  if (!ready)
    ready = api.telemetry().then(
      (t) => {
        // Automated browsers (tests, scripts) send nothing unless ETUDE_TELEMETRY=1 says so.
        const automated = !!(navigator as { webdriver?: boolean }).webdriver || /HeadlessChrome/.test(navigator.userAgent);
        state = t.active && (!automated || t.forced) ? "on" : "off";
      },
      () => {
        state = "off";
      },
    );
  return ready;
}

/** Sends an error to the core as an anonymous report (at most 10 a minute, each distinct message once a minute). */
export function reportError(kind: string, err: unknown) {
  if (import.meta.env.DEV) return;
  const e = err as { name?: string; message?: string; stack?: string } | undefined;
  const message = e && typeof e === "object" && e.message ? `${e.name ?? "Error"}: ${e.message}` : String(err);
  if (IGNORE.some((r) => r.test(message))) return;
  const now = Date.now();
  if (now - minute > 60_000) (minute = now), (sentThisMinute = 0);
  if (sentThisMinute >= 10 || now - (recent.get(message) ?? 0) < 60_000) return;
  recent.set(message, now);
  sentThisMinute++;
  void check().then(() => {
    if (state === "on") void api.telemetryReport({ kind, message, stack: typeof e?.stack === "string" ? e.stack : "" }).catch(() => {});
  });
}

/** Adds one to a usage counter (counted only when the person turned usage stats on). */
export function track(name: string) {
  if (import.meta.env.DEV) return;
  void check().then(() => {
    if (state === "on") void api.telemetryEvent(name).catch(() => {});
  });
}

type DesktopTelemetry = { pending?: () => Promise<{ kind: string; message: string; stack?: string }[]> };

/** Listens for uncaught errors, counts the day's first open, and passes on what the desktop app's main process kept. */
export function startTelemetry() {
  if (import.meta.env.DEV) return;
  window.addEventListener("error", (ev) => reportError("window.error", ev.error ?? ev.message));
  window.addEventListener("unhandledrejection", (ev) => reportError("window.rejection", ev.reason));
  track("app.open");
  const desk = (globalThis as { etudeDesktop?: { telemetry?: DesktopTelemetry } }).etudeDesktop?.telemetry;
  void desk?.pending?.()
    .then((list) => {
      for (const r of list ?? [])
        void check().then(() => {
          if (state === "on") void api.telemetryReport(r).catch(() => {});
        });
    })
    .catch(() => {});
}
