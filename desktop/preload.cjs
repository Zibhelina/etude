// All the page can ask the app for. It runs in the window's top frame only, never in card frames.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("etudeDesktop", {
  platform: process.platform,
  /** A folder picked in the system dialog, or null. */
  pickFolder: () => ipcRenderer.invoke("etude:pick-folder"),
  showLogs: () => ipcRenderer.invoke("etude:show-logs"),
  /** Start the engine again (the error page's Try again). */
  retry: () => ipcRenderer.invoke("etude:retry"),
});
