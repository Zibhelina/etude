// A card type's page: what its cards look like (a live card you can answer), how they're checked and
// scheduled, what an item fills in, where it's used, and the files it's made of. Edit opens the editor.
import { useEffect, useMemo, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { html as htmlLang } from "@codemirror/lang-html";
import { css as cssLang } from "@codemirror/lang-css";
import { json as jsonLang } from "@codemirror/lang-json";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { ChevronLeft, Code2, Copy, Download, File, Folder, FolderInput, Layers, Lock, MoreHorizontal, Pencil, Play, RotateCcw, SearchCode, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { CardFrame, type CardResult } from "@/components/card-frame";
import { api, ApiError, type CardType, type TypeSummary } from "@/lib/api";
import { navigate } from "@/lib/router";
import { useScheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { download, exportShape, fieldDefaults } from "./starter";
import { loadSample, type Sample } from "./type-card";
import { MoveDialog, leaf, type MoveTarget } from "./folders";
import { NewTypeDialog } from "./dialogs";

const fmtN = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = one + "s") => `${fmtN(n)} ${n === 1 ? one : many}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDay = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${MONTHS[d.getMonth()]} ${d.getDate()}${d.getFullYear() !== new Date().getFullYear() ? `, ${d.getFullYear()}` : ""}`;
};
const fmtBytes = (b: number) => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);
const bytes = (s: string) => new TextEncoder().encode(s).length;

const KIND: Record<string, string> = { markdown: "Text with formatting", text: "Short text", list: "List", json: "Structured", boolean: "On or off", number: "Number", code: "Code", html: "HTML" };

function checkedBy(kind: string) {
  if (kind === "self") return "You rate yourself after seeing the answer.";
  if (kind === "ai") return "AI reads your answer against the reference and rubric.";
  if (kind === "hybrid") return "A script checks what it can. When it can't decide, AI reads the answer against the reference.";
  return "A script checks the answer. Same answer, same result, no AI.";
}

type FileEntry = { name: string; about: string; text: string; lang: "json" | "html" | "css" | "js" };

/** The files `etude type export` writes, from the definition. */
function filesOf(def: CardType): FileEntry[] {
  const g = def.grader as { kind: string; code?: string };
  const { template, prepare, demo, grader, assetFiles: _a, updated: _u, builtin: _b, ...meta } = def;
  const { code: _c, ...graderMeta } = grader as { code?: string };
  const out: FileEntry[] = [{ name: "type.json", about: "fields and settings", text: JSON.stringify({ ...meta, grader: graderMeta }, null, 2) + "\n", lang: "json" }];
  const add = (name: string, about: string, text: string | undefined, lang: FileEntry["lang"]) => text?.trim() && out.push({ name, about, text, lang });
  add("template.html", "the card's HTML", template.html, "html");
  add("style.css", "how it looks", template.css, "css");
  add("card.js", "what happens when you touch it", template.js, "js");
  add("prepare.js", "builds each card: picks, shuffles, generates", prepare, "js");
  add("grade.js", "checks the answer", g.code, "js");
  add("demo.js", "an example answer, for Watch", demo, "js");
  return out;
}

export function TypeDetail({ id, onMissing }: { id: string; onMissing(): void }) {
  const [def, setDef] = useState<CardType | null>(null);
  const [summary, setSummary] = useState<TypeSummary | null>(null);
  const [types, setTypes] = useState<TypeSummary[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [decks, setDecks] = useState<{ deck: string; items: number; cards: number }[] | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [moving, setMoving] = useState<MoveTarget | null>(null);
  const [dup, setDup] = useState(false);
  const [face, setFace] = useState<string | undefined>(undefined);
  const [resetting, setResetting] = useState(false);

  const reload = async () => {
    const [t, f] = await Promise.all([api.types(), api.typeFolders()]);
    setTypes(t);
    setFolders(f);
    setSummary(t.find((x) => x.id === id) ?? null);
  };

  useEffect(() => {
    let live = true;
    api.type(id).then(
      (d) => live && setDef(d),
      (e) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 404) onMissing();
        else toast.error((e as Error).message);
      },
    );
    reload().catch((e) => toast.error((e as Error).message));
    api.typeDecks(id).then((d) => live && setDecks(d), () => live && setDecks([]));
    return () => {
      live = false;
    };
  }, [id]);

  const files = useMemo(() => (def ? filesOf(def) : []), [def]);

  if (!def || !summary)
    return (
      <div className="types-page mx-auto w-full max-w-[62rem] px-4 py-6 sm:px-8 sm:py-10">
        <Skeleton className="mb-3 h-5 w-28" />
        <Skeleton className="mb-6 h-10 w-72" />
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <Skeleton className="h-96 rounded-2xl" />
          <Skeleton className="h-72 rounded-2xl" />
        </div>
      </div>
    );

  const faces = def.faces?.length ? def.faces : ["main"];
  const priv = def.fields.filter((f) => f.private).length;
  const drill = def.scheduler === "drill";
  const assets = def.assetFiles ?? [];
  // Decks by their top level: the same deck tree you see in the Library.
  const tops = Object.values(
    (decks ?? []).reduce<Record<string, { deck: string; items: number; cards: number }>>((acc, d) => {
      const top = d.deck.split("::")[0];
      const e = (acc[top] ??= { deck: top, items: 0, cards: 0 });
      e.items += d.items;
      e.cards += d.cards;
      return acc;
    }, {}),
  ).sort((a, b) => b.cards - a.cards);
  const maxCards = Math.max(1, ...tops.map((d) => d.cards));
  const browse = (q: string) => navigate(`/browse?q=${encodeURIComponent(q)}`);

  const look = (
    <Sec q="What it looks like" className="types-first">
      <LiveCard t={summary} def={def} face={face} onCode={() => setCode(files.find((f) => f.name === "template.html")?.name ?? files[0]?.name ?? null)} />
    </Sec>
  );
  const fill = (
    <Sec q="What you fill in" a={<><b>{def.fields.length}</b> field{def.fields.length === 1 ? "" : "s"}{priv ? `. ${priv === 1 ? "One stays" : `${priv} stay`} hidden until you answer.` : "."}</>}>
      <div className="flex flex-col">
        {def.fields.map((f) => (
          <div key={f.name} className="flex min-h-10 items-center gap-3 py-1.5 text-sm">
            <code className="font-mono text-[13px]">{f.name}</code>
            <span className="text-muted-foreground">{KIND[f.kind] ?? f.kind}</span>
            <span className="flex-1" />
            {f.private && <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><Lock className="size-3" /><span className="max-sm:hidden">hidden until answered</span><span className="sm:hidden">hidden</span></span>}
          </div>
        ))}
      </div>
    </Sec>
  );
  const how = (
    <Sec q="How it works">
      <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-4 gap-y-4 text-[15px] leading-snug max-sm:grid-cols-1 max-sm:gap-y-1">
        <dt className="text-muted-foreground">Checked by</dt>
        <dd className="max-sm:mb-3">{checkedBy(def.grader.kind)}</dd>
        <dt className="text-muted-foreground">Cards</dt>
        <dd className="max-sm:mb-3">
          {faces.length > 1 ? (
            <>
              Each item makes <b>{faces.length}</b> cards, each scheduled on its own.
              <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Show a card of this face">
                {faces.map((f) => {
                  const on = (face ?? faces[0]) === f;
                  return (
                    <button key={f} onClick={() => setFace(f)} aria-pressed={on} title={`Show the ${f} card`} className={cn("rounded-md bg-muted px-2 py-0.5 font-mono text-[13px] transition-colors hover:text-foreground", on ? "text-foreground" : "text-muted-foreground")}>
                      {f}
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            "One card per item."
          )}
        </dd>
        <dt className="text-muted-foreground">Comes back</dt>
        <dd className="max-sm:mb-3">
          {drill
            ? "Whenever you want. It's a drill: no memory model, every run is scored."
            : def.scheduler
              ? <>When its scheduler says so: <code className="font-mono text-[13px]">{def.scheduler}</code>, unless the deck picks another.</>
              : "When your deck's scheduler says so. FSRS, unless the deck picks another."}
        </dd>
        {def.showVerdict === false && (
          <>
            <dt className="text-muted-foreground">Result</dt>
            <dd>Its own result screen. Etude doesn't add Correct or Not quite.</dd>
          </>
        )}
      </dl>
    </Sec>
  );
  const used = (
    <Sec
      q="Where it's used"
      a={summary.items ? <span className="score-serif text-[1.35rem]"><b className="font-semibold">{plural(summary.items, "item")}</b> in {plural(tops.length, "deck")}.</span> : "Not used yet."}
    >
      {summary.items > 0 ? (
        <>
          <div className="flex flex-col">
            {tops.slice(0, 5).map((d) => (
              <button key={d.deck} onClick={() => browse(`type:${id} deck:"${d.deck}"`)} className="group flex min-h-12 items-center gap-3 rounded-lg py-1.5 text-left">
                <Layers className="size-5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium group-hover:underline">{d.deck}</span>
                  {tops.length > 1 && (
                    <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-muted">
                      <span className="block h-full rounded-full bg-muted-foreground/50" style={{ width: `${Math.max(3, (d.cards / maxCards) * 100)}%` }} />
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-sm text-muted-foreground"><b className="tabular font-semibold text-foreground">{fmtN(d.cards)}</b> card{d.cards === 1 ? "" : "s"}</span>
              </button>
            ))}
          </div>
          {tops.length > 5 && <p className="mt-1 text-sm text-muted-foreground">and {tops.length - 5} more</p>}
          <Button variant="ghost" className="mt-2 -ml-3 gap-2 text-[15px]" onClick={() => browse(`type:${id}`)}><SearchCode className="size-4" />See them in Browse</Button>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Add an item from a deck, or ask Etude to make a few.</p>
      )}
      {summary.archived > 0 && <p className="mt-2 text-xs text-muted-foreground">{plural(summary.archived, "archived item")} also use it.</p>}
    </Sec>
  );
  const made = (
    <Sec q="What it's made of" a={<>{plural(files.length, "file")}{assets.length ? ", with assets" : ""}.</>}>
      <div className="flex flex-col">
        {files.map((f) => (
          <button key={f.name} onClick={() => setCode(f.name)} className="group flex min-h-11 items-center gap-3 rounded-lg text-left text-sm">
            <File className="size-4 shrink-0 text-muted-foreground" />
            <code className="shrink-0 font-mono text-[13px] group-hover:underline">{f.name}</code>
            <span className="min-w-0 flex-1 truncate text-muted-foreground max-sm:hidden">{f.about}</span>
            <span className="ml-auto shrink-0 tabular text-xs text-muted-foreground">{fmtBytes(bytes(f.text))}</span>
          </button>
        ))}
        {assets.length > 0 && (
          <div className="flex min-h-11 items-center gap-3 text-sm" title={assets.map((a) => a.name).join("\n")}>
            <Folder className="size-4 shrink-0 text-muted-foreground" />
            <code className="shrink-0 font-mono text-[13px]">assets/</code>
            <span className="min-w-0 flex-1 truncate text-muted-foreground max-sm:hidden">{plural(assets.length, "image, sound or model", "images, sounds and models")}</span>
            <span className="ml-auto shrink-0 tabular text-xs text-muted-foreground">{fmtBytes(assets.reduce((n, a) => n + a.size, 0))}</span>
          </div>
        )}
      </div>
      <p className="mt-3 text-[13px] text-muted-foreground">Edit opens them with a live preview beside the code.{summary.shipped ? " Saving a built-in makes it your version; you can reset it." : ""}</p>
    </Sec>
  );

  const edit = () => navigate(`/types/${encodeURIComponent(id)}?edit=1`);
  return (
    <div className="types-page mx-auto w-full max-w-[62rem] px-4 pt-5 pb-12 phone:pt-[calc(1rem+env(safe-area-inset-top))] sm:px-8 sm:pt-8">
      <button className="-ml-1.5 mb-3 flex min-h-9 items-center gap-1 rounded-md px-1.5 text-[15px] text-muted-foreground transition-colors hover:text-foreground" onClick={() => navigate("/types")}>
        <ChevronLeft className="size-4" />Card types
      </button>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <h1 className="score-serif score-display text-[2.1rem] leading-[1.1] sm:text-[2.4rem]">{def.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
            {summary.edited ? <span className="types-badge">Your version</span> : summary.shipped && <span className="types-badge">Built in</span>}
            {summary.folder && <span className="inline-flex items-center gap-1"><Folder className="size-3.5" />{summary.folder.split("::").join(" › ")}</span>}
            <code className="font-mono">{def.id}</code>
            {summary.updated && <span>changed {fmtDay(summary.updated)}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <TryIt t={summary} />
          <Button className="h-10 gap-1.5 px-4 text-[15px]" onClick={edit}><Pencil className="size-4" />Edit</Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-10 text-muted-foreground" aria-label="More actions"><MoreHorizontal className="size-5" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setCode(files[0]?.name ?? null)}><Code2 />See the code</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setDup(true)}><Copy />Duplicate…</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setMoving({ kind: "type", id, name: def.name, folder: summary.folder })}><FolderInput />Move to folder…</DropdownMenuItem>
              <DropdownMenuItem onClick={() => download(`${id}.type.json`, exportShape(def))}><Download />Export JSON</DropdownMenuItem>
              {summary.edited && <DropdownMenuItem onClick={() => setResetting(true)}><RotateCcw />Reset to the shipped version…</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {def.description && <p className="mt-4 max-w-[62ch] text-[15.5px] leading-relaxed text-pretty text-muted-foreground">{def.description}</p>}

      <div className="mt-7 grid items-start gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          {look}
          <div className="max-lg:hidden">{fill}</div>
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          {how}
          {used}
          <div className="lg:hidden">{fill}</div>
          {made}
        </div>
      </div>

      <CodeViewer def={def} files={files} open={code} onOpen={setCode} onEdit={edit} />
      <AlertDialog open={resetting} onOpenChange={setResetting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Go back to the shipped {def.name}?</AlertDialogTitle>
            <AlertDialogDescription>Your changes to this type are replaced by the version that comes with Etude. Items and their history stay.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                try {
                  setDef(await api.resetType(id));
                  await reload();
                  toast.success("Restored the shipped version");
                } catch (e) {
                  toast.error((e as Error).message);
                }
              }}
            >
              Reset
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <NewTypeDialog open={dup} onOpenChange={setDup} types={types} initialSource={id} folder={summary.folder || undefined} />
      <MoveDialog
        target={moving}
        folders={folders}
        onOpenChange={(o) => !o && setMoving(null)}
        onMoveType={async (tid, folder) => {
          try {
            await api.moveType(tid, folder);
            await reload();
            toast.success(folder ? `Moved to ${leaf(folder)}` : "Taken out of its folder");
          } catch (e) {
            toast.error((e as Error).message);
          }
        }}
        onMoveFolder={async () => {}}
      />
    </div>
  );
}

function Sec({ q, a, className, children }: { q: string; a?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <section className={cn("types-sec rounded-2xl border bg-card p-5 sm:p-6", className)}>
      <h2 className="types-kicker">{q}</h2>
      {a && <div className="mt-2.5 text-[15px]">{a}</div>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** Opens a real card of the type in Study, as practice. Hidden when nothing uses the type yet. */
function TryIt({ t }: { t: TypeSummary }) {
  const [sample, setSample] = useState<Sample | null>(null);
  useEffect(() => {
    let live = true;
    if (t.items) loadSample(t).then((s) => live && setSample(s), () => {});
    return () => {
      live = false;
    };
  }, [t.id, t.updated, t.items]);
  if (!sample?.item) return null;
  const { cardId, deck } = sample.item;
  return (
    <Button variant="outline" className="types-raised h-10 gap-1.5 px-4 text-[15px]" onClick={() => navigate(`/study?card=${cardId}&deck=${encodeURIComponent(deck)}`)}>
      <Play className="size-3.5 fill-current" />Try it
    </Button>
  );
}

/** One real card you can answer. Checking runs the type's grader; nothing is saved. */
function LiveCard({ t, def, face, onCode }: { t: TypeSummary; def: CardType; face?: string; onCode(): void }) {
  const [sample, setSample] = useState<Sample | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CardResult | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    setResult(null);
    loadSample(t, face).then((s) => live && (setSample(s), setError(null)), (e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [t.id, t.updated, face]);

  const grade = async (answer: unknown) => {
    if (!sample) return;
    try {
      const fields = sample.item ? (await api.item(sample.item.id)).fields : fieldDefaults(def);
      const r = await api.previewType(exportShape(def), fields, { seed: sample.seed, face: sample.face, answer });
      if (r.grade) setResult({ grade: r.grade, key: r.key ?? sample.key, answer });
      else if (r.errors.length) toast.error(r.errors.join("\n"));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <>
      <div className="types-live -mx-1 rounded-xl px-1">
        {error && <pre className="whitespace-pre-wrap px-2 py-6 text-sm text-muted-foreground">This type has no card to show yet. {error}</pre>}
        {!sample && !error && <Skeleton className="h-56 rounded-xl" />}
        {sample && (
          <CardFrame
            frameKey={`${t.id}:${t.updated}:${sample.face}:${round}:${result ? "r" : ""}`}
            src={sample.src}
            view={sample.view}
            mode={result ? "result" : "answer"}
            result={result}
            answer={result?.answer}
            autoFocus={false}
            onSubmit={grade}
            onError={(m) => setError(m)}
          />
        )}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        {result ? (
          <Button variant="outline" className="types-raised h-10 gap-1.5 text-[15px]" onClick={() => { setResult(null); setRound(round + 1); }}><RotateCcw className="size-4" />Again</Button>
        ) : null}
        <Button variant="outline" className="types-raised h-10 gap-2 text-[15px]" onClick={onCode}><Code2 className="size-4" />See the code</Button>
        <span className="text-[13px] text-muted-foreground">{sample?.item ? `A real card from ${sample.item.deck.split("::")[0]}` : sample ? "A sample card" : ""}{result ? ". Checked, nothing saved." : ""}</span>
      </div>
    </>
  );
}

const LANG = { js: javascript, html: htmlLang, css: cssLang, json: jsonLang };
// Theme colours only (no One Dark background): the viewer sits on the app's own surface in every theme.
const viewTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", fontSize: "13px" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "color-mix(in oklab, var(--muted-foreground) 70%, transparent)" },
  ".cm-content": { fontFamily: "var(--font-mono)", caretColor: "var(--foreground)" },
  "&.cm-focused": { outline: "none" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { background: "color-mix(in oklab, var(--foreground) 14%, transparent) !important" },
  ".cm-scroller": { lineHeight: "1.6" },
});

function CodeViewer({ def, files, open, onOpen, onEdit }: { def: CardType; files: FileEntry[]; open: string | null; onOpen(f: string | null): void; onEdit(): void }) {
  const scheme = useScheme();
  const f = files.find((x) => x.name === open) ?? null;
  return (
    <Dialog open={!!open} onOpenChange={(o) => !o && onOpen(null)}>
      <DialogContent showCloseButton={false} className="flex h-[min(46rem,88dvh)] w-[min(60rem,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <div className="flex items-center gap-3 px-5 pt-4 pb-2">
          <DialogTitle className="min-w-0 truncate text-base font-semibold">{def.name}</DialogTitle>
          <code className="hidden font-mono text-[12.5px] text-muted-foreground sm:inline">{def.id}</code>
          <DialogDescription className="sr-only">The files this card type is made of, read-only.</DialogDescription>
          <span className="flex-1" />
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => { onOpen(null); onEdit(); }}><Pencil className="size-3.5" />Edit</Button>
          <Button variant="ghost" size="icon" className="size-9" onClick={() => onOpen(null)} aria-label="Close"><X className="size-4" /></Button>
        </div>
        <div className="flex gap-1 overflow-x-auto px-4 pb-2" role="tablist">
          {files.map((x) => (
            <button key={x.name} role="tab" aria-selected={x.name === open} onClick={() => onOpen(x.name)} className={cn("shrink-0 rounded-md px-2.5 py-1.5 font-mono text-[12.5px] transition-colors hover:text-foreground", x.name === open ? "bg-muted text-foreground" : "text-muted-foreground")}>
              {x.name}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-muted/50 px-1 py-2">
          {f && <CodeMirror key={f.name} value={f.text} editable={false} readOnly theme="none" extensions={[LANG[f.lang](), viewTheme, syntaxHighlighting(scheme === "light" ? defaultHighlightStyle : oneDarkHighlightStyle)]} basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: false, highlightActiveLineGutter: false }} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
