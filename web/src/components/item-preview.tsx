// The live preview in the item inspector: the card as the learner sees it, on a sheet of paper that flips
// to its answer. While the item has unsaved edits it previews the draft, so the card follows the fields.
import { useEffect, useRef, useState } from "react";
import { Dices } from "lucide-react";
import { CardFrame, type CardResult } from "@/components/card-frame";
import { api, type CardType, type ItemDetail } from "@/lib/api";
import { cn } from "@/lib/utils";

type Data = { view: Record<string, unknown>; key: Record<string, unknown>; seed: number };

export function ItemPreview({ item, type, fields, dirty, version, flipped, onFlip }: {
  item: ItemDetail;
  type: CardType;
  fields: Record<string, unknown>;
  dirty: boolean;
  /** Bumps after a save, so the saved card reloads. */
  version: number;
  flipped: boolean;
  onFlip(): void;
}) {
  const faces = type.facesWhen ? item.cards.map((c) => c.face) : type.faces;
  const [face, setFace] = useState(faces?.[0] ?? "main");
  const [seed, setSeed] = useState(1);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What the frame shows lags `flipped` by half a turn: the sheet turns edge-on, swaps sides, turns back.
  const [shown, setShown] = useState(flipped);
  const [turning, setTurning] = useState(false);
  const live = JSON.stringify(dirty ? fields : null);
  const [debounced, setDebounced] = useState(live);

  useEffect(() => {
    if (faces?.length && !faces.includes(face)) setFace(faces[0]);
  }, [faces?.join()]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(live), live === "null" ? 0 : 320);
    return () => clearTimeout(t);
  }, [live]);

  useEffect(() => {
    let on = true;
    const draft = JSON.parse(debounced) as Record<string, unknown> | null;
    const req = draft
      ? api.previewType(type, draft, { seed, face }).then((r) => {
          if (!r.view) throw new Error(r.errors?.join("\n") || "Couldn't preview this card");
          return { view: r.view, key: r.key ?? {}, seed: r.seed ?? seed };
        })
      : api.previewItem(item.id, seed, face);
    req.then((d) => on && (setData(d), setError(null))).catch((e) => on && setError((e as Error).message));
    return () => { on = false; };
  }, [item.id, seed, face, debounced, version, type.updated]);

  // The card doesn't focus itself here (it remounts on every edit), but its own script still can. In Browse that
  // would swallow the list's keys, so focus only stays in the card when you clicked into it.
  const box = useRef<HTMLDivElement>(null);
  const hover = useRef(false);
  const tabbed = useRef(0);
  useEffect(() => {
    const onBlur = () => setTimeout(() => {
      const f = document.activeElement;
      if (f instanceof HTMLIFrameElement && box.current?.contains(f) && !hover.current && Date.now() - tabbed.current > 1000) f.blur();
    }, 0);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Tab") tabbed.current = Date.now(); };
    window.addEventListener("blur", onBlur);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("blur", onBlur); window.removeEventListener("keydown", onKey); };
  }, []);

  const reduce = useRef(typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    if (flipped === shown) return;
    if (reduce.current) return setShown(flipped);
    setTurning(true);
    const t = setTimeout(() => { setShown(flipped); setTurning(false); }, 190);
    return () => clearTimeout(t);
  }, [flipped]);

  const result: CardResult | null = shown && data ? { grade: { score: null, verdict: "ungraded", suggested: null, grader: { kind: "preview" } }, key: data.key, answer: null, preview: true } as CardResult : null;
  const generated = typeof fields.generator === "string";

  return (
    <div ref={box} className="browse-flip [perspective:1600px]" onMouseEnter={() => (hover.current = true)} onMouseLeave={() => (hover.current = false)}>
      <div
        className={cn("browse-paper relative flex flex-col px-[26px] pt-5 pb-6 transition-transform duration-[190ms] ease-in max-md:px-5 max-md:pt-4 max-md:pb-5", turning && "[transform:rotateY(90deg)]")}
        onClick={(e) => { if (e.target === e.currentTarget) onFlip(); }}
      >
        <div className="mb-3 flex min-h-6 items-center gap-2">
          <span className="score-kicker truncate text-muted-foreground">{type.name}</span>
          {faces && faces.length > 1 && (
            <div className="ml-1 flex gap-1">
              {faces.map((f) => (
                <button key={f} onClick={() => setFace(f)} className={cn("h-6 rounded-full px-2 text-[11.5px] font-semibold", f === face ? "bg-foreground text-background" : "text-muted-foreground shadow-[inset_0_0_0_1.2px_var(--border)] hover:text-foreground")}>{f}</button>
              ))}
            </div>
          )}
          <div className="flex-1" />
          {generated && (
            <button className="flex items-center gap-1 text-[12px] font-semibold text-muted-foreground hover:text-foreground" onClick={() => setSeed(Math.floor(Math.random() * 1e9))} title="New variant">
              <Dices className="size-3.5" /><span className="max-sm:hidden">New variant</span>
            </button>
          )}
          <button className="shrink-0 text-[12px] font-semibold text-muted-foreground hover:text-foreground" onClick={onFlip} aria-pressed={flipped}>
            {shown ? "Back · tap to flip" : "Front · tap to flip"}
          </button>
        </div>
        {error && <pre className="whitespace-pre-wrap text-sm text-destructive">{error}</pre>}
        {data && !error && (
          <CardFrame
            src={`/frame/${encodeURIComponent(item.type)}?v=${encodeURIComponent(type.updated ?? "")}`}
            frameKey={`${item.id}:${version}:${debounced.length}:${hash(debounced)}:${seed}:${face}:${shown}`}
            view={data.view}
            mode={result ? "result" : "answer"}
            result={result}
            autoFocus={false}
            onKey={(k) => k === " " && onFlip()}
          />
        )}
        {dirty && <span className="mt-3 text-[12px] text-muted-foreground">Showing your unsaved edits</span>}
      </div>
    </div>
  );
}

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
