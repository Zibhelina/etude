// A canvas: an Excalidraw whiteboard (shapes, arrows, hand drawing, text, pictures), used as a note of its own
// and embedded in pages with /canvas. Excalidraw is big, so it loads only when a canvas opens. The drawing is
// kept as Excalidraw's own scene; pictures go into the collection's media and the scene only names them.
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, type CanvasScene } from "@/lib/api";
import { etudeFetch } from "@/lib/transport";
import { withBase } from "@/lib/router";
import { useScheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

// Excalidraw's fonts are served by Etude (web/public/excalidraw/fonts), never from a CDN.
if (typeof window !== "undefined") (window as any).EXCALIDRAW_ASSET_PATH = new URL(withBase("/excalidraw/"), location.href).href;

type Lib = typeof import("@excalidraw/excalidraw");
let lib: Promise<Lib> | null = null;
/** The Excalidraw module, loaded once (its stylesheet with it). */
export function loadExcalidraw(): Promise<Lib> {
  return (lib ??= Promise.all([import("@excalidraw/excalidraw"), import("@excalidraw/excalidraw/index.css")]).then(([m]) => m));
}

// Loaded by hand, not React.lazy: inside an editor block (a Tiptap node view portal) a lazy boundary could stay
// on its fallback for good when the page re-rendered while the chunk arrived.
type BoardType = typeof import("./canvas-excalidraw").default;
let boardMod: Promise<BoardType> | null = null;
const loadBoard = () => (boardMod ??= import("./canvas-excalidraw").then((m) => m.default));

/** A media file as a data: URL (what Excalidraw wants for pictures). */
async function dataUrlOf(media: string): Promise<string | null> {
  try {
    const r = await etudeFetch(`/media/${media}`);
    if (!r.ok) return null;
    const blob = await r.blob();
    return await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.onerror = () => res(null);
      fr.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** The scene with its pictures read back from the media, ready for Excalidraw. */
export async function sceneForBoard(s: CanvasScene) {
  const files: Record<string, { id: string; mimeType: string; dataURL: string; created: number }> = {};
  await Promise.all(
    Object.entries(s.files ?? {}).map(async ([id, f]) => {
      const dataURL = await dataUrlOf(f.media);
      if (dataURL) files[id] = { id, mimeType: f.mimeType, dataURL, created: f.created ?? Date.now() };
    }),
  );
  return { elements: s.elements, appState: s.appState ?? {}, files };
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "image/avif": "avif", "image/bmp": "bmp" };

/** Stores a picture Excalidraw holds as a data: URL in the media; returns its media file. */
async function storePicture(id: string, mimeType: string, dataURL: string): Promise<string> {
  const blob = await (await fetch(dataURL)).blob();
  const m = await api.uploadMedia(new File([blob], `${id.slice(0, 24)}.${EXT[mimeType] ?? "png"}`, { type: mimeType }));
  return m.file;
}

export interface BoardChange {
  elements: readonly Record<string, any>[];
  appState: Record<string, any>;
  files: Record<string, { id: string; mimeType: string; dataURL?: string; created?: number }>;
}

/**
 * Turns Excalidraw's changes into scenes to save: skips changes that only move the view or the selection, puts
 * new pictures in the media first, and keeps the media names of pictures it already knows.
 */
export function useSceneSaver(initial: CanvasScene | null, save: (s: CanvasScene) => void) {
  const known = useRef<Record<string, { mimeType: string; media: string; created?: number }>>({ ...(initial?.files ?? {}) });
  const last = useRef<string>("");
  const saveRef = useRef(save);
  saveRef.current = save;
  const pending = useRef<Promise<void>>(Promise.resolve());
  return useCallback((c: BoardChange) => {
    const elements = c.elements.filter((e) => !e.isDeleted);
    const appState = { viewBackgroundColor: c.appState.viewBackgroundColor, gridSize: c.appState.gridSize ?? null, gridModeEnabled: !!c.appState.gridModeEnabled };
    const used = new Set(elements.filter((e) => e.type === "image" && e.fileId).map((e) => String(e.fileId)));
    const key = JSON.stringify([elements.map((e) => [e.id, e.version, e.versionNonce]), appState, [...used].sort()]);
    if (key === last.current) return;
    last.current = key;
    pending.current = pending.current.then(async () => {
      for (const id of used) {
        if (known.current[id]) continue;
        const f = c.files[id];
        if (!f?.dataURL) continue;
        try {
          known.current[id] = { mimeType: f.mimeType, media: await storePicture(id, f.mimeType, f.dataURL), created: f.created };
        } catch (e) {
          toast.error(`Couldn't keep that picture: ${(e as Error).message}`);
        }
      }
      const files: CanvasScene["files"] = {};
      for (const id of used) if (known.current[id]) files[id] = known.current[id];
      saveRef.current({ type: "excalidraw", version: 2, elements: JSON.parse(JSON.stringify(elements)), appState, files });
    });
  }, []);
}

export interface CanvasBoardProps {
  scene: CanvasScene;
  onChange(s: CanvasScene): void;
  /** File name for image exports. */
  name?: string;
  className?: string;
  /** Inside a page: a quieter toolbar and no main menu. */
  embedded?: boolean;
  /** Called with Excalidraw's API once it's up (exports, fit to content). */
  onApi?(api: any): void;
}

/** The board, with a quiet placeholder while Excalidraw loads. */
export function CanvasBoard(props: CanvasBoardProps) {
  const scheme = useScheme();
  const [data, setData] = useState<Awaited<ReturnType<typeof sceneForBoard>> | null>(null);
  const [Board, setBoard] = useState<BoardType | null>(null);
  useEffect(() => {
    let live = true;
    void loadExcalidraw();
    loadBoard().then((B) => live && setBoard(() => B));
    sceneForBoard(props.scene).then((d) => live && setData(d));
    return () => void (live = false);
    // The scene is only read once: after that Excalidraw owns it and reports changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const saver = useSceneSaver(props.scene, props.onChange);
  const loading = (w: string) => <div className="note-canvas-loading" data-wait={w}>Loading the canvas…</div>;
  return (
    <div className={cn("note-canvas-board", props.embedded && "is-embedded", props.className)} data-canvas-board="">
      {data && Board ? <Board initial={data} theme={scheme} name={props.name} embedded={!!props.embedded} onChange={saver} onApi={props.onApi} /> : loading(Board ? "scene" : "chunk")}
    </div>
  );
}

/** True when a key or pointer event happened inside a canvas (so app shortcuts leave it alone). */
export const inCanvas = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.(".note-canvas-board, .excalidraw");

/** Downloads the drawing as PNG or SVG (pictures included), on the theme's background. */
export async function exportBoard(xapi: any, format: "png" | "svg", name: string, dark: boolean) {
  const m = await loadExcalidraw();
  const elements = xapi.getSceneElements();
  if (!elements.length) return void toast("The canvas is empty.");
  const appState = { ...xapi.getAppState(), exportBackground: true, exportWithDarkMode: dark };
  const files = xapi.getFiles();
  const blob = format === "png" ? await m.exportToBlob({ elements, appState, files, mimeType: "image/png", exportPadding: 24 }) : new Blob([new XMLSerializer().serializeToString(await m.exportToSvg({ elements, appState, files, exportPadding: 24 }))], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(name.trim() || "Canvas").replace(/[\\/:*?"<>|]+/g, " ").trim()}.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

