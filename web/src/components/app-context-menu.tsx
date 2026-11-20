// Etude's own right-click menu, in place of the browser's: what you'd want at that spot in Etude. In a page of
// the Notebook: cut/copy/paste and the block you clicked (its options, duplicate, delete); on a link or a picture:
// open it or copy its address; in a text field: cut/copy/paste; anywhere else: back/forward, find, a new page,
// the sidebar. In a page and anywhere else, New window too (lib/window-store.ts). Places with menus of their own (decks, the Notebook's tree, a canvas, Minimi) keep theirs, and
// Shift+right-click still gives the browser's menu.
import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { PointMenu, type PointMenuItem } from "@/components/point-menu";
import { BLOCK_MENU_EVENT, blockAt, type BlockMenuDetail } from "@/editor/note-handle";
import { runNotesAction } from "@/lib/sidebar-slot";
import { navigate } from "@/lib/router";
import { canOpenWindows, openNewWindow } from "@/lib/window-store";
import { getPluginCommands } from "@/lib/plugins";

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const k = (key: string) => (mac ? `⌘${key}` : `Ctrl+${key}`);
/** Another Etude window, on the same screen this one shows (the Notebook starts empty there, with a New tab). */
const newWindow = (path: string): PointMenuItem => ({ label: "New window", hint: "etudeDesktop" in globalThis ? (mac ? "⌘⇧N" : "Ctrl+Shift+N") : undefined, onSelect: () => openNewWindow(path === "/notes" ? "/notes" : path + location.search) });
type Mode = "open" | "rail" | "none";

/** Presses a shortcut for whoever owns it on this screen (⌘K is a different finder on different pages). */
const press = (key: string) => window.dispatchEvent(new KeyboardEvent("keydown", { key, code: `Key${key.toUpperCase()}`, ctrlKey: !mac, metaKey: mac, bubbles: true }));

async function writeClip(text: string, html?: string) {
  try {
    if (html && typeof ClipboardItem !== "undefined") {
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }), "text/html": new Blob([html], { type: "text/html" }) })]);
    } else await navigator.clipboard.writeText(text);
  } catch {}
}
async function readClip(): Promise<{ text: string; html: string | null }> {
  try {
    const items = await navigator.clipboard.read();
    let html: string | null = null;
    let text = "";
    for (const it of items) {
      if (it.types.includes("text/html")) html = await (await it.getType("text/html")).text();
      if (it.types.includes("text/plain")) text = await (await it.getType("text/plain")).text();
    }
    return { text, html };
  } catch {
    try {
      return { text: await navigator.clipboard.readText(), html: null };
    } catch {
      return { text: "", html: null };
    }
  }
}

function editorItems(editor: Editor, x: number, y: number): PointMenuItem[] {
  const view = editor.view;
  const sel = view.state.selection;
  const has = !sel.empty;
  const copy = async () => {
    const { dom, text } = view.serializeForClipboard(sel.content());
    await writeClip(text, dom.innerHTML);
  };
  const block = blockAt(view, x, y);
  const out: PointMenuItem[] = [
    { label: "Cut", hint: k("X"), disabled: !has, onSelect: async () => (await copy(), view.dispatch(view.state.tr.deleteSelection()), view.focus()) },
    { label: "Copy", hint: k("C"), disabled: !has, onSelect: () => void copy().then(() => view.focus()) },
    { label: "Paste", hint: k("V"), onSelect: async () => {
      const c = await readClip();
      view.focus();
      if (c.html) view.pasteHTML(c.html);
      else if (c.text) view.pasteText(c.text);
    } },
    { label: "Paste as plain text", hint: mac ? "⌘⇧V" : "Ctrl+Shift+V", onSelect: async () => {
      const c = await readClip();
      view.focus();
      if (c.text) view.pasteText(c.text);
    } },
    { label: "Select all", hint: k("A"), onSelect: () => editor.chain().focus().selectAll().run() },
  ];
  if (has) {
    out.push("sep",
      { label: "Bold", hint: k("B"), onSelect: () => editor.chain().focus().toggleBold().run() },
      { label: "Italic", hint: k("I"), onSelect: () => editor.chain().focus().toggleItalic().run() },
    );
  }
  if (block) {
    const node = view.state.doc.nodeAt(block.pos);
    if (node) {
      out.push("sep",
        { label: "Block options…", onSelect: () => {
          view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, block.pos)));
          view.focus();
          window.dispatchEvent(new CustomEvent<BlockMenuDetail>(BLOCK_MENU_EVENT, { detail: { pos: block.pos, rect: new DOMRect(x, y - 6, 0, 0), view } }));
        } },
        { label: "Duplicate block", onSelect: () => {
          const tr = view.state.tr.insert(block.pos + node.nodeSize, node.copy(node.content));
          tr.setSelection(NodeSelection.create(tr.doc, block.pos + node.nodeSize));
          view.dispatch(tr);
          view.focus();
        } },
        { label: "Delete block", onSelect: () => {
          const tr = view.state.tr.delete(block.pos, block.pos + node.nodeSize);
          try {
            tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(block.pos, tr.doc.content.size))));
          } catch {}
          view.dispatch(tr);
          view.focus();
        } },
      );
    }
  }
  return out;
}

function fieldItems(el: HTMLInputElement | HTMLTextAreaElement): PointMenuItem[] {
  const a = el.selectionStart ?? 0;
  const b = el.selectionEnd ?? 0;
  const picked = el.value.slice(a, b);
  const back = () => (el.focus(), el.setSelectionRange(a, b));
  const ro = el.readOnly || el.disabled;
  return [
    { label: "Cut", hint: k("X"), disabled: !picked || ro, onSelect: async () => (await writeClip(picked), back(), document.execCommand("delete")) },
    { label: "Copy", hint: k("C"), disabled: !picked, onSelect: async () => (await writeClip(picked), back()) },
    { label: "Paste", hint: k("V"), disabled: ro, onSelect: async () => {
      const { text } = await readClip();
      back();
      if (text) document.execCommand("insertText", false, el instanceof HTMLInputElement ? text.replace(/\r?\n/g, " ") : text);
    } },
    { label: "Select all", hint: k("A"), onSelect: () => (el.focus(), el.select()) },
  ];
}

export function AppContextMenu({ path, sidebar, onSidebar, extra }: { path: string; sidebar: Mode | null; onSidebar(m: Mode): void; extra?: (x: number, y: number) => PointMenuItem[] }) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: PointMenuItem[] } | null>(null);
  const live = { path, sidebar, onSidebar, extra };
  const ref = useState(() => ({ current: live }))[0];
  ref.current = live;
  useEffect(() => {
    const h = (e: MouseEvent) => {
      // Someone closer already handled it (a deck row, the Notebook's tree, Minimi), or Shift for the browser's own.
      if (e.defaultPrevented || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (!t || !(t instanceof Element)) return;
      // A canvas has its own menu; a card or web file is its own page.
      if (t.closest(".excalidraw, iframe, [data-point-menu], [data-radix-popper-content-wrapper]")) return;
      const { x, y } = { x: e.clientX, y: e.clientY };
      const { path, sidebar, onSidebar, extra } = ref.current;
      let items: PointMenuItem[] = [];
      const link = t.closest<HTMLAnchorElement>("a[href]");
      const img = t.closest<HTMLImageElement>("img");
      const pm = t.closest<HTMLElement>(".ProseMirror") as (HTMLElement & { editor?: Editor }) | null;
      const field = t.closest<HTMLInputElement | HTMLTextAreaElement>("input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=file]), textarea");
      if (link) {
        const href = link.href;
        const inside = new URL(href, location.href).origin === location.origin;
        items.push(
          { label: "Open link", onSelect: () => (inside ? navigate(new URL(href).pathname + new URL(href).search) : void window.open(href, "_blank", "noopener")) },
          { label: "Open in a new tab", onSelect: () => void window.open(href, "_blank", "noopener") },
          { label: "Copy link address", onSelect: () => void writeClip(href) },
        );
      }
      if (img?.src) {
        if (items.length) items.push("sep");
        items.push(
          { label: "Open picture in a new tab", onSelect: () => void window.open(img.src, "_blank", "noopener") },
          { label: "Copy picture address", onSelect: () => void writeClip(img.src) },
        );
      }
      if (pm?.editor && pm.isContentEditable) {
        if (items.length) items.push("sep");
        items.push(...editorItems(pm.editor, x, y));
        if (canOpenWindows()) items.push("sep", newWindow(path));
      } else if (field) {
        if (items.length) items.push("sep");
        items.push(...fieldItems(field));
      } else if (!items.length) {
        const picked = getSelection()?.toString() ?? "";
        if (picked.trim()) items.push({ label: "Copy", hint: k("C"), onSelect: () => void writeClip(picked) }, "sep");
        items.push(
          { label: "Back", hint: mac ? "⌘[" : "Alt+←", disabled: history.length < 2, onSelect: () => history.back() },
          { label: "Forward", hint: mac ? "⌘]" : "Alt+→", onSelect: () => history.forward() },
          { label: "Reload", hint: k("R"), onSelect: () => location.reload() },
          "sep",
          { label: path === "/notes" ? "Find a page" : "Find a deck", hint: k("K"), onSelect: () => press("k") },
        );
        if (path === "/notes") items.push({ label: "New page", hint: mac ? "⌘⌥N" : "Ctrl+Alt+N", onSelect: () => void runNotesAction("new") });
        else items.push({ label: "Open the Notebook", onSelect: () => navigate("/notes") });
        if (canOpenWindows()) items.push(newWindow(path));
        if (sidebar) {
          items.push("sep");
          if (sidebar !== "open") items.push({ label: "Open the sidebar", hint: k("]"), onSelect: () => onSidebar("open") });
          if (sidebar !== "rail") items.push({ label: "Fold the sidebar to icons", hint: k("["), onSelect: () => onSidebar("rail") });
          if (sidebar !== "none") items.push({ label: "Hide the sidebar", hint: k("<"), onSelect: () => onSidebar("none") });
        }
        const pluginItems: PointMenuItem[] = getPluginCommands()
          .filter((c) => c.contextMenu)
          .map((c) => ({ label: c.label, hint: c.shortcut, onSelect: c.run }));
        if (pluginItems.length) items.push("sep", ...pluginItems);
        const more = extra?.(x, y) ?? [];
        if (more.length) items.push("sep", ...more);
      }
      if (!items.length) return;
      e.preventDefault();
      setMenu({ x, y, items });
    };
    // Bubble phase on the window: menus inside the app (Radix, Minimi) have had their turn and marked the event.
    window.addEventListener("contextmenu", h);
    return () => window.removeEventListener("contextmenu", h);
  }, [ref]);
  if (!menu) return null;
  return <PointMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />;
}
