// The Etude desktop app: windows showing the engine (`etude serve` from this folder), plus the few things a browser
// tab can't do. The first window is the main one (its size and place are kept, errors show there); New window
// (File, Ctrl+Shift+N, the page's right-click menu) opens more, each with its own tabs (web/src/lib/window-store.ts).
// Card frames keep exactly the access they have in a browser.
import { app, BrowserWindow, dialog, ipcMain, Menu, screen, session, shell, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { commandState, installCommand, refreshAppImageCommand } from "./command.ts";
import { Engine } from "./engine.ts";
import { probeAt, remoteOrigin } from "./find.ts";
import { offerAppMenuEntry, offerApplicationsFolder, remoteSetting } from "./integrate.ts";
import { log, logDir, logEngine } from "./log.ts";
import { loginShellEnv } from "./shell-env.ts";
import { checkForUpdates, restartToUpdate, startUpdates, updateState } from "./updates.ts";
import { focusedWebTab, followScheme, holdWebTabs, openWebOutside, protectWeb } from "./web.ts";

const HERE = import.meta.dirname;
const ROOT = join(HERE, "..");
const PAGES = pathToFileURL(join(HERE, "pages")).href + "/";
const VERSION: string = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const DEFAULT_BG = "#0f0f0f";
const isMac = process.platform === "darwin";
/** What Etude's own pages may use. Everything else (camera, microphone, location, notifications…) is refused. */
const PERMISSIONS = new Set(["clipboard-read", "clipboard-sanitized-write", "fullscreen", "midi", "midiSysex"]);

/** The main window. */
let win: BrowserWindow | null = null;
/** The windows opened after it. */
const extras = new Set<BrowserWindow>();
const allWindows = () => [win, ...extras].filter((w): w is BrowserWindow => !!w && !w.isDestroyed());
/** The window in front (the menu's commands act on it). */
const front = (): BrowserWindow | null => {
  const f = BrowserWindow.getFocusedWindow();
  return f && allWindows().includes(f) ? f : (win ?? allWindows()[0] ?? null);
};
let engine: Engine | null = null;
let env: Record<string, string | undefined> = process.env;
let bg = DEFAULT_BG;
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;
const clampZoom = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(Math.min(2, Math.max(0.5, n)) * 100) / 100 : 1;
};
let zoomFactor = 1;
let booting = false;
let lastCrash = 0;
let watching: NodeJS.Timeout | null = null;
/** Whether the page in each window (by its webContents id) opens web links as Notebook tabs (it says so through the bridge). */
const webLinks = new Map<number, boolean>();

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    const w = front();
    if (!w) return;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", stopEngine);
  app.setAboutPanelOptions({ applicationName: "Etude", applicationVersion: VERSION, website: "https://etude.study" });
  app.whenReady().then(async () => {
    log(`Etude ${VERSION} starting (Electron ${process.versions.electron}, ${process.platform})`);
    protect();
    answer();
    Menu.setApplicationMenu(menu());
    createWindow();
    if (await offerApplicationsFolder(win!)) return;
    // What the app was given wins (the session's display, a test's ETUDE_HOME); the shell adds the
    // rest, and its fuller PATH.
    const shellEnv = await loginShellEnv();
    if (shellEnv) {
      env = { ...shellEnv, ...process.env, PATH: shellEnv.PATH ?? process.env.PATH };
      log(`took PATH and ${Object.keys(shellEnv).length - 1} other settings from the login shell`);
    }
    await boot();
    startUpdates((s) => allWindows().forEach((w) => w.webContents.send("etude:update", s)));
    // Niceties: if one fails, Etude still works.
    try {
      refreshAppImageCommand();
      if (win) await offerAppMenuEntry(win, ROOT);
    } catch (e) {
      log(`couldn't fit into the system: ${(e as Error).message}`);
    }
  });
}

// ---------------------------------------------------------------- engine

/** Starts (or reuses) the engine and shows `path` in it. */
async function boot(path = "/") {
  if (booting || !win) return;
  booting = true;
  stopEngine();
  showPage("starting.html");
  try {
    if (!app.isPackaged && !existsSync(join(ROOT, "web", "dist", "index.html")))
      throw new Error(`The web app isn't built yet. Run \`npm run build\` in ${ROOT}, then try again.`);
    engine = await Engine.start({ root: ROOT, env, log, output: logEngine, remote: remoteOrigin(env.ETUDE_REMOTE ?? remoteSetting()) });
    engine.onExit = stopped;
    log(engine.owned ? `engine ${engine.version} ready at ${engine.origin}` : engine.remote ? `using the Etude at ${engine.origin} (${engine.version}, ${engine.collection})` : `using the engine already running at ${engine.origin} (${engine.version}) for the same collection`);
    if (!engine.owned) watch(engine);
    // The other windows come back to where they were, with their tabs (the engine may be at a new address).
    for (const w of extras) if (!w.isDestroyed()) void w.loadURL(engine.url(withWindow(currentPath(w), "extra"))).catch(() => {});
    await win?.loadURL(engine.url(path));
  } catch (e) {
    log(`couldn't start: ${(e as Error).message}`);
    showError("Etude couldn't start.", (e as Error).message);
  } finally {
    booting = false;
  }
}

// ---------------------------------------------------------------- error reports
// Errors in this main process (and an engine that stopped by itself) are kept in userData until the window opens; the
// page hands them to the engine as anonymous reports, which go out only if Settings → Privacy allows
// (web/src/lib/telemetry.ts, src/core/telemetry.ts). Native crashes of Electron itself aren't covered.
const pendingPath = () => join(app.getPath("userData"), "telemetry-pending.json");
type Pending = { kind: string; message: string; stack?: string };
function readPending(): Pending[] {
  try {
    const j = JSON.parse(readFileSync(pendingPath(), "utf8"));
    return Array.isArray(j) ? j.slice(-20) : [];
  } catch {
    return [];
  }
}
function keepForReport(kind: string, err: unknown) {
  try {
    const e = err as { name?: string; message?: string; stack?: string };
    const list = readPending();
    list.push({ kind, message: String(e?.message ? `${e.name && e.name !== "Error" ? e.name + ": " : ""}${e.message}` : err).slice(0, 2000), stack: String(e?.stack ?? "").slice(0, 16_000) });
    writeFileSync(pendingPath(), JSON.stringify(list.slice(-20)));
  } catch {}
}
process.on("uncaughtException", (err) => {
  log(`uncaught exception in the main process: ${err?.stack ?? err}`);
  keepForReport("desktop.main", err);
});
process.on("unhandledRejection", (reason) => {
  log(`unhandled rejection in the main process: ${(reason as Error)?.stack ?? reason}`);
  keepForReport("desktop.rejection", reason);
});

/** The engine this app started stopped by itself. */
function stopped(code: number) {
  const path = currentPath();
  engine = null;
  if (code === 75) {
    log("the engine is restarting after an update");
    return void boot(path);
  }
  log(`the engine stopped (exit code ${code})`);
  keepForReport("engine.exit", { message: `the engine stopped by itself (exit code ${code})` });
  if (Date.now() - lastCrash > 60_000) {
    lastCrash = Date.now();
    return void boot(path);
  }
  showError("Etude stopped.", `It stopped twice in a minute (exit code ${code}). The logs say why.`);
}

/** An engine started in a terminal (or on another computer) can stop at any time; show it instead of a page that no longer answers. */
function watch(e: Engine) {
  let misses = 0;
  watching = setInterval(async () => {
    if ((await probeAt(e.origin)).kind === "etude") return void (misses = 0);
    // Another computer gets a few tries: a network that blinks shouldn't close the window.
    if (e.remote && ++misses < 3) return;
    stopEngine();
    if (e.remote) showError(`${new URL(e.origin).hostname.split(".")[0]} doesn't answer.`, `This window was showing the Etude at ${e.origin}. Try again opens it again when it answers, or this computer's own collection while it doesn't.`);
    else showError("The Etude engine stopped.", "This window was using the engine started in a terminal (etude serve), which stopped. Try again starts one here.");
  }, 5000);
}

function stopEngine() {
  if (watching) clearInterval(watching);
  watching = null;
  if (engine?.owned) engine.stop();
  engine = null;
}

// ---------------------------------------------------------------- window

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
  bg?: string;
  zoom?: number;
}

const statePath = () => join(app.getPath("userData"), "window.json");

function loadState(): WindowState {
  try {
    const s = JSON.parse(readFileSync(statePath(), "utf8"));
    const box = { x: Number(s.x), y: Number(s.y), width: Number(s.width) || 1180, height: Number(s.height) || 800 };
    // Only where a screen still is (a monitor may be gone).
    const onScreen = screen.getAllDisplays().some(({ workArea: a }) => box.x < a.x + a.width && box.x + box.width > a.x && box.y < a.y + a.height && box.y + box.height > a.y);
    return {
      ...(onScreen ? box : { width: box.width, height: box.height }),
      maximized: !!s.maximized,
      bg: /^#[0-9a-f]{6}$/i.test(s.bg) ? s.bg : undefined,
      zoom: typeof s.zoom === "number" && Number.isFinite(s.zoom) ? clampZoom(s.zoom) : undefined,
    };
  } catch {
    return { width: 1180, height: 800 };
  }
}

function saveState(w: BrowserWindow) {
  if (w !== win) return;
  try {
    writeFileSync(statePath(), JSON.stringify({ ...w.getNormalBounds(), maximized: w.isMaximized(), bg, ...(zoomFactor !== 1 ? { zoom: zoomFactor } : {}) }));
  } catch {}
}

function applyZoomFactor(factor: number, broadcast = true) {
  zoomFactor = clampZoom(factor);
  for (const w of allWindows()) {
    w.webContents.setZoomFactor(zoomFactor);
    if (broadcast) w.webContents.send("etude:zoom", zoomFactor);
  }
  if (win && !win.isDestroyed()) saveState(win);
}

/** `path` with ?window=: "new" starts that window empty, "extra" keeps what it had (web/src/lib/window-store.ts). */
function withWindow(path: string, kind: "new" | "extra"): string {
  const u = new URL(path, "http://etude");
  u.searchParams.set("window", kind);
  return u.pathname + u.search + u.hash;
}

/** Another window showing `path` in the engine, a little below and right of the one in front, the same size. */
function openWindow(path: string) {
  if (!win) return createWindow();
  createWindow(path);
}

function createWindow(extraPath?: string) {
  const extra = extraPath !== undefined;
  const from = extra ? front()?.getNormalBounds() : undefined;
  const state: WindowState = from ? { x: from.x + 32, y: from.y + 32, width: from.width, height: from.height } : loadState();
  if (!extra) {
    bg = state.bg ?? DEFAULT_BG;
    if (state.zoom !== undefined) zoomFactor = state.zoom;
  }
  const w = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    // Narrower or shorter than the desktop layout holds (about 480×400), Minimi's squished face takes over.
    minWidth: 200,
    minHeight: 220,
    title: "Etude",
    backgroundColor: bg,
    show: false,
    autoHideMenuBar: !isMac,
    icon: isMac ? undefined : join(ROOT, "web", "dist", "icon-512.png"),
    webPreferences: {
      preload: join(HERE, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // A spellchecker would underline a misspelled answer before it's graded.
      spellcheck: false,
      // Listening cards play their audio as the card appears.
      autoplayPolicy: "no-user-gesture-required",
      // Web pages in Notebook tabs (web.ts keeps each one an ordinary, separate browser page).
      webviewTag: true,
    },
  });
  if (extra) extras.add(w);
  else win = w;
  if (state.maximized) w.maximize();
  w.once("ready-to-show", () => w.show());
  w.on("close", () => saveState(w));
  const wc = w.webContents;
  const id = wc.id;
  wc.setZoomFactor(zoomFactor);
  wc.on("did-finish-load", () => wc.setZoomFactor(zoomFactor));
  w.on("closed", () => {
    webLinks.delete(id);
    extras.delete(w);
    if (win !== w) return;
    // The main window closed with others still open: the oldest of them becomes the main one.
    win = [...extras][0] ?? null;
    if (win) extras.delete(win);
  });

  // The window's renderer crashing (out of memory, a GPU fault) is kept for an anonymous report too.
  wc.on("render-process-gone", (_e, d) => {
    if (d.reason !== "clean-exit") keepForReport("desktop.renderer", { message: `the window stopped (${d.reason}, exit code ${d.exitCode})` });
  });
  wc.on("did-change-theme-color", (_e, color) => {
    if (color && /^#[0-9a-f]{6}$/i.test(color)) bg = color;
  });
  // Etude's pages stay in the window. A web link goes to the Notebook as a web tab (which may hand it back to the
  // browser: Settings, or no Notebook to show it); anything else opens outside.
  wc.setWindowOpenHandler(({ url }) => {
    if (engine?.contains(url)) void wc.loadURL(url);
    else if (webLinks.get(wc.id) && /^https?:\/\//i.test(url) && engine?.contains(wc.getURL())) wc.send("etude:web-open", { url, guest: null });
    else openOutside(url);
    return { action: "deny" };
  });
  // The page says when it takes web links (a Notebook that can show them, Settings allowing); a new page hasn't yet.
  wc.on("did-navigate", () => webLinks.set(wc.id, false));
  holdWebTabs(w, (url) => !!engine?.contains(url) || url.startsWith(PAGES), openOutside);
  const keepInside = (e: { preventDefault(): void }, url: string) => {
    if (isOwnPage(url)) return;
    e.preventDefault();
    openOutside(url);
  };
  wc.on("will-navigate", keepInside);
  wc.on("will-redirect", keepInside);
  // Card frames too: a card that navigates its own frame elsewhere could carry what it saw in the address. They stay
  // on Etude's pages (the main frame is handled above).
  wc.on("will-frame-navigate", (e) => {
    if (e.isMainFrame || isOwnPage(e.url) || /^about:(blank|srcdoc)$/.test(e.url)) return;
    e.preventDefault();
    log(`stopped a card frame navigating away (${e.url.split(":")[0]}:)`);
  });
  if (extra && engine) void w.loadURL(engine.url(withWindow(extraPath, "new"))).catch(() => {});
  else showPage("starting.html", {}, w);
}

function showPage(name: string, params: Record<string, string> = {}, w: BrowserWindow | null = win) {
  void w?.loadURL(PAGES + name + "?" + new URLSearchParams({ bg, ...params })).catch(() => {});
}

/** In every window: none of them can show Etude without the engine. */
function showError(title: string, detail: string) {
  for (const w of allWindows()) showPage("error.html", { title, detail }, w);
}

const isOwnPage = (url: string) => url.startsWith(PAGES) || !!engine?.contains(url);

/** Where a window is in the engine, without the password, to come back to after a restart. */
function currentPath(w: BrowserWindow | null = win): string {
  const url = w?.webContents.getURL() ?? "";
  if (!engine?.contains(url)) return "/";
  const u = new URL(url);
  u.searchParams.delete("token");
  return u.pathname + u.search + u.hash;
}

function openOutside(url: string) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return;
  }
  if (!["http:", "https:", "mailto:"].includes(u.protocol)) return log(`refused to open a ${u.protocol} link`);
  void shell.openExternal(u.toString());
}

// ---------------------------------------------------------------- permissions and the bridge

function protect() {
  protectWeb();
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, done, details) => done(PERMISSIONS.has(permission) && details.isMainFrame && !!engine?.contains(details.requestingUrl)));
  // Card frames are on the engine's address too, so "top frame only" is what keeps them out.
  ses.setPermissionCheckHandler((_wc, permission, origin, details) => PERMISSIONS.has(permission) && details.isMainFrame && !!engine?.contains(details.requestingUrl || origin));
}

/** The requests in preload.cjs, taken only from a window's top frame showing Etude or the app's own pages. */
function answer() {
  const fromWindow = (e: IpcMainInvokeEvent): BrowserWindow | null =>
    allWindows().find((w) => e.sender === w.webContents && e.senderFrame === w.webContents.mainFrame && isOwnPage(e.senderFrame.url)) ?? null;
  // What keepForReport kept, handed over once (and cleared) when the page starts.
  ipcMain.handle("etude:telemetry-pending", (e) => {
    if (!fromWindow(e)) return [];
    const list = readPending();
    try {
      writeFileSync(pendingPath(), "[]");
    } catch {}
    return list;
  });
  ipcMain.handle("etude:retry", (e) => {
    if (fromWindow(e)) void boot();
  });
  ipcMain.handle("etude:show-logs", (e) => {
    if (fromWindow(e)) void shell.openPath(logDir());
  });
  ipcMain.handle("etude:update-status", (e, check: unknown) => (fromWindow(e) ? (check ? checkForUpdates() : updateState()) : null));
  ipcMain.handle("etude:update-restart", (e) => {
    if (fromWindow(e)) restartToUpdate();
  });
  ipcMain.handle("etude:command-status", (e) => (fromWindow(e) ? commandState(env) : null));
  ipcMain.handle("etude:command-install", async (e) => {
    if (!fromWindow(e)) return null;
    try {
      return await installCommand(env);
    } catch (err) {
      log(`couldn't install the etude command: ${(err as Error).message}`);
      return { ...commandState(env), error: (err as Error).message };
    }
  });
  ipcMain.handle("etude:web-links", (e, on: unknown) => {
    if (fromWindow(e)) webLinks.set(e.sender.id, on === true);
  });
  // Pages in web tabs show their dark or light look with Etude's theme (Google, GitHub… read prefers-color-scheme).
  ipcMain.handle("etude:web-scheme", (e, s: unknown) => {
    if (fromWindow(e) && (s === "light" || s === "dark" || s === "system")) followScheme(s);
  });
  ipcMain.handle("etude:web-outside", (e, url: unknown) => {
    if (fromWindow(e)) openWebOutside(url);
  });
  // Another window, showing an address in the engine ("/notes?id=…").
  ipcMain.handle("etude:new-window", (e, path: unknown) => {
    if (fromWindow(e) && typeof path === "string" && /^\/(?!\/)/.test(path) && path.length < 4000) openWindow(path);
  });
  ipcMain.handle("etude:zoom-get", (e) => (fromWindow(e) ? zoomFactor : 1));
  ipcMain.handle("etude:zoom-set", (e, factor: unknown) => {
    if (!fromWindow(e)) return zoomFactor;
    applyZoomFactor(clampZoom(factor));
    return zoomFactor;
  });
  ipcMain.handle("etude:pick-folder", async (e) => {
    const w = fromWindow(e);
    if (!w) return null;
    // A folder picked here is this computer's, and the collection is on the other one.
    if (engine?.remote) {
      await dialog.showMessageBox(w, { type: "info", message: "Folders open on the computer the collection is on.", detail: `This window shows the Etude at ${engine.origin}. Open the folder there, or type its path on that computer.` });
      return null;
    }
    const r = await dialog.showOpenDialog(w, { properties: ["openDirectory", "createDirectory"] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
}

// ---------------------------------------------------------------- menus

/** Shows an Etude screen in the window in front: inside the running app when it's open, else by loading it. */
function go(path: string) {
  const win = front();
  if (!win || !engine) return;
  if (engine.contains(win.webContents.getURL())) void win.webContents.executeJavaScript(`history.pushState(null, "", ${JSON.stringify(path)}); dispatchEvent(new PopStateEvent("popstate"))`);
  else void win.loadURL(engine.url(path));
}

function reload() {
  const win = front();
  if (win && engine?.contains(win.webContents.getURL())) win.webContents.reload();
  else void boot();
}

/** Zoom: the Notebook's focused pane when the page takes it, else the whole window (saved across launches). */
async function zoom(by: 1 | -1 | 0, whole = false) {
  const wc = front()?.webContents;
  if (!wc) return;
  if (!whole && engine?.contains(wc.getURL())) {
    const done = await wc.executeJavaScript(`globalThis.etudePaneZoom ? globalThis.etudePaneZoom(${by}) : false`).catch(() => false);
    if (done === true) return;
  }
  const next =
    by === 0
      ? 1
      : by > 0
        ? (ZOOM_STEPS.find((s) => s > zoomFactor + 0.005) ?? 2)
        : ([...ZOOM_STEPS].reverse().find((s) => s < zoomFactor - 0.005) ?? 0.5);
  applyZoomFactor(next);
}

function menu(): Menu {
  const settings: MenuItemConstructorOptions = { label: isMac ? "Settings…" : "Settings", accelerator: "CmdOrCtrl+,", click: () => go("/settings") };
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{ label: "Etude", submenu: [{ role: "about" }, { type: "separator" }, settings, { type: "separator" }, { role: "services" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] } as MenuItemConstructorOptions]
      : []),
    {
      label: "File",
      submenu: [
        // The Notebook starts empty in it (a New tab); other screens open as they are.
        { label: "New Window", accelerator: "CmdOrCtrl+Shift+N", click: () => openWindow(currentPath(front()).startsWith("/notes") ? "/notes" : currentPath(front()).split("?")[0]) },
        { type: "separator" },
        { label: "Open in Browser", accelerator: "CmdOrCtrl+Shift+O", click: () => engine && void shell.openExternal(engine.url(currentPath(front()))) },
        { label: "Show Collection Folder", enabled: !engine?.remote, click: () => engine && !engine.remote && shell.showItemInFolder(engine.collection) },
        ...(isMac ? [] : ([{ type: "separator" }, settings] as MenuItemConstructorOptions[])),
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        // With a web tab's page in front (it has the keyboard), these act on the page.
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => (focusedWebTab() ? focusedWebTab()!.reload() : reload()) },
        { label: "Back", accelerator: isMac ? "Cmd+[" : "Alt+Left", click: () => (focusedWebTab() ?? front()?.webContents)?.navigationHistory.goBack() },
        { label: "Forward", accelerator: isMac ? "Cmd+]" : "Alt+Right", click: () => (focusedWebTab() ?? front()?.webContents)?.navigationHistory.goForward() },
        { type: "separator" },
        // In the Notebook these zoom the pane you're in; elsewhere (and with the App items) the whole window.
        { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: () => void zoom(0) },
        { label: "Zoom In", accelerator: "CmdOrCtrl+Plus", click: () => void zoom(1) },
        { label: "Zoom In", accelerator: "CmdOrCtrl+=", visible: false, click: () => void zoom(1) },
        { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => void zoom(-1) },
        {
          label: "Zoom the Whole App",
          submenu: [
            { label: "Actual Size", accelerator: "CmdOrCtrl+Alt+0", click: () => void zoom(0, true) },
            { label: "Zoom In", accelerator: "CmdOrCtrl+Alt+=", click: () => void zoom(1, true) },
            { label: "Zoom Out", accelerator: "CmdOrCtrl+Alt+-", click: () => void zoom(-1, true) },
          ],
        },
        { type: "separator" },
        { role: "togglefullscreen" },
        { type: "separator" },
        { role: "toggleDevTools" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "Etude Website", click: () => void shell.openExternal("https://etude.study") },
        { label: "Report a Problem", click: () => void shell.openExternal("https://github.com/Zibhelina/etude/issues") },
        { type: "separator" },
        { label: "Show Logs", click: () => void shell.openPath(logDir()) },
        ...(isMac ? [] : ([{ type: "separator" }, { role: "about" }] as MenuItemConstructorOptions[])),
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}
