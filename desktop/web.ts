// The web viewer: web pages in a Notebook tab, like Obsidian's. Each is a <webview> in the window's page; this side
// keeps them a plain browser tab and nothing more: their own session (no Etude cookies, no Etude permissions), no
// preload, no Node, and only http(s) pages. What a page would open as a window comes back to the Notebook as a tab.
import { app, clipboard, Menu, nativeTheme, session, shell, webContents, type BrowserWindow, type WebContents } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.ts";

/** Every web tab shares this session, kept apart from Etude's: logins in it stay in it. */
export const WEB_PARTITION = "persist:etude-web";
/** What a page may use. Camera, microphone, location, notifications and the rest are refused. */
const WEB_PERMISSIONS = new Set(["fullscreen", "clipboard-sanitized-write", "pointerLock"]);
/** Keys the Notebook answers even while a page has the keyboard (else Ctrl+W would go to the page and do nothing). */
const APP_KEYS: { key: string; mod?: boolean; alt?: boolean; shift?: boolean; ctrlAlt?: boolean }[] = [
  { key: "k", mod: true },
  { key: "t", mod: true },
  { key: "w", mod: true },
  { key: "l", mod: true },
  { key: ",", mod: true },
  { key: "[", mod: true },
  { key: "]", mod: true },
  { key: "<", mod: true },
  { key: "Tab", mod: true },
  { key: "n", ctrlAlt: true },
  ...["t", "w", "1", "2", "3", "4", "5", "6", "7", "8", "9"].map((key) => ({ key, alt: true })),
];

const isWeb = (url: string) => /^https?:\/\//i.test(url);
const isMac = process.platform === "darwin";

/** Called once, before the window: the web session's rules. */
export function protectWeb() {
  const ses = session.fromPartition(WEB_PARTITION);
  ses.setPermissionRequestHandler((_wc, permission, done) => done(WEB_PERMISSIONS.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => WEB_PERMISSIONS.has(permission));
  // Sites like Google pick dark or light from what they learned on an earlier visit (the color-scheme hint they ask
  // for, a cookie their page sets), so a site's very first page came out light in a dark Etude. The first time a
  // site asks for the hint, its page loads once more after it has settled.
  asked = new Set<string>(readAsked());
  ses.webRequest.onHeadersReceived({ urls: ["https://*/*", "http://*/*"] }, (d, done) => {
    done({});
    if (d.resourceType !== "mainFrame" || !d.webContents) return;
    const ach = Object.entries(d.responseHeaders ?? {}).find(([k]) => k.toLowerCase() === "accept-ch")?.[1]?.join(",") ?? "";
    if (!/prefers-color-scheme/i.test(ach)) return;
    const origin = new URL(d.url).origin;
    if (asked.has(origin)) return;
    asked.add(origin);
    writeAsked([...asked]);
    const wc = d.webContents;
    reloadSettled(d.webContents);
  });
}

/** Sites that pick their look on the server (they asked for the color-scheme hint). */
let asked = new Set<string>();
/** Loads the page again once it has settled (its script has had time to note the scheme in a cookie). */
const reloadSettled = (wc: WebContents) => wc.once("did-stop-loading", () => setTimeout(() => !wc.isDestroyed() && wc.reload(), 1500));

/** Etude's theme went dark or light: pages switch with it. CSS-only pages follow live; the ones that pick their look
 *  on the server (Google) load again, twice, since they answer the new scheme one visit late. */
export function followScheme(s: "light" | "dark" | "system") {
  const before = nativeTheme.shouldUseDarkColors;
  nativeTheme.themeSource = s;
  if (nativeTheme.shouldUseDarkColors === before) return;
  for (const wc of webContents.getAllWebContents()) {
    if (wc.getType() !== "webview" || wc.session !== session.fromPartition(WEB_PARTITION)) continue;
    let origin = "";
    try {
      origin = new URL(wc.getURL()).origin;
    } catch {}
    if (!asked.has(origin)) continue;
    wc.reload();
    reloadSettled(wc);
  }
}

const askedPath = () => join(app.getPath("userData"), "web-color-hint.json");
function readAsked(): string[] {
  try {
    const j = JSON.parse(readFileSync(askedPath(), "utf8"));
    return Array.isArray(j) ? j.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function writeAsked(list: string[]) {
  try {
    writeFileSync(askedPath(), JSON.stringify(list.slice(-500)));
  } catch {}
}

/**
 * Sets up the window to hold web tabs. `own` says whether an address is Etude's (those never load in a web tab,
 * nor does anything that isn't http/https), `outside` opens a link in the system's browser.
 */
export function holdWebTabs(win: BrowserWindow, own: (url: string) => boolean, outside: (url: string) => void) {
  const host = win.webContents;
  host.on("will-attach-webview", (e, prefs, params) => {
    // Only Etude's own page in this window adds web tabs, and only in their session, as an ordinary page.
    if (!own(host.getURL()) || params.partition !== WEB_PARTITION || !(params.src === "about:blank" || isWeb(params.src))) {
      e.preventDefault();
      return log(`refused a web tab (${params.partition || "no session"}, ${String(params.src).split(":")[0]}:)`);
    }
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.nodeIntegrationInSubFrames = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    prefs.webSecurity = true;
    prefs.allowRunningInsecureContent = false;
    prefs.spellcheck = true;
  });
  host.on("did-attach-webview", (_e, guest) => guestRules(win, guest, own, outside));
}

function guestRules(win: BrowserWindow, guest: WebContents, own: (url: string) => boolean, outside: (url: string) => void) {
  const send = (channel: string, payload: object) => {
    if (!win.isDestroyed()) win.webContents.send(channel, { guest: guest.id, ...payload });
  };
  // A link meant for a new window (target=_blank, window.open): a new tab beside this one.
  guest.setWindowOpenHandler(({ url, disposition }) => {
    if (isWeb(url) && !own(url)) send("etude:web-open", { url, background: disposition === "background-tab" });
    else outside(url);
    return { action: "deny" };
  });
  // Pages stay pages: mailto:, an app's own link scheme and the like go to the system; Etude's address never loads here.
  const keepWeb = (e: { preventDefault(): void; url: string; isMainFrame?: boolean }) => {
    if (e.isMainFrame === false) return;
    if (isWeb(e.url) && !own(e.url)) return;
    e.preventDefault();
    if (!own(e.url)) outside(e.url);
  };
  // A trackpad pinch zooms the page in place, smoothly, as Safari and Chrome do (Electron turns it off by default).
  void guest.setVisualZoomLevelLimits(1, 4).catch(() => {});
  guest.on("will-navigate", keepWeb);
  guest.on("will-redirect", keepWeb);
  guest.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    const mod = isMac ? input.meta : input.control;
    const hit = APP_KEYS.find(
      (k) =>
        k.key.toLowerCase() === input.key.toLowerCase() &&
        (k.ctrlAlt ? input.control && input.alt : k.mod ? mod && !input.alt : k.alt ? input.alt && !input.control && !input.meta : false),
    );
    if (!hit) return;
    e.preventDefault();
    send("etude:web-key", { key: input.key, code: input.code, ctrl: input.control, meta: input.meta, alt: input.alt, shift: input.shift });
  });
  guest.on("context-menu", (_e, p) => {
    const items: Electron.MenuItemConstructorOptions[] = [];
    const nav = guest.navigationHistory;
    if (p.linkURL && isWeb(p.linkURL)) {
      items.push(
        { label: "Open Link in New Tab", click: () => send("etude:web-open", { url: p.linkURL, background: false }) },
        { label: "Open Link in Browser", click: () => outside(p.linkURL) },
        { label: "Copy Link", click: () => clipboard.writeText(p.linkURL) },
        { type: "separator" },
      );
    }
    if (p.isEditable) items.push({ role: "cut", enabled: p.editFlags.canCut }, { role: "copy", enabled: p.editFlags.canCopy }, { role: "paste", enabled: p.editFlags.canPaste }, { type: "separator" });
    else if (p.selectionText) items.push({ role: "copy" }, { type: "separator" });
    if (p.mediaType === "image" && p.srcURL) items.push({ label: "Copy Image Address", click: () => clipboard.writeText(p.srcURL) }, { type: "separator" });
    items.push(
      { label: "Back", enabled: nav.canGoBack(), click: () => nav.goBack() },
      { label: "Forward", enabled: nav.canGoForward(), click: () => nav.goForward() },
      { label: "Reload", click: () => guest.reload() },
      { type: "separator" },
      { label: "Open Page in Browser", click: () => outside(guest.getURL()) },
      { label: "Inspect", click: () => guest.inspectElement(p.x, p.y) },
    );
    Menu.buildFromTemplate(items).popup({ window: win });
  });
}

/** The page that has the keyboard, when it's a web tab (the menu's Reload, Back and Forward act on it then). */
export function focusedWebTab(): WebContents | null {
  const wc = webContents.getFocusedWebContents();
  return wc && wc.getType() === "webview" ? wc : null;
}

/** "Open in browser" from a web tab's bar: the system's browser, for http(s) only. */
export function openWebOutside(url: unknown) {
  if (typeof url === "string" && isWeb(url)) void shell.openExternal(url);
}
