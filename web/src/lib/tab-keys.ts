// Ctrl/⌘+T opens a tab and Ctrl/⌘+W closes the one in front, wherever you are: the Ask panel's tabs when the focus
// (or the last click) is in the panel, otherwise the Notebook's. The app window would otherwise close or open a browser
// tab, so App swallows both everywhere.

let lastClick: Element | null = null;
if (typeof window !== "undefined") window.addEventListener("pointerdown", (e) => void (lastClick = e.target as Element), true);

export function tabShortcut(e: KeyboardEvent): "new" | "close" | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return null;
  return e.code === "KeyT" ? "new" : e.code === "KeyW" ? "close" : null;
}

export function inAskPanel(): boolean {
  const a = document.activeElement;
  const el = a && a !== document.body ? a : lastClick;
  return !!el?.closest?.("[data-agent-panel]");
}
