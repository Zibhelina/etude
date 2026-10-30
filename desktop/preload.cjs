// All the page can ask the app for. It runs in the window's top frame only, never in card frames.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("etudeDesktop", {
  platform: process.platform,
  /** A folder picked in the system dialog, or null. */
  pickFolder: () => ipcRenderer.invoke("etude:pick-folder"),
  showLogs: () => ipcRenderer.invoke("etude:show-logs"),
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
  command: {
    /** Where `etude` is on the PATH and whether the app can install its own. */
    status: () => ipcRenderer.invoke("etude:command-status"),
    install: () => ipcRenderer.invoke("etude:command-install"),
  },
});
