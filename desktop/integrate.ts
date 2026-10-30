// Fitting the app into the system, asked once each: on a Mac, living in Applications (updates need
// it there); from the AppImage, an entry in the app menu (an AppImage is just a file until then).
import { app, dialog, type BrowserWindow } from "electron";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./log.ts";

const prefsPath = () => join(app.getPath("userData"), "desktop.json");

function prefs(): { declined?: string[] } {
  try {
    return JSON.parse(readFileSync(prefsPath(), "utf8"));
  } catch {
    return {};
  }
}

function decline(what: string) {
  const p = prefs();
  writeFileSync(prefsPath(), JSON.stringify({ ...p, declined: [...new Set([...(p.declined ?? []), what])] }));
}

/** True when the app is moving (and restarting from Applications). */
export async function offerApplicationsFolder(win: BrowserWindow): Promise<boolean> {
  if (process.platform !== "darwin" || !app.isPackaged || app.isInApplicationsFolder() || prefs().declined?.includes("applications")) return false;
  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    message: "Move Etude to the Applications folder?",
    detail: "Etude updates itself only from there. It opens again right after moving.",
    buttons: ["Move to Applications", "Not now"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) {
    decline("applications");
    return false;
  }
  try {
    return app.moveToApplicationsFolder();
  } catch (e) {
    log(`couldn't move to Applications: ${(e as Error).message}`);
    return false;
  }
}

const desktopEntry = () => join(homedir(), ".local", "share", "applications", "etude-desktop.desktop");

function entryText(appImage: string): string {
  return ["[Desktop Entry]", "Type=Application", "Name=Etude", "Comment=Spaced repetition with programmable card types", `Exec="${appImage.replaceAll('"', '\\"')}" %U`, "Icon=etude-desktop", "Categories=Education;", "Terminal=false", ""].join("\n");
}

function writeEntry(appImage: string, root: string) {
  const icon = join(homedir(), ".local", "share", "icons", "hicolor", "512x512", "apps", "etude-desktop.png");
  mkdirSync(join(icon, ".."), { recursive: true });
  copyFileSync(join(root, "web", "dist", "icon-512.png"), icon);
  mkdirSync(join(desktopEntry(), ".."), { recursive: true });
  writeFileSync(desktopEntry(), entryText(appImage));
}

/** Offers the app menu entry the first time; afterwards keeps it pointing at the AppImage if it moved. */
export async function offerAppMenuEntry(win: BrowserWindow, root: string) {
  const appImage = process.env.APPIMAGE;
  if (!appImage) return;
  if (existsSync(desktopEntry())) {
    if (readFileSync(desktopEntry(), "utf8") !== entryText(appImage)) writeEntry(appImage, root);
    return;
  }
  if (prefs().declined?.includes("menu")) return;
  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    message: "Add Etude to your app menu?",
    detail: "Then you can open it like any other app. If you move this file later, Etude updates the entry when it opens.",
    buttons: ["Add to app menu", "Not now"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) writeEntry(appImage, root);
  else decline("menu");
}
