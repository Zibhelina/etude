// How this copy of the app gets new versions:
//   self    it downloads them in the background and installs on restart (Windows, the AppImage, a
//           signed Mac app); never in the middle of anything
//   link    it says a new version is out and links to the download (an unsigned Mac app, .deb, .rpm)
//   system  the system's package manager updates it (the AUR)
//   none    a checkout, which the engine's own git updater handles
import { app } from "electron";
import updater from "electron-updater";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.ts";

export type UpdateMode = "self" | "link" | "system" | "none";

export interface UpdateState {
  mode: UpdateMode;
  version: string;
  /** The newer version found (being downloaded until ready). */
  latest: string | null;
  ready: boolean;
  percent: number | null;
  checked: string | null;
  error?: string;
}

const EVERY = 6 * 60 * 60 * 1000;

/** What went wrong, in a line someone can act on. */
function plain(e: unknown): string {
  const m = String((e as Error)?.message ?? e);
  if (/Cannot find latest[\w-]*\.yml/.test(m)) return "The newest release doesn't have this system's update yet.";
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED/.test(m)) return "No connection to GitHub right now.";
  return m.split("\n")[0].slice(0, 160);
}

function updateMode(): UpdateMode {
  if (!app.isPackaged) return "none";
  if (process.platform === "win32" || process.env.APPIMAGE) return "self";
  if (process.platform === "darwin") {
    const info = JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8"));
    return info.etudeDesktop?.macSigned ? "self" : "link";
  }
  // electron-builder marks .deb and .rpm installs; the AUR recipe marks its own as "pacman".
  try {
    return readFileSync(join(process.resourcesPath, "package-type"), "utf8").trim() === "pacman" ? "system" : "link";
  } catch {
    return "link";
  }
}

let state: UpdateState = { mode: "none", version: "", latest: null, ready: false, percent: null, checked: null };
let notify: (s: UpdateState) => void = () => {};

function set(patch: Partial<UpdateState>) {
  state = { ...state, ...patch };
  notify(state);
}

export const updateState = () => state;

export function startUpdates(onChange: (s: UpdateState) => void) {
  notify = onChange;
  state = { ...state, mode: updateMode(), version: app.getVersion() };
  log(`updates: ${state.mode}`);
  if (state.mode !== "self") return;
  const { autoUpdater } = updater;
  autoUpdater.logger = { info: (m) => log(`update: ${m}`), warn: (m) => log(`update: ${m}`), error: (m) => log(`update error: ${m}`), debug: () => {} };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-available", (info) => set({ latest: info.version, percent: 0, error: undefined }));
  autoUpdater.on("download-progress", (p) => set({ percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (info) => set({ latest: info.version, ready: true, percent: 100 }));
  autoUpdater.on("update-not-available", () => set({ latest: null, error: undefined }));
  autoUpdater.on("error", (e) => set({ error: plain(e) }));
  setTimeout(() => void checkForUpdates(), 10_000);
  setInterval(() => void checkForUpdates(), EVERY);
}

export async function checkForUpdates(): Promise<UpdateState> {
  if (state.mode !== "self" || state.ready) return state;
  set({ checked: new Date().toISOString() });
  try {
    await updater.autoUpdater.checkForUpdates();
  } catch (e) {
    set({ error: plain(e) });
  }
  return state;
}

export function restartToUpdate() {
  if (state.ready) updater.autoUpdater.quitAndInstall();
}
