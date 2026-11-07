// The Excalidraw component itself, in its own chunk so the rest of the app never pays for it.
import { Excalidraw, MainMenu } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { BoardChange } from "./canvas-board";

/** Excalidraw's default white (or nothing) means "the page's background": the board stays see-through. */
const pageBg = (c: unknown) => (!c || c === "#ffffff" || c === "#fff" || c === "#121212" ? "transparent" : String(c));

export default function CanvasExcalidraw({ initial, theme, name, embedded, onChange, onApi }: {
  initial: { elements: readonly Record<string, unknown>[]; appState: Record<string, unknown>; files: Record<string, unknown> };
  theme: "light" | "dark";
  name?: string;
  embedded: boolean;
  onChange(c: BoardChange): void;
  onApi?(api: any): void;
}) {
  return (
    <Excalidraw
      initialData={{ elements: initial.elements as any, appState: { ...initial.appState, viewBackgroundColor: pageBg(initial.appState.viewBackgroundColor), theme } as any, files: initial.files as any, scrollToContent: true }}
      theme={theme}
      name={name}
      excalidrawAPI={(a) => onApi?.(a)}
      onChange={(elements, appState, files) => onChange({ elements: elements as any, appState: appState as any, files: files as any })}
      // Keys belong to the board only while you're in it, so the page and the app keep theirs.
      handleKeyboardGlobally={false}
      autoFocus={!embedded}
      detectScroll
      aiEnabled={false}
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
  );
}
