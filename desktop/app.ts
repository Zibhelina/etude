// The Etude desktop app: one window showing the engine (`etude serve` from this folder), plus the few
// things a browser tab can't do. Card frames keep exactly the access they have in a browser.
import { app, BrowserWindow, dialog, ipcMain, Menu, screen, session, shell, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { commandState, installCommand, refreshAppImageCommand } from "./command.ts";
import { Engine } from "./engine.ts";
import { probe } from "./find.ts";
import { offerAppMenuEntry, offerApplicationsFolder } from "./integrate.ts";
import { log, logDir, logEngine } from "./log.ts";
import { loginShellEnv } from "./shell-env.ts";
import { checkForUpdates, restartToUpdate, startUpdates, updateState } from "./updates.ts";

const HERE = import.meta.dirname;
const ROOT = join(HERE, "..");
const PAGES = pathToFileURL(join(HERE, "pages")).href + "/";
const VERSION: string = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const DEFAULT_BG = "#0f0f0f";
const isMac = process.platform === "darwin";
/** What Etude's own pages may use. Everything else (camera, microphone, location, notifications…) is refused. */
const PERMISSIONS = new Set(["clipboard-read", "clipboard-sanitized-write", "fullscreen"]);

let win: BrowserWindow | null = null;
let engine: Engine | null = null;
let env: Record<string, string | undefined> = process.env;
let bg = DEFAULT_BG;
let booting = false;
let lastCrash = 0;
let watching: NodeJS.Timeout | null = null;

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
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
    startUpdates((s) => win?.webContents.send("etude:update", s));
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
    engine = await Engine.start({ root: ROOT, env, log, output: logEngine });
    engine.onExit = stopped;
    log(engine.owned ? `engine ${engine.version} ready at ${engine.origin}` : `using the engine already running at ${engine.origin} (${engine.version}) for the same collection`);
    if (!engine.owned) watch(engine);
    await win?.loadURL(engine.url(path));
  } catch (e) {
    log(`couldn't start: ${(e as Error).message}`);
    showError("Etude couldn't start.", (e as Error).message);
  } finally {
    booting = false;
  }
}

/** The engine this app started stopped by itself. */
function stopped(code: number) {
  const path = currentPath();
  engine = null;
  if (code === 75) {
    log("the engine is restarting after an update");
    return void boot(path);
  }
  log(`the engine stopped (exit code ${code})`);
  if (Date.now() - lastCrash > 60_000) {
    lastCrash = Date.now();
    return void boot(path);
  }
  showError("Etude stopped.", `It stopped twice in a minute (exit code ${code}). The logs say why.`);
}

/** An engine started in a terminal can stop at any time; show it instead of a page that no longer answers. */
function watch(e: Engine) {
  const port = Number(new URL(e.origin).port);
  watching = setInterval(async () => {
    if ((await probe(port)).kind === "etude") return;
    stopEngine();
    showError("The Etude engine stopped.", "This window was using the engine started in a terminal (etude serve), which stopped. Try again starts one here.");
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
}

const statePath = () => join(app.getPath("userData"), "window.json");

function loadState(): WindowState {
  try {
    const s = JSON.parse(readFileSync(statePath(), "utf8"));
    const box = { x: Number(s.x), y: Number(s.y), width: Number(s.width) || 1180, height: Number(s.height) || 800 };
    // Only where a screen still is (a monitor may be gone).
    const onScreen = screen.getAllDisplays().some(({ workArea: a }) => box.x < a.x + a.width && box.x + box.width > a.x && box.y < a.y + a.height && box.y + box.height > a.y);
    return { ...(onScreen ? box : { width: box.width, height: box.height }), maximized: !!s.maximized, bg: /^#[0-9a-f]{6}$/i.test(s.bg) ? s.bg : undefined };
  } catch {
    return { width: 1180, height: 800 };
  }
}

function saveState() {
  if (!win) return;
  try {
    writeFileSync(statePath(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized(), bg }));
  } catch {}
}

function createWindow() {
  const state = loadState();
  bg = state.bg ?? DEFAULT_BG;
  win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 360,
    minHeight: 480,
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
    },
  });
  if (state.maximized) win.maximize();
  win.once("ready-to-show", () => win?.show());
  win.on("close", saveState);
  win.on("closed", () => (win = null));

  const wc = win.webContents;
  wc.on("did-change-theme-color", (_e, color) => {
    if (color && /^#[0-9a-f]{6}$/i.test(color)) bg = color;
  });
  // Etude's pages stay in the window; every other link opens in the browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (engine?.contains(url)) void wc.loadURL(url);
    else openOutside(url);
    return { action: "deny" };
  });
  const keepInside = (e: { preventDefault(): void }, url: string) => {
    if (isOwnPage(url)) return;
    e.preventDefault();
    openOutside(url);
  };
  wc.on("will-navigate", keepInside);
  wc.on("will-redirect", keepInside);
  showPage("starting.html");
}

function showPage(name: string, params: Record<string, string> = {}) {
  void win?.loadURL(PAGES + name + "?" + new URLSearchParams({ bg, ...params })).catch(() => {});
}

function showError(title: string, detail: string) {
  showPage("error.html", { title, detail });
}

const isOwnPage = (url: string) => url.startsWith(PAGES) || !!engine?.contains(url);

/** Where the window is in the engine, without the password, to come back to after a restart. */
function currentPath(): string {
  const url = win?.webContents.getURL() ?? "";
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
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, done, details) => done(PERMISSIONS.has(permission) && details.isMainFrame && !!engine?.contains(details.requestingUrl)));
  // Card frames are on the engine's address too, so "top frame only" is what keeps them out.
  ses.setPermissionCheckHandler((_wc, permission, origin, details) => PERMISSIONS.has(permission) && details.isMainFrame && !!engine?.contains(details.requestingUrl || origin));
}

/** The requests in preload.cjs, taken only from this window's top frame showing Etude or the app's own pages. */
function answer() {
  const fromWindow = (e: IpcMainInvokeEvent) => !!win && e.sender === win.webContents && e.senderFrame === win.webContents.mainFrame && isOwnPage(e.senderFrame.url);
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
  ipcMain.handle("etude:pick-folder", async (e) => {
    if (!fromWindow(e) || !win) return null;
    const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
}

// ---------------------------------------------------------------- menus

/** Shows an Etude screen: inside the running app when it's open, else by loading it. */
function go(path: string) {
  if (!win || !engine) return;
  if (engine.contains(win.webContents.getURL())) void win.webContents.executeJavaScript(`history.pushState(null, "", ${JSON.stringify(path)}); dispatchEvent(new PopStateEvent("popstate"))`);
  else void win.loadURL(engine.url(path));
}

function reload() {
  if (win && engine?.contains(win.webContents.getURL())) win.webContents.reload();
  else void boot();
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
        { label: "Open in Browser", accelerator: "CmdOrCtrl+Shift+O", click: () => engine && void shell.openExternal(engine.url(currentPath())) },
        { label: "Show Collection Folder", click: () => engine && shell.showItemInFolder(engine.collection) },
        ...(isMac ? [] : ([{ type: "separator" }, settings] as MenuItemConstructorOptions[])),
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: reload },
        { label: "Back", accelerator: isMac ? "Cmd+[" : "Alt+Left", click: () => win?.webContents.navigationHistory.goBack() },
        { label: "Forward", accelerator: isMac ? "Cmd+]" : "Alt+Right", click: () => win?.webContents.navigationHistory.goForward() },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomIn", accelerator: "CmdOrCtrl+=", visible: false },
        { role: "zoomOut" },
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
