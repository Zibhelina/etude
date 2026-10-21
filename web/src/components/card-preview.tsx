// Shows a card as the learner sees it, with a toggle to reveal its answer. Used by Browse and the type editor.
import { useEffect, useRef, useState } from "react";
import { Dices, Eye, EyeOff, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CardFrame, type CardFrameHandle, type CardResult } from "@/components/card-frame";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { Grade } from "@/lib/api";

export interface PreviewData {
  view: Record<string, unknown>;
  key: Record<string, unknown>;
  seed: number;
}

export function CardPreview({
  src,
  html,
  version,
  load,
  faces,
  generated,
  grade,
  onTry,
}: {
  /** Served frame URL, or raw frame HTML for unsaved types. */
  src?: string;
  html?: string;
  version: string;
  /** Prepares the card for a seed and face. */
  load(seed: number, face: string): Promise<PreviewData | null>;
  faces?: string[];
  generated?: boolean;
  /** Optional: grade a test answer (script graders only). */
  grade?(answer: unknown, data: PreviewData): Promise<Grade | null>;
  onTry?(): void;
}) {
  const [seed, setSeed] = useState(1);
  const [face, setFace] = useState(faces?.[0] ?? "main");
  const [data, setData] = useState<PreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [tested, setTested] = useState<CardResult | null>(null);
  const frame = useRef<CardFrameHandle>(null);

  useEffect(() => {
    if (faces?.length && !faces.includes(face)) setFace(faces[0]);
  }, [faces?.join()]);

  useEffect(() => {
    let live = true;
    setTested(null);
    load(seed, face)
      .then((d) => {
        if (!live) return;
        setData(d);
        setError(null);
      })
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [seed, face, version, load]);

  const result: CardResult | null = tested ?? (reveal && data ? { grade: { score: null, verdict: "ungraded", suggested: null, grader: { kind: "preview" } }, key: data.key, answer: null, preview: true } as CardResult : null);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {faces && faces.length > 1 && (
          <ToggleGroup type="single" size="sm" variant="outline" value={face} onValueChange={(v) => v && setFace(v)}>
            {faces.map((f) => <ToggleGroupItem key={f} value={f} className="px-3 text-xs">{f}</ToggleGroupItem>)}
          </ToggleGroup>
        )}
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => { setReveal(!reveal); setTested(null); }}>
          {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />} {reveal ? "Hide answer" : "Show answer"}
        </Button>
        {generated && (
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setSeed(Math.floor(Math.random() * 1e9))}>
            <Dices className="size-4" /> New variant
          </Button>
        )}
        <div className="flex-1" />
        {onTry && (
          <Button variant="ghost" size="sm" className="gap-1.5" onClick={onTry}><Play className="size-4" /> Study this card</Button>
        )}
      </div>
      <div className="rounded-xl border bg-background p-5">
        {error && <pre className="whitespace-pre-wrap text-sm text-destructive">{error}</pre>}
        {data && !error && (
          <CardFrame
            ref={frame}
            src={src}
            html={html}
            frameKey={`${version}:${seed}:${face}:${reveal}:${tested ? "t" : ""}:${html?.length ?? 0}`}
            view={data.view}
            mode={result ? "result" : "answer"}
            result={result}
            answer={tested?.answer}
            onSubmit={async (answer) => {
              if (!grade) return;
              const g = await grade(answer, data);
              if (g) setTested({ grade: g, key: data.key, answer });
            }}
          />
        )}
      </div>
      {tested && (
        <div className="text-sm text-muted-foreground">
          Test answer scored <span className="tabular text-foreground">{tested.grade.score == null ? "n/a (AI or self graded)" : `${Math.round(tested.grade.score * 100)}%`}</span>. Nothing was saved.
        </div>
      )}
    </div>
  );
}
