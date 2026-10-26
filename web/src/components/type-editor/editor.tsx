// The card type editor: schema, template, scripts and grader on the left, a live preview of the
// unsaved draft on the right. Nothing is stored until Save.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, Copy, Download, Loader2, MoreHorizontal, Plus, RotateCcw, Save, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { CodeEditor } from "@/components/code-editor";
import { CardPreview } from "@/components/card-preview";
import { AutoTextarea, FieldEditor } from "@/components/field-editor";
import { api, ApiError, type CardType, type TypeSummary } from "@/lib/api";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { FieldsSchema } from "./fields-schema";
import { TemplateReference } from "./reference";
import { NewTypeDialog } from "./dialogs";
import { BLANK_SAMPLE, clearPending, download, exportShape, fieldDefaults, GRADE_EXAMPLE, PREPARE_EXAMPLE, readPending, stashPending, TYPE_ID } from "./starter";

type Grader = CardType["grader"] & { code?: string; vision?: boolean; instructions?: string };

const same = (a: CardType, b: CardType) => JSON.stringify(exportShape(a)) === JSON.stringify(exportShape(b));

export function TypeEditor({ id }: { id: string }) {
  const [saved, setSaved] = useState<CardType | null>(null);
  const [draft, setDraft] = useState<CardType | null>(null);
  const [sample, setSample] = useState<Record<string, unknown>>({});
  const [summary, setSummary] = useState<TypeSummary | null>(null);
  const [allTypes, setAllTypes] = useState<TypeSummary[]>([]);
  const [missing, setMissing] = useState(false);
  const [sampleFrom, setSampleFrom] = useState<string>("");

  const isNew = !saved;

  // ------------------------------------------------------------- loading
  const pickSample = useCallback(async (typeId: string, def: CardType): Promise<{ fields: Record<string, unknown>; from: string }> => {
    try {
      const r = await api.search(`type:${typeId}`, { limit: 1 });
      if (r.rows[0]) {
        const it = await api.item(r.rows[0].itemId);
        return { fields: it.fields, from: `item ${it.id}` };
      }
    } catch {
      // fall through to defaults
    }
    return { fields: fieldDefaults(def), from: "field defaults" };
  }, []);

  useEffect(() => {
    let live = true;
    (async () => {
      const types = await api.types().catch(() => [] as TypeSummary[]);
      if (!live) return;
      setAllTypes(types);
      setSummary(types.find((t) => t.id === id) ?? null);
      let def: CardType | null = null;
      try {
        def = await api.type(id);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) {
          toast.error((e as Error).message);
          return;
        }
      }
      if (!live) return;
      if (def) {
        clearPending(id);
        setSaved(def);
        setDraft(def);
        const s = await pickSample(id, def);
        if (!live) return;
        setSample(s.fields);
        setSampleFrom(s.from);
        return;
      }
      const pending = readPending(id);
      if (!pending) return setMissing(true);
      setDraft(pending.def);
      if (pending.sample) {
        setSample(pending.sample);
        setSampleFrom(pending.from ? `copied from ${pending.from}` : "starter sample");
      } else {
        const s = await pickSample(pending.from ?? id, pending.def);
        if (!live) return;
        setSample(s.fields);
        setSampleFrom(s.from);
      }
    })();
    return () => {
      live = false;
    };
  }, [id, pickSample]);

  const dirty = !!draft && (isNew || !same(saved!, draft));

  // Unsaved new types survive a reload.
  useEffect(() => {
    if (!draft || !isNew) return;
    const t = setTimeout(() => stashPending({ ...readPending(id), def: draft, sample }), 400);
    return () => clearTimeout(t);
  }, [draft, sample, isNew]);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  // ------------------------------------------------------------- preview
  const editorPane = useRef<HTMLDivElement>(null);
  const previewPane = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<{ def: CardType; sample: Record<string, unknown>; html: string; v: number } | null>(null);
  const [fatal, setFatal] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [cardError, setCardError] = useState<string | null>(null);
  const lastFace = useRef<string>("main");
  const seq = useRef(0);

  useEffect(() => {
    if (!draft) return;
    const n = ++seq.current;
    const t = setTimeout(async () => {
      const def = exportShape(draft);
      try {
        const { html } = await api.frameHtml(def);
        if (n !== seq.current) return;
        setCardError(null);
        setPreview((p) => ({ def, sample, html, v: (p?.v ?? 0) + 1 }));
      } catch (e) {
        if (n === seq.current) setFatal([(e as Error).message]);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [draft, sample]);

  // A freshly mounted card frame focuses itself, which would swallow typing and Ctrl S while
  // editing. Right after a remount, send focus back to where it was in the editor, unless the
  // pointer is over the preview (the user is clicking into the card on purpose).
  useEffect(() => {
    const pane = previewPane.current;
    if (!pane) return;
    let createdAt = 0;
    let lastFocus: HTMLElement | null = null;
    const watch = new MutationObserver((records) => {
      if (records.some((r) => [...r.addedNodes].some((n) => n instanceof HTMLIFrameElement || (n instanceof HTMLElement && n.querySelector("iframe"))))) createdAt = Date.now();
    });
    watch.observe(pane, { childList: true, subtree: true });
    const onFocusIn = (e: FocusEvent) => {
      if (!(e.target instanceof HTMLIFrameElement)) lastFocus = e.target as HTMLElement;
    };
    const onBlur = () => {
      setTimeout(() => {
        const a = document.activeElement;
        if (!(a instanceof HTMLIFrameElement) || !pane.contains(a)) return;
        if (Date.now() - createdAt > 2000 || a.matches(":hover")) return;
        if (lastFocus?.isConnected && lastFocus.offsetParent) lastFocus.focus({ preventScroll: true });
        else a.blur();
      }, 0);
    };
    document.addEventListener("focusin", onFocusIn);
    window.addEventListener("blur", onBlur);
    return () => {
      watch.disconnect();
      document.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("blur", onBlur);
    };
  }, [!!draft]);

  const load = useCallback(async (seed: number, face: string) => {
    if (!preview) return null;
    lastFace.current = face;
    const r = await api.previewType(preview.def, preview.sample, { seed, face });
    if (!r.view) {
      setFatal(r.errors);
      setWarnings([]);
      throw new Error(r.errors.join("\n"));
    }
    setFatal([]);
    setWarnings(r.errors);
    return { view: r.view, key: r.key ?? {}, seed: r.seed ?? seed };
  }, [preview]);

  const gradeTest = useCallback(async (answer: unknown, data: { seed: number }) => {
    if (!preview) return null;
    const r = await api.previewType(preview.def, preview.sample, { seed: data.seed, face: lastFace.current, answer });
    if (!r.grade) {
      setFatal(r.errors);
      toast.error("The grade script failed", { description: r.errors.join("\n").slice(0, 400) });
      return null;
    }
    return r.grade;
  }, [preview]);

  // ---------------------------------------------------------------- save
  const [saving, setSaving] = useState(false);
  const [saveErrors, setSaveErrors] = useState<string[]>([]);
  const [confirmBuiltin, setConfirmBuiltin] = useState(false);

  const doSave = useCallback(async () => {
    if (!draft) return;
    const problems: string[] = [];
    if (!TYPE_ID.test(draft.id)) problems.push("id must be a lowercase slug (a-z, 0-9, -)");
    if (!draft.name.trim()) problems.push("name is required");
    if (isNew && allTypes.some((t) => t.id === draft.id)) problems.push(`a type called "${draft.id}" already exists; pick another id`);
    if (problems.length) {
      setSaveErrors(problems);
      return;
    }
    setSaving(true);
    try {
      await api.saveType(exportShape(draft));
      // A type made with "New type here" in a folder lands in that folder.
      const folder = isNew ? readPending(id)?.folder : undefined;
      if (folder) await api.moveType(draft.id, folder).catch(() => {});
      const fresh = await api.type(draft.id);
      const types = await api.types();
      setAllTypes(types);
      setSummary(types.find((t) => t.id === draft.id) ?? null);
      setSaveErrors([]);
      if (isNew) {
        clearPending(id);
        if (draft.id !== id) {
          navigate(`/types/${encodeURIComponent(draft.id)}`, { replace: true });
          toast.success(`Created ${draft.name}`);
          return;
        }
      }
      setSaved(fresh);
      setDraft(fresh);
      toast.success(isNew ? `Created ${draft.name}` : "Saved");
    } catch (e) {
      const msg = (e as Error).message.replace(/^invalid type:\s*/, "");
      setSaveErrors(msg.split(/;\s+/));
      toast.error("Couldn't save", { description: msg.slice(0, 300) });
    } finally {
      setSaving(false);
    }
  }, [draft, isNew, allTypes, id]);

  const save = useCallback(() => {
    if (!dirty || saving) return;
    if (saved?.builtin) setConfirmBuiltin(true);
    else doSave();
  }, [dirty, saving, saved, doSave]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [save]);

  // ------------------------------------------------------------- actions
  const [dupOpen, setDupOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [tab, setTab] = useState("info");

  // Back to the folder the type lives in.
  const home = summary?.folder ? `/types?folder=${encodeURIComponent(summary.folder)}` : "/types";
  const back = () => (dirty ? setConfirmLeave(true) : navigate(home));
  const reset = async () => {
    try {
      const fresh = await api.resetType(id);
      setSaved(fresh);
      setDraft(fresh);
      const types = await api.types();
      setAllTypes(types);
      setSummary(types.find((t) => t.id === id) ?? null);
      toast.success("Restored the shipped version");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const del = async () => {
    try {
      await api.deleteType(id);
      toast.success(`Deleted ${saved?.name ?? id}`);
      navigate("/types");
    } catch (e) {
      toast.error("Couldn't delete", { description: (e as Error).message });
    }
  };

  const items = summary?.items ?? 0;
  const generated = typeof sample.generator === "string" || /\brng\b/.test(draft?.prepare ?? "");

  if (missing)
    return (
      <div className="mx-auto flex max-w-xl flex-col items-center gap-4 px-6 py-24 text-center">
        <p className="text-muted-foreground">There's no card type called <code className="font-mono text-foreground">{id}</code>.</p>
        <Button variant="outline" onClick={() => navigate("/types")}><ArrowLeft className="size-4" />All card types</Button>
      </div>
    );
  if (!draft) return <div className="flex h-[60dvh] items-center justify-center text-muted-foreground"><Loader2 className="animate-spin" /></div>;

  const set = (patch: Partial<CardType>) => setDraft({ ...draft, ...patch });
  const grader = draft.grader as Grader;
  const setGrader = (g: Partial<Grader>) => set({ grader: { ...grader, ...g } as CardType["grader"] });
  const problemCount = fatal.length + (cardError ? 1 : 0);

  return (
    <div className="mx-auto w-full max-w-[1600px]">
      {/* header */}
      <div className="flex items-start gap-2 px-4 pt-4 sm:px-6 sm:pt-6 lg:px-8">
        <Button variant="ghost" size="icon" className="-ml-2 size-10 shrink-0" onClick={back} aria-label="All card types"><ArrowLeft className="size-4" /></Button>
        <div className="min-w-0 flex-1 pt-1">
          <h1 className="truncate text-xl font-semibold tracking-tight sm:text-2xl">{draft.name || <span className="text-muted-foreground">Untitled type</span>}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <code className="font-mono">{draft.id}</code>
            {isNew ? <Badge variant="outline" className="font-normal text-highlight">new, not saved</Badge> : <Kind summary={summary} />}
            {!isNew && <span className="tabular">{items} item{items === 1 ? "" : "s"}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button size="icon" variant="ghost" className="size-10" aria-label="More actions"><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setDupOpen(true)}><Copy />Duplicate…</DropdownMenuItem>
              <DropdownMenuItem onClick={() => download(`${draft.id}.type.json`, exportShape(draft))}><Download />Export JSON</DropdownMenuItem>
              {!isNew && items > 0 && <DropdownMenuItem onClick={() => navigate(`/browse?q=${encodeURIComponent(`type:${id}`)}`)}><Plus />Items of this type</DropdownMenuItem>}
              {(summary?.edited || (!isNew && summary?.shipped && !saved?.builtin)) && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setConfirmReset(true)}><RotateCcw />Reset to shipped version…</DropdownMenuItem>
                </>
              )}
              {!summary?.shipped && (
                <>
                  <DropdownMenuSeparator />
                  {isNew ? (
                    <DropdownMenuItem variant="destructive" onClick={() => { clearPending(id); navigate("/types"); }}><X />Discard new type</DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem variant="destructive" disabled={items > 0} onClick={() => setConfirmDelete(true)}>
                      <Trash2 />{items > 0 ? `Delete (used by ${items})` : "Delete…"}
                    </DropdownMenuItem>
                  )}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {saved?.builtin && (
        <p className="mx-4 mt-4 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground sm:mx-6 lg:mx-8">
          This is a built-in type. Saving makes it your own version: Etude updates won't replace it, and you can reset it to the shipped version at any time.
        </p>
      )}

      {saveErrors.length > 0 && (
        <div className="mx-4 mt-4 flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2.5 text-sm sm:mx-6 lg:mx-8">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <ul className="min-w-0 flex-1 space-y-0.5">{saveErrors.map((e, i) => <li key={i} className="break-words font-mono text-[12.5px]">{e}</li>)}</ul>
          <button className="text-muted-foreground hover:text-foreground" onClick={() => setSaveErrors([])} aria-label="Dismiss"><X className="size-4" /></button>
        </div>
      )}

      {/* phone and tablet: editor or preview */}
      <div className="px-4 pt-4 sm:px-6 lg:hidden">
        <ToggleGroup type="single" variant="outline" value={view} onValueChange={(v) => v && setView(v as "edit" | "preview")} className="w-full">
          <ToggleGroupItem value="edit" className="h-10 flex-1">Edit</ToggleGroupItem>
          <ToggleGroupItem value="preview" className="h-10 flex-1 gap-1.5">
            Preview{problemCount > 0 && <span className="size-1.5 rounded-full bg-destructive" aria-label="has problems" />}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="grid gap-x-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:px-8">
        {/* editor */}
        <div ref={editorPane} className={cn("min-w-0 px-4 pb-6 pt-4 sm:px-6 lg:block lg:px-0 lg:pt-6", view === "edit" ? "block" : "hidden")}>
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="grid w-full grid-cols-3 gap-1 group-data-[orientation=horizontal]/tabs:h-auto sm:flex sm:w-fit lg:grid lg:w-full xl:flex xl:w-fit">
              {[
                ["info", "Info"],
                ["fields", `Fields`],
                ["template", "Template"],
                ["prepare", "Prepare"],
                ["grader", "Grader"],
                ["sample", "Sample"],
              ].map(([v, l]) => (
                <TabsTrigger key={v} value={v} className="h-9 px-3">
                  {l}
                  {v === "fields" && <span className="tabular text-muted-foreground">{draft.fields.length}</span>}
                </TabsTrigger>
              ))}
            </TabsList>

            <TabsContent value="info" className="mt-5 flex flex-col gap-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Name">
                  <Input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="True or false" />
                </Field>
                <Field label="Id" hint={isNew ? "Lowercase letters, digits and dashes. Items refer to the type by id." : "The id can't change once items can refer to it."}>
                  <Input
                    value={draft.id}
                    disabled={!isNew}
                    onChange={(e) => set({ id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 64) })}
                    className={cn("font-mono text-[13px]", isNew && !TYPE_ID.test(draft.id) && "border-destructive")}
                    spellCheck={false}
                  />
                </Field>
              </div>
              <Field label="Description" hint="One or two sentences shown in the type list and when adding a card.">
                <AutoTextarea value={draft.description ?? ""} onChange={(v) => set({ description: v })} placeholder="What the learner does and how it's graded." />
              </Field>
              <FacesEditor faces={draft.faces} onChange={(faces) => set({ faces })} />
            </TabsContent>

            <TabsContent value="fields" className="mt-5">
              <FieldsSchema
                fields={draft.fields}
                itemCount={items}
                onChange={(fields) => {
                  // A sample value that no longer fits its field's kind would only produce warnings.
                  const next = { ...sample };
                  let changed = false;
                  for (const f of fields) {
                    const before = draft.fields.find((x) => x.name === f.name);
                    if (before && before.kind !== f.kind && f.name in next && !fits(f.kind, next[f.name])) {
                      delete next[f.name];
                      changed = true;
                    }
                  }
                  if (changed) setSample(next);
                  set({ fields });
                }}
                onRename={(from, to) => {
                  if (from === to || !(from in sample)) return;
                  const next = { ...sample, [to]: sample[from] };
                  delete next[from];
                  setSample(next);
                }}
              />
            </TabsContent>

            <TabsContent value="template" className="mt-5 flex flex-col gap-4">
              <TemplateTabs draft={draft} set={set} />
              <TemplateReference />
            </TabsContent>

            <TabsContent value="prepare" className="mt-5 flex flex-col gap-4">
              <label className="flex min-h-10 items-center gap-3 text-sm">
                <Switch checked={draft.prepare !== undefined} onCheckedChange={(v) => set({ prepare: v ? (draft.prepare ?? PREPARE_EXAMPLE) : undefined })} />
                Use a prepare script
              </label>
              {draft.prepare === undefined ? (
                <p className="text-sm text-muted-foreground">
                  Without one, fields marked hidden until answered go to the <code className="font-mono text-foreground">key</code> and every other field goes to the card as <code className="font-mono text-foreground">etude.view</code>. Add a script to shuffle options, build a different view per face, or derive values.
                </p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <code className="font-mono text-xs text-muted-foreground">function (fields, face, rng) {"{"}</code>
                  <CodeEditor lang="js" value={draft.prepare} onChange={(v) => set({ prepare: v })} minHeight={260} />
                  <code className="font-mono text-xs text-muted-foreground">{"}"} → {"{ view, key }"}</code>
                  <p className="mt-1 text-xs text-muted-foreground">Runs on the server in a sandbox (no network, 500 ms). Only <code className="font-mono">view</code> reaches the card before grading; <code className="font-mono">key</code> goes to the grader and to result templates.</p>
                </div>
              )}
            </TabsContent>

            <TabsContent value="grader" className="mt-5 flex flex-col gap-5">
              <GraderPicker
                kind={grader.kind}
                onChange={(kind) => {
                  const g: Grader = { ...grader, kind } as Grader;
                  if ((kind === "script" || kind === "hybrid") && !g.code) g.code = GRADE_EXAMPLE;
                  set({ grader: g as CardType["grader"] });
                }}
              />
              {(grader.kind === "script" || grader.kind === "hybrid") && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium">Grade script</span>
                  <code className="font-mono text-xs text-muted-foreground">function (answer, view, key, fields) {"{"}</code>
                  <CodeEditor lang="js" value={grader.code ?? ""} onChange={(code) => setGrader({ code })} minHeight={200} />
                  <code className="font-mono text-xs text-muted-foreground">{"}"} → {"{ score, details?, feedback? }"}</code>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {grader.kind === "hybrid"
                      ? "Return a score to decide here, or { defer: true } (or score: null) to hand the answer to the AI grader."
                      : "Score from 0 to 1. Try it in the preview: answer the card and press Check answer or Ctrl Enter."}
                  </p>
                </div>
              )}
              {(grader.kind === "ai" || grader.kind === "hybrid") && (
                <>
                  <label className="flex min-h-10 items-center gap-3 text-sm">
                    <Switch checked={!!grader.vision} onCheckedChange={(v) => setGrader({ vision: v || undefined })} />
                    <span>Needs a vision model <span className="text-muted-foreground">(drawings, images)</span></span>
                  </label>
                </>
              )}
              <label className="flex min-h-10 items-start gap-3 text-sm">
                <Switch className="mt-0.5" checked={draft.showVerdict !== false} onCheckedChange={(v) => set({ showVerdict: v ? undefined : false })} />
                <span>
                  Show the verdict and feedback after an answer
                  <span className="block text-xs text-muted-foreground">"Correct", "Not quite" and the grader's comments. Turn it off when the card's own result says it all, like a typing test. The score is still recorded.</span>
                </span>
              </label>
              <Field
                label="AI grading instructions"
                hint="The most general layer: the item's rubric, its tags' and its deck's instructions come first and win on conflict."
              >
                <AutoTextarea value={draft.instructions ?? ""} onChange={(v) => set({ instructions: v || undefined })} placeholder="What counts as correct for this kind of card." />
              </Field>
            </TabsContent>

            <TabsContent value="sample" className="mt-5 flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>The preview uses these values. Nothing here is saved{sampleFrom ? `; loaded from ${sampleFrom}` : ""}.</span>
                <div className="flex-1" />
                <Button variant="ghost" size="sm" className="h-9" onClick={async () => {
                  const s = isNew && draft.id === id && readPending(id)?.def ? { fields: { ...BLANK_SAMPLE }, from: "starter sample" } : await pickSample(id, draft);
                  setSample(s.fields);
                  setSampleFrom(s.from);
                }}>Reload</Button>
                <Button variant="ghost" size="sm" className="h-9" onClick={() => { setSample(fieldDefaults(draft)); setSampleFrom("field defaults"); }}>Use defaults</Button>
              </div>
              {draft.fields.length ? (
                <FieldEditor fields={draft.fields.filter((f) => /^[A-Za-z_]\w*$/.test(f.name))} value={sample} onChange={setSample} />
              ) : (
                <p className="text-sm text-muted-foreground">Add fields first.</p>
              )}
            </TabsContent>
          </Tabs>
        </div>

        {/* preview */}
        <aside className={cn("min-w-0 px-4 pb-6 pt-4 sm:px-6 lg:sticky lg:top-0 lg:block lg:max-h-dvh lg:self-start lg:overflow-y-auto lg:px-0 lg:pt-6", view === "preview" ? "block" : "hidden")}>
          <div className="mb-3 flex items-baseline gap-2">
            <h2 className="text-sm font-medium">Live preview</h2>
            <span className="text-xs text-muted-foreground">{dirty ? "unsaved draft" : "saved version"}</span>
          </div>
          {(fatal.length > 0 || cardError || warnings.length > 0) && (
            <div className="mb-3 flex flex-col gap-2">
              {fatal.length > 0 && <Problem tone="error" title="The preview can't run" lines={fatal} />}
              {cardError && <Problem tone="error" title="card.js threw an error" lines={[cardError]} />}
              {warnings.length > 0 && <Problem tone="warn" title="Sample data doesn't fit the fields" lines={warnings} />}
            </div>
          )}
          <div ref={previewPane}>
            {preview ? (
              <CardPreview
                html={preview.html}
                version={`draft:${preview.v}`}
                load={load}
                faces={preview.def.faces}
                generated={generated}
                grade={grader.kind === "script" || grader.kind === "hybrid" ? gradeTest : undefined}
                onError={setCardError}
              />
            ) : (
              <div className="flex h-40 items-center justify-center rounded-xl border text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>
            )}
          </div>
        </aside>
      </div>

      <div
        className={cn(
          "sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] z-10 flex items-center gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur transition-opacity sm:px-6 md:bottom-0 lg:px-8",
          dirty ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        <span className="text-sm text-muted-foreground">{isNew ? "Not created yet" : "Unsaved changes"}</span>
        <div className="flex-1" />
        {!isNew && <Button variant="ghost" size="sm" className="h-9" onClick={() => { setDraft(saved); setSaveErrors([]); }}>Discard</Button>}
        <Button size="sm" className="h-9 gap-1.5" onClick={save} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}{isNew ? "Create type" : "Save"}
          <kbd className="hidden text-[10px] opacity-60 sm:inline">Ctrl S</kbd>
        </Button>
      </div>

      <NewTypeDialog open={dupOpen} onOpenChange={setDupOpen} types={allTypes} from={{ def: draft, sample }} />

      <AlertDialog open={confirmBuiltin} onOpenChange={setConfirmBuiltin}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Make {saved?.name} your own?</AlertDialogTitle>
            <AlertDialogDescription>
              Saving replaces the built-in version for every item that uses it{items ? ` (${items} item${items === 1 ? "" : "s"})` : ""}. Later Etude updates won't change your version. You can reset to the shipped version at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={doSave}>Save my version</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset {saved?.name} to the shipped version?</AlertDialogTitle>
            <AlertDialogDescription>Your changes to the template, fields and scripts are replaced by the built-in version. Items and their review history aren't touched.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={reset}>Reset</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {saved?.name}?</AlertDialogTitle>
            <AlertDialogDescription>No items use this type. Export it first if you might want it back.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={del}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmLeave} onOpenChange={setConfirmLeave}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
            <AlertDialogDescription>{isNew ? "This type hasn't been created yet." : "Your changes to this type will be lost."}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (isNew) clearPending(id); navigate(home); }}>Leave</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function fits(kind: string, v: unknown): boolean {
  switch (kind) {
    case "number": return typeof v === "number";
    case "boolean": return typeof v === "boolean";
    case "list": return Array.isArray(v);
    case "markdown": case "text": case "code": return typeof v === "string";
    default: return true;
  }
}

export function Kind({ summary }: { summary: TypeSummary | null }) {
  if (!summary) return null;
  if (summary.edited) return <Badge variant="outline" className="border-highlight/40 font-normal text-highlight">edited built-in</Badge>;
  if (summary.shipped) return <Badge variant="outline" className="font-normal text-muted-foreground">built-in</Badge>;
  return <Badge variant="outline" className="font-normal text-muted-foreground">custom</Badge>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

function Problem({ tone, title, lines }: { tone: "error" | "warn"; title: string; lines: string[] }) {
  return (
    <div className={cn("rounded-lg border px-3 py-2.5", tone === "error" ? "border-destructive/50 bg-destructive/5" : "border-warning/40 bg-warning/5")}>
      <div className={cn("mb-1 flex items-center gap-1.5 text-sm font-medium", tone === "error" ? "text-destructive" : "text-warning")}>
        <AlertTriangle className="size-4" />{title}
      </div>
      {lines.map((l, i) => <pre key={i} className="whitespace-pre-wrap break-words font-mono text-[12px] text-foreground/90">{l}</pre>)}
    </div>
  );
}

function TemplateTabs({ draft, set }: { draft: CardType; set(p: Partial<CardType>): void }) {
  const [lang, setLang] = useState<"html" | "css" | "js">("html");
  const t = draft.template;
  const sizes = { html: t.html.length, css: (t.css ?? "").length, js: (t.js ?? "").length };
  return (
    <div className="flex flex-col gap-2">
      <ToggleGroup type="single" variant="outline" value={lang} onValueChange={(v) => v && setLang(v as typeof lang)}>
        {(["html", "css", "js"] as const).map((l) => (
          <ToggleGroupItem key={l} value={l} className="h-9 gap-1.5 px-4 text-xs">
            {l === "html" ? "HTML" : l === "css" ? "CSS" : "JS"}
            {!sizes[l] && <span className="text-muted-foreground">empty</span>}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {lang === "html" && <CodeEditor key="html" lang="html" value={t.html} onChange={(html) => set({ template: { ...t, html } })} minHeight={300} />}
      {lang === "css" && <CodeEditor key="css" lang="css" value={t.css ?? ""} onChange={(css) => set({ template: { ...t, css } })} minHeight={300} placeholder="/* Styles scoped to this card's frame */" />}
      {lang === "js" && <CodeEditor key="js" lang="js" value={t.js ?? ""} onChange={(js) => set({ template: { ...t, js } })} minHeight={300} placeholder="// Runs in the card frame with `etude` in scope" />}
      <p className="text-xs text-muted-foreground">
        {lang === "html" && "Rendered with the card's view. Put what appears only after grading inside <template data-on=\"result\">."}
        {lang === "css" && "Applies only inside this card's frame. Theme variables and the classes from card.css are available."}
        {lang === "js" && "The body of an async function that receives etude. Read the answer with etude.getAnswer, react to grading with etude.onResult."}
      </p>
    </div>
  );
}

const GRADERS: { kind: CardType["grader"]["kind"]; title: string; text: string }[] = [
  { kind: "self", title: "Self-rated", text: "Reveal the answer, the learner rates their recall." },
  { kind: "script", title: "Script", text: "A sandboxed function scores the answer instantly." },
  { kind: "ai", title: "AI", text: "A decision model gives the verdict, a language model writes feedback." },
  { kind: "hybrid", title: "Hybrid", text: "The script decides when it can and defers the rest to AI." },
];

function GraderPicker({ kind, onChange }: { kind: string; onChange(k: CardType["grader"]["kind"]): void }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Grader">
      {GRADERS.map((g) => (
        <button
          key={g.kind}
          role="radio"
          aria-checked={kind === g.kind}
          onClick={() => onChange(g.kind)}
          className={cn("flex min-h-16 flex-col gap-0.5 rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-accent/40", kind === g.kind && "border-foreground/70 bg-accent/50")}
        >
          <span className="text-sm font-medium">{g.title}</span>
          <span className="text-xs text-muted-foreground">{g.text}</span>
        </button>
      ))}
    </div>
  );
}

function FacesEditor({ faces, onChange }: { faces?: string[]; onChange(f: string[] | undefined): void }) {
  const [text, setText] = useState("");
  const list = faces ?? [];
  const valid = /^[\w-]+$/.test(text.trim());
  const add = () => {
    const f = text.trim();
    if (!valid || list.includes(f)) return;
    onChange([...(list.length ? list : []), f]);
    setText("");
  };
  const effective = list.length ? list : ["main"];
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">Faces</span>
      <p className="text-xs text-muted-foreground">
        Each face is its own scheduled card from the same item, like forward and reverse. Prepare receives the face name. Without faces, every item makes one card called <code className="font-mono">main</code>.
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {effective.map((f) => (
          <span key={f} className={cn("flex h-8 items-center gap-1 rounded-md border px-2.5 font-mono text-xs", !list.length && "border-dashed text-muted-foreground")}>
            {f}
            {list.length > 0 && (
              <button className="-mr-1 flex size-6 items-center justify-center text-muted-foreground hover:text-foreground" onClick={() => onChange(list.length > 1 ? list.filter((x) => x !== f) : undefined)} aria-label={`Remove face ${f}`}>
                <X className="size-3.5" />
              </button>
            )}
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder={list.length ? "Another face" : "e.g. forward"}
          className="h-9 max-w-56 font-mono text-[13px]"
        />
        <Button variant="outline" size="sm" className="h-9 gap-1.5" disabled={!valid || list.includes(text.trim())} onClick={add}><Plus className="size-4" />Add face</Button>
      </div>
      {list.length === 1 && <p className="text-xs text-muted-foreground">With one face, items still make one card; add a second to schedule both directions.</p>}
    </div>
  );
}
