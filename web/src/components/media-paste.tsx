import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from "react";
import { toast } from "sonner";
import { copyMediaPaste, readMediaPaste, type MediaFormat } from "@/lib/media-paste";

export type ImportPaste = (data: DataTransfer, format: MediaFormat) => Promise<string> | null;
const MediaPasteContext = createContext<ImportPaste | null>(null);
export const useMediaPaste = () => useContext(MediaPasteContext);

export function MediaPasteProvider({ children, onPendingChange }: { children: ReactNode; onPendingChange?(pending: boolean): void }) {
  const pending = useRef(0);
  const alive = useRef(true);
  const change = useRef(onPendingChange);
  change.current = onPendingChange;
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; change.current?.(false); };
  }, []);
  const copy = useCallback<ImportPaste>((data, format) => {
    let paste;
    try { paste = readMediaPaste(data); } catch (e) {
      toast.error("Couldn't paste media", { description: (e as Error).message });
      return Promise.reject(e);
    }
    if (!paste) return null;
    pending.current++;
    change.current?.(true);
    const id = toast.loading("Copying media to Etude…");
    return copyMediaPaste(paste, format).then((text) => {
      toast.dismiss(id);
      return text;
    }, (e) => {
      toast.error("Couldn't copy media", { id, description: (e as Error).message });
      throw e;
    }).finally(() => {
      pending.current--;
      if (alive.current) change.current?.(pending.current > 0);
    });
  }, []);
  return <MediaPasteContext.Provider value={copy}>{children}</MediaPasteContext.Provider>;
}
