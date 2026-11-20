// All the page can ask the app for. It runs in the window's top frame only, never in card frames.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("etudeDesktop", {
  platform: process.platform,
  /** A folder picked in the system dialog, or null. */
  pickFolder: () => ipcRenderer.invoke("etude:pick-folder"),
  showLogs: () => ipcRenderer.invoke("etude:show-logs"),
  /** Another Etude window showing `path` ("/notes?id=…"); its Notebook starts with tabs of its own. */
  newWindow: (path) => ipcRenderer.invoke("etude:new-window", String(path)),
  /** Start the engine again (the error page's Try again). */
  retry: () => ipcRenderer.invoke("etude:retry"),
  updates: {
    /** How this copy updates and where that stands; `check` asks GitHub now. */
    status: (check) => ipcRenderer.invoke("etude:update-status", !!check),
    /** Quit and install the downloaded version. */
    restart: () => ipcRenderer.invoke("etude:update-restart"),
    /** Calls back when the state changes; returns the way to stop. */
    onChange: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on("etude:update", listener);
      return () => ipcRenderer.off("etude:update", listener);
    },
  },
  telemetry: {
    /** Errors the app's main process kept for an anonymous report (the page passes them on if Privacy allows). */
    pending: () => ipcRenderer.invoke("etude:telemetry-pending"),
  },
  /** Web pages in Notebook tabs (desktop/web.ts). */
  web: {
    partition: "persist:etude-web",
    /** Whether links clicked in Etude come to the page as web tabs (else they open in the browser). */
    takeLinks: (on) => ipcRenderer.invoke("etude:web-links", !!on),
    /** Whether pages show their light or dark look: "light", "dark" or "system". */
    scheme: (s) => ipcRenderer.invoke("etude:web-scheme", String(s)),
    /** A link the window or a web tab's page wants opened: { url, guest (the page's webContents id, or null), background }. */
    onOpen: (callback) => {
      const listener = (_event, d) => callback(d);
      ipcRenderer.on("etude:web-open", listener);
      return () => ipcRenderer.off("etude:web-open", listener);
    },
    /** An app shortcut pressed while a web page had the keyboard: { key, code, ctrl, meta, alt, shift, guest }. */
    onKey: (callback) => {
      const listener = (_event, d) => callback(d);
      ipcRenderer.on("etude:web-key", listener);
      return () => ipcRenderer.off("etude:web-key", listener);
    },
    /** The system's browser, for http(s) addresses. */
    outside: (url) => ipcRenderer.invoke("etude:web-outside", String(url)),
  },
  command: {
    /** Where `etude` is on the PATH and whether the app can install its own. */
    status: () => ipcRenderer.invoke("etude:command-status"),
    install: () => ipcRenderer.invoke("etude:command-install"),
  },
});
