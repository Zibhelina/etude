// The Excalidraw component itself, in its own chunk so the rest of the app never pays for it.
import { useEffect, useRef, useState } from "react";
import { Excalidraw, MainMenu } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { BoardChange } from "./canvas-board";
import { presenceLabel, presenceStore, reportPresence } from "@/lib/presence";
import type { SharePerson } from "@/lib/share";

/** Excalidraw's default white (or nothing) means "the page's background": the board stays see-through. */
const pageBg = (c: unknown) => (!c || c === "#ffffff" || c === "#fff" || c === "#121212" ? "transparent" : String(c));

type Swatch = { stroke: string; fill: string };
type StyleFeed = { swatch?(s: Swatch): void; popup?(): void };

export default function CanvasExcalidraw({ initial, theme, name, embedded, readOnly, onChange, onApi, presenceNote }: {
  /** A shared canvas: others' pointers show here (Excalidraw's collaborators) and this one's goes to them. */
  presenceNote?: string;
  initial: { elements: readonly Record<string, unknown>[]; appState: Record<string, unknown>; files: Record<string, unknown> };
  theme: "light" | "dark";
  name?: string;
  embedded: boolean;
  readOnly?: boolean;
  onChange(c: BoardChange): void;
  onApi?(api: any): void;
}) {
  // The style button listens here, so a new colour re-renders the button and never Excalidraw.
  const feed = useRef<StyleFeed>({});
  const api = useRef<any>(null);
  // Others on this canvas: their pointer, name and color, as Excalidraw draws collaborators.
  useEffect(() => {
    if (!presenceNote) return;
    const show = (people: SharePerson[]) => {
      const collaborators = new Map<any, any>();
      for (const p of people)
        if (p.note === presenceNote && p.sel && "x" in p.sel)
          collaborators.set(p.device, { pointer: { x: p.sel.x, y: p.sel.y, tool: "pointer" }, username: presenceLabel(p), color: { background: p.color, stroke: p.color }, id: p.accountId });
      api.current?.updateScene({ collaborators });
    };
    show(presenceStore.get());
    return presenceStore.subscribe(show);
  }, [presenceNote]);
  return (
    <>
      <Excalidraw
        initialData={{ elements: initial.elements as any, appState: { ...initial.appState, viewBackgroundColor: pageBg(initial.appState.viewBackgroundColor), theme } as any, files: initial.files as any, scrollToContent: true }}
        theme={theme}
        name={name}
        excalidrawAPI={(a) => ((api.current = a), onApi?.(a))}
        onPointerUpdate={presenceNote ? ({ pointer }) => reportPresence({ note: presenceNote, sel: { x: pointer.x, y: pointer.y } }) : undefined}
        onChange={(elements, appState, files) => {
          onChange({ elements: elements as any, appState: appState as any, files: files as any });
          const picked = elements.find((e) => appState.selectedElementIds[e.id] && !e.isDeleted);
          feed.current.swatch?.({ stroke: picked?.strokeColor ?? appState.currentItemStrokeColor, fill: picked?.backgroundColor ?? appState.currentItemBackgroundColor });
          // S, G and the font shortcut open a picker that hangs off the panel, so the panel has to be there.
          if (appState.openPopup && appState.openPopup !== "canvasBackground") feed.current.popup?.();
        }}
        // Keys belong to the board only while you're in it, so the page and the app keep theirs.
        handleKeyboardGlobally={false}
        autoFocus={!embedded}
        detectScroll
        aiEnabled={false}
        viewModeEnabled={readOnly}
        UIOptions={{
          canvasActions: { loadScene: false, saveToActiveFile: false, toggleTheme: false, export: false, saveAsImage: !embedded, clearCanvas: true, changeViewBackgroundColor: true },
        }}
      >
        <MainMenu>
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
      </Excalidraw>
      {!readOnly && <StyleButton feed={feed.current} dark={theme === "dark"} />}
    </>
  );
}

/** Excalidraw's style panel (stroke, background, width, layers…) stays tucked behind this button, which shows the
 *  current colours, so it no longer covers the drawing. It opens on a click or on S/G and closes as soon as you
 *  touch the canvas again. The button sits beside the ☰ menu, or under it when the board is too narrow. */
function StyleButton({ feed, dark }: { feed: StyleFeed; dark: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [sw, setSw] = useState<Swatch>({ stroke: "#1e1e1e", fill: "transparent" });
  const [at, setAt] = useState<{ x: number; y: number; below: boolean } | null>(null);

  feed.swatch = (s) => setSw((o) => (o.stroke === s.stroke && o.fill === s.fill ? o : s));
  feed.popup = () => setOpen(true);

  useEffect(() => {
    const board = ref.current?.parentElement;
    board?.classList.toggle("exc-styles-open", open);
  }, [open]);
  useEffect(() => {
    ref.current?.parentElement?.classList.toggle("exc-style-below", !!at?.below);
  }, [at?.below]);

  useEffect(() => {
    const board = ref.current?.parentElement;
    if (!board) return;
    let frame = 0;
    const place = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const menu = board.querySelector(".App-menu_top .dropdown-menu-button")?.getBoundingClientRect();
        const tools = board.querySelector(".App-menu_top .App-toolbar")?.getBoundingClientRect();
        if (!menu || !menu.width) return setAt(null);
        const b = board.getBoundingClientRect();
        board.style.setProperty("--exc-board-h", `${Math.round(b.height)}px`);
        const fits = !tools || menu.right + 8 + menu.width + 8 <= tools.left;
        const next = fits
          ? { x: Math.round(menu.right + 8 - b.left), y: Math.round(menu.top - b.top), below: false }
          : { x: Math.round(menu.left - b.left), y: Math.round(menu.bottom + 8 - b.top), below: true };
        setAt((o) => (o && o.x === next.x && o.y === next.y && o.below === next.below ? o : next));
      });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(board);
    // Excalidraw mounts its menus a beat after the board, and the narrow layout moves them.
    const mo = new MutationObserver(place);
    mo.observe(board, { childList: true, subtree: true });
    const close = (e: PointerEvent) => { if ((e.target as Element | null)?.tagName === "CANVAS") setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    board.addEventListener("pointerdown", close, true);
    board.addEventListener("keydown", esc, true);
    return () => {
      cancelAnimationFrame(frame); ro.disconnect(); mo.disconnect();
      board.removeEventListener("pointerdown", close, true); board.removeEventListener("keydown", esc, true);
      board.classList.remove("exc-styles-open", "exc-style-below");
    };
  }, []);

  const clear = !sw.fill || sw.fill === "transparent";
  return (
    <button
      ref={ref}
      type="button"
      className={"exc-style-btn" + (open ? " is-open" : "")}
      style={at ? { left: at.x, top: at.y } : { visibility: "hidden" }}
      aria-expanded={open}
      aria-label="Style"
      title="Style: colours, stroke, layers (S, G)"
      onClick={() => setOpen((o) => !o)}
    >
      {/* Colours as the board draws them: in dark mode Excalidraw inverts its stored colours, so the swatch does too. */}
      <span className={"exc-style-swatch" + (clear ? " is-clear" : "")}>
        <i style={{ borderColor: sw.stroke, background: clear ? "transparent" : sw.fill, filter: dark ? "invert(93%) hue-rotate(180deg)" : undefined }} />
      </span>
    </button>
  );
}
