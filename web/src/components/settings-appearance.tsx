// Settings → Appearance: pick a theme (applies at once, saved for every device), and make custom
// themes from CSS variables plus extra CSS, previewed live on the whole page while editing.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Copy, Download, Loader2, MoreHorizontal, Paintbrush, Pencil, Plus, RotateCcw, Save, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { CodeEditor } from "@/components/code-editor";
import { Block, Section } from "@/components/settings-ui";
import { ThemeMiniature, ThemeSample, ThemeSwatches } from "@/components/settings-theme-preview";
import { api } from "@/lib/api";
import { applyTheme, currentTheme, setPreviewing, toHex, type Theme } from "@/lib/theme";
import { BUILTIN_THEMES, MAX_THEME_CSS, THEME_GROUPS, exportTheme, freeThemeId, normalizeTheme, parseThemeFile, sanitizeCss } from "../../../src/core/themes.ts";
import { cn } from "@/lib/utils";

type ListedTheme = Theme & { builtin: boolean };

interface Editing {
  draft: Theme;
  /** Id of the custom theme being edited; null for a new one. */
  editId: string | null;
  /** The draft as opened, to tell whether anything changed. */
  initial: string;
}

const stripMeta = (t: Theme & { builtin?: boolean; selected?: boolean }): Theme => {
  const { builtin: _b, selected: _s, ...rest } = t;
  return rest;
};

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function AppearanceSection() {
  const [themes, setThemes] = useState<ListedTheme[] | null>(null);
  const [selected, setSelected] = useState<string>(currentTheme().id);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [renaming, setRenaming] = useState<ListedTheme | null>(null);
  const [deleting, setDeleting] = useState<ListedTheme | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.themes();
      setThemes(r.themes.map((t) => ({ ...stripMeta(t), builtin: t.builtin })));
      setSelected(r.selected);
      setLoadError(null);
      return r;
    } catch (e) {
      setLoadError((e as Error).message);
      return null;
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const custom = themes?.filter((t) => !t.builtin) ?? [];
  const takenIds = custom.map((t) => t.id);

  const use = async (t: ListedTheme) => {
    if (t.id === selected) return;
    const before = themes?.find((x) => x.id === selected);
    applyTheme(t);
    setSelected(t.id);
    try {
      await api.selectTheme(t.id);
    } catch (e) {
      if (before) applyTheme(before);
      setSelected(before?.id ?? selected);
      toast.error("Couldn't switch theme", { description: (e as Error).message });
    }
  };

  const startEdit = (t: ListedTheme, asCopy: boolean) => {
    const draft: Theme = asCopy
      ? { ...structuredClone(stripMeta(t)), id: "", name: `${t.name} copy`, base: t.builtin ? t.id : t.base }
      : structuredClone(stripMeta(t));
    setEditing({ draft, editId: asCopy ? null : t.id, initial: JSON.stringify(draft) });
  };

  const duplicate = async (t: ListedTheme) => {
    const copy = { ...stripMeta(t), id: freeThemeId(`${t.id}-copy`, takenIds), name: `${t.name} copy`, base: t.builtin ? t.id : t.base };
    try {
      await api.saveTheme(copy);
      await load();
      toast.success(`Made “${copy.name}”`);
    } catch (e) {
      toast.error("Couldn't duplicate", { description: (e as Error).message });
    }
  };

  const remove = async (t: ListedTheme) => {
    try {
      const r = await api.deleteTheme(t.id);
      if (selected === t.id) applyTheme(BUILTIN_THEMES.find((b) => b.id === r.selected) ?? BUILTIN_THEMES[0]);
      await load();
      toast.success(`Deleted “${t.name}”`);
    } catch (e) {
      toast.error("Couldn't delete", { description: (e as Error).message });
    }
  };

  const rename = async (t: ListedTheme, name: string) => {
    try {
      await api.saveTheme({ ...stripMeta(t), name });
      await load();
      if (t.id === selected) applyTheme({ ...stripMeta(t), name });
    } catch (e) {
      toast.error("Couldn't rename", { description: (e as Error).message });
    }
  };

  const importFiles = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.multiple = true;
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      if (!files.length) return;
      const taken = [...takenIds];
      let added = 0;
      for (const f of files) {
        try {
          let data: unknown;
          try {
            data = JSON.parse(await f.text());
          } catch {
            throw new Error("not valid JSON");
          }
          const raw = parseThemeFile(data) as Record<string, unknown>;
          const want = typeof raw.id === "string" && raw.id ? raw.id : String(raw.name ?? f.name.replace(/\.(theme\.)?json$/i, ""));
          const id = freeThemeId(want, taken);
          const { theme, removed } = normalizeTheme({ ...raw, id });
          const r = await api.saveTheme(theme);
          taken.push(id);
          added++;
          if (removed.length || r.removed.length) toast.warning(`Imported “${theme.name}” without ${removed.length || r.removed.length} remote reference${(removed.length || r.removed.length) === 1 ? "" : "s"}`);
        } catch (e) {
          toast.error(`Couldn't import ${f.name}`, { description: (e as Error).message });
        }
      }
      if (added) {
        await load();
        toast.success(added === 1 ? "Theme imported" : `${added} themes imported`);
      }
    };
    input.click();
  };

  const onSaved = async (t: Theme) => {
    setEditing(null);
    await load();
    setSelected(t.id);
  };

  return (
    <Section
      id="appearance"
      title="Appearance"
      description="The theme is saved with your collection, so every device and the CLI use the same one. Cards follow it too."
    >
      {loadError && (
        <Block>
          <p className="text-sm text-destructive">Couldn't load themes: {loadError}</p>
          <div>
            <Button variant="outline" size="sm" className="h-10 md:h-8" onClick={load}>Try again</Button>
          </div>
        </Block>
      )}

      {!themes && !loadError && (
        <Block>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="aspect-[16/12] rounded-lg" />)}
          </div>
        </Block>
      )}

      {themes && editing && (
        <ThemeEditor
          key={editing.editId ?? "new"}
          editing={editing}
          takenIds={takenIds}
          restore={themes.find((t) => t.id === selected) ?? BUILTIN_THEMES[0]}
          onCancel={() => setEditing(null)}
          onSaved={onSaved}
        />
      )}

      {themes && !editing && (
        <>
          <Block
            title="Theme"
            description="Click one to use it."
            aside={
              <Button size="sm" className="h-10 gap-1.5 md:h-8" onClick={() => startEdit(themes.find((t) => t.id === selected) ?? themes[0], true)}>
                <Plus className="size-4" />New theme
              </Button>
            }
          >
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {themes.filter((t) => t.builtin).map((t) => (
                <ThemeTile key={t.id} theme={t} selected={t.id === selected} onUse={() => use(t)} onCustomize={() => startEdit(t, true)} onDuplicate={() => duplicate(t)} onExport={() => download(`${t.id}.theme.json`, exportTheme(stripMeta(t)))} />
              ))}
            </div>
          </Block>

          <Block
            title="Custom themes"
            description={
              <>Start from any theme and change its colors, corners and fonts, or add CSS. Saved themes can be exported as JSON and imported on another collection.</>
            }
            aside={
              <Button variant="outline" size="sm" className="h-10 gap-1.5 md:h-8" onClick={importFiles}>
                <Upload className="size-4" />Import
              </Button>
            }
          >
            {custom.length === 0 ? (
              <button
                type="button"
                onClick={() => startEdit(themes.find((t) => t.id === selected) ?? themes[0], true)}
                className="flex min-h-24 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
              >
                <Paintbrush className="size-5" />
                <span>No custom themes yet.</span>
                <span className="text-xs">Make one from “{themes.find((t) => t.id === selected)?.name ?? "Midnight"}”</span>
              </button>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {custom.map((t) => (
                  <ThemeTile
                    key={t.id}
                    theme={t}
                    selected={t.id === selected}
                    onUse={() => use(t)}
                    onCustomize={() => startEdit(t, false)}
                    onDuplicate={() => duplicate(t)}
                    onExport={() => download(`${t.id}.theme.json`, exportTheme(stripMeta(t)))}
                    onRename={() => setRenaming(t)}
                    onDelete={() => setDeleting(t)}
                  />
                ))}
              </div>
            )}
          </Block>
        </>
      )}

      <RenameDialog theme={renaming} onClose={() => setRenaming(null)} onRename={rename} />

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.id === selected ? "It's the theme in use; the app goes back to Midnight. " : ""}Export it first if you might want it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => deleting && remove(deleting)}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}

function ThemeTile({ theme, selected, onUse, onCustomize, onDuplicate, onExport, onRename, onDelete }: {
  theme: ListedTheme;
  selected: boolean;
  onUse(): void;
  onCustomize(): void;
  onDuplicate(): void;
  onExport(): void;
  onRename?(): void;
  onDelete?(): void;
}) {
  return (
    <div className={cn("group relative rounded-lg border p-1.5 transition-colors", selected ? "border-highlight ring-1 ring-highlight" : "border-foreground/12 hover:border-ring/70")}>
      <button type="button" onClick={onUse} aria-pressed={selected} className="block w-full rounded-md text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <ThemeMiniature theme={theme} />
        <div className="flex min-h-11 flex-col justify-center gap-1.5 pt-2 pr-10 pb-1 pl-0.5">
          <div className="truncate text-sm leading-tight font-medium">{theme.name}</div>
          <div className="flex items-center gap-2">
            <span className="text-xs leading-none text-muted-foreground">{theme.scheme === "light" ? "Light" : "Dark"}</span>
            <ThemeSwatches theme={theme} className="hidden sm:flex" />
          </div>
        </div>
      </button>
      {selected && (
        <span className="pointer-events-none absolute -top-2 -right-2 flex size-6 items-center justify-center rounded-full bg-highlight text-background ring-4 ring-background" aria-hidden="true">
          <Check className="size-3.5" strokeWidth={3} />
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="absolute right-1 bottom-1 size-10 text-muted-foreground hover:text-foreground" aria-label={`${theme.name} options`}>
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onSelect={onCustomize}>
            {theme.builtin ? <Paintbrush className="size-4" /> : <Pencil className="size-4" />}
            {theme.builtin ? "Customize a copy" : "Edit"}
          </DropdownMenuItem>
          {onRename && <DropdownMenuItem onSelect={onRename}><Pencil className="size-4" />Rename</DropdownMenuItem>}
          <DropdownMenuItem onSelect={onDuplicate}><Copy className="size-4" />Duplicate</DropdownMenuItem>
          <DropdownMenuItem onSelect={onExport}><Download className="size-4" />Export JSON</DropdownMenuItem>
          {onDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onDelete}><Trash2 className="size-4" />Delete</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function RenameDialog({ theme, onClose, onRename }: { theme: ListedTheme | null; onClose(): void; onRename(t: ListedTheme, name: string): void }) {
  const [name, setName] = useState("");
  useEffect(() => {
    if (theme) setName(theme.name);
  }, [theme]);
  const ok = name.trim().length > 0;
  const submit = () => {
    if (!theme || !ok) return;
    onRename(theme, name.trim().slice(0, 60));
    onClose();
  };
  return (
    <Dialog open={!!theme} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename theme</DialogTitle>
          <DialogDescription>The id stays <code className="font-mono text-xs">{theme?.id}</code>, so the CLI and exports keep working.</DialogDescription>
        </DialogHeader>
        <Input autoFocus value={name} maxLength={60} className="h-10" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        <DialogFooter>
          <Button variant="ghost" className="h-10 md:h-9" onClick={onClose}>Cancel</Button>
          <Button className="h-10 md:h-9" disabled={!ok} onClick={submit}>Rename</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ editor

/** A value the browser accepts for this kind of variable. */
function validValue(kind: "color" | "length" | "font" | undefined, v: string): boolean {
  if (!v.trim() || /[;{}<>\\]/.test(v) || /url\s*\(/i.test(v)) return false;
  if (kind === "length") return CSS.supports("border-radius", v);
  if (kind === "font") return CSS.supports("font-family", v);
  return CSS.supports("color", v);
}

const OPEN_GROUPS = new Set(["Surfaces", "Text", "Controls", "Accent and status"]);

function ThemeEditor({ editing, takenIds, restore, onCancel, onSaved }: {
  editing: Editing;
  takenIds: string[];
  /** The saved theme to put back if the edit is cancelled. */
  restore: Theme;
  onCancel(): void;
  onSaved(t: Theme): void;
}) {
  const [draft, setDraft] = useState<Theme>(editing.draft);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState("colors");
  const [open, setOpen] = useState<Set<string>>(() => new Set(OPEN_GROUPS));
  const savedRef = useRef(false);
  const top = useRef<HTMLDivElement>(null);
  const isNew = editing.editId === null;

  const dirty = JSON.stringify(draft) !== editing.initial || isNew;
  const css = draft.css ?? "";
  const sanitized = useMemo(() => {
    try {
      return { ...sanitizeCss(css), error: null as string | null };
    } catch (e) {
      return { css: "", removed: [] as string[], error: (e as Error).message };
    }
  }, [css]);

  const bad = useMemo(() => {
    const out: string[] = [];
    for (const g of THEME_GROUPS) for (const v of g.vars) if (!validValue(v.kind, draft.vars[v.name] ?? "")) out.push(v.label);
    return out;
  }, [draft.vars]);
  const tooBig = css.length > MAX_THEME_CSS;
  const nameOk = draft.name.trim().length > 0;
  const canSave = nameOk && !bad.length && !tooBig && !sanitized.error && !saving;

  // Live preview on the whole page; put the saved theme back when leaving without saving.
  useEffect(() => {
    setPreviewing(true);
    return () => {
      setPreviewing(false);
      if (!savedRef.current) applyTheme(restore);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const valid: Record<string, string> = {};
    for (const [k, v] of Object.entries(draft.vars)) {
      const spec = THEME_GROUPS.flatMap((g) => g.vars).find((x) => x.name === k);
      valid[k] = !spec || validValue(spec.kind, v) ? v : (editing.draft.vars[k] ?? v);
    }
    applyTheme({ ...draft, id: draft.id || "draft", vars: valid, css: sanitized.css }, { persist: false });
  }, [draft, sanitized.css, editing.draft.vars]);

  useEffect(() => {
    top.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const save = useCallback(async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const id = isNew ? freeThemeId(draft.name, takenIds) : editing.editId!;
      const r = await api.saveTheme({ ...draft, id, name: draft.name.trim() });
      await api.selectTheme(id);
      savedRef.current = true;
      setPreviewing(false);
      applyTheme(r.theme);
      if (r.removed.length) toast.warning(`Saved without ${r.removed.length} remote reference${r.removed.length === 1 ? "" : "s"}`, { description: r.removed.slice(0, 3).join("\n") });
      else toast.success(isNew ? `Made “${r.theme.name}” and switched to it` : `Saved “${r.theme.name}”`);
      onSaved(r.theme);
    } catch (e) {
      toast.error("Couldn't save the theme", { description: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }, [canSave, draft, isNew, editing.editId, takenIds, onSaved]);

  // Ctrl+S saves the theme, not the rest of the settings page.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopImmediatePropagation();
        save();
      }
    };
    window.addEventListener("keydown", h, { capture: true });
    return () => window.removeEventListener("keydown", h, { capture: true });
  }, [save]);

  const setVar = (name: string, value: string) => setDraft((d) => ({ ...d, vars: { ...d.vars, [name]: value } }));
  const base = BUILTIN_THEMES.find((t) => t.id === draft.base);

  return (
    <div ref={top} className="scroll-mt-24">
      <Block>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <label htmlFor="theme-name" className="text-xs font-medium text-muted-foreground">{isNew ? "New theme" : "Editing"}</label>
            <Input id="theme-name" value={draft.name} maxLength={60} aria-invalid={!nameOk} className="h-10 text-base font-medium md:h-9" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Color scheme</span>
            <ToggleGroup type="single" variant="outline" value={draft.scheme} onValueChange={(v) => v && setDraft({ ...draft, scheme: v as Theme["scheme"] })}>
              <ToggleGroupItem value="dark" className="h-10 px-4 md:h-9">Dark</ToggleGroupItem>
              <ToggleGroupItem value="light" className="h-10 px-4 md:h-9">Light</ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {base ? <>Based on {base.name}. </> : null}The whole page shows your changes as you make them. The scheme sets how the browser draws scrollbars and form controls.
        </p>
      </Block>

      <Block className="pb-6">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <Tabs value={tab} onValueChange={setTab} className="min-w-0">
            <TabsList className="w-full">
              <TabsTrigger value="colors" className="h-9 flex-1">Variables</TabsTrigger>
              <TabsTrigger value="css" className="h-9 flex-1">CSS{css.trim() ? <span className="ml-1 size-1.5 rounded-full bg-highlight" /> : null}</TabsTrigger>
              <TabsTrigger value="preview" className="h-9 flex-1 lg:hidden">Preview</TabsTrigger>
            </TabsList>

            <TabsContent value="colors" className="mt-4 flex flex-col gap-2">
              {THEME_GROUPS.map((g) => {
                const isOpen = open.has(g.title);
                return (
                  <div key={g.title} className="rounded-lg border">
                    <button
                      type="button"
                      className="flex min-h-11 w-full items-center gap-3 px-3.5 text-left text-sm font-medium"
                      aria-expanded={isOpen}
                      onClick={() => setOpen((s) => {
                        const n = new Set(s);
                        if (n.has(g.title)) n.delete(g.title);
                        else n.add(g.title);
                        return n;
                      })}
                    >
                      <span className="flex-1">{g.title}</span>
                      {!isOpen && (
                        <span className="flex -space-x-1" aria-hidden="true">
                          {g.vars.filter((v) => !v.kind).slice(0, 6).map((v) => <span key={v.name} className="size-3 rounded-full border border-black/15" style={{ background: draft.vars[v.name] }} />)}
                        </span>
                      )}
                      <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", isOpen && "rotate-180")} />
                    </button>
                    {isOpen && (
                      <div className="grid gap-x-5 gap-y-3 border-t px-3.5 py-3.5 sm:grid-cols-2 lg:grid-cols-1 2xl:grid-cols-2">
                        {g.vars.map((v) => (
                          <VarRow
                            key={v.name}
                            name={v.name}
                            label={v.label}
                            kind={v.kind}
                            value={draft.vars[v.name] ?? ""}
                            original={editing.draft.vars[v.name]}
                            onChange={(val) => setVar(v.name, val)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </TabsContent>

            <TabsContent value="css" className="mt-4 flex flex-col gap-2">
              <CodeEditor
                lang="css"
                value={css}
                minHeight={240}
                placeholder={"/* Rules for the app around the cards. Theme variables work here. */\n.prose-etude { font-size: 1.05rem; }"}
                onChange={(v) => setDraft({ ...draft, css: v })}
              />
              <div className="flex flex-wrap items-start gap-x-4 gap-y-1 text-xs">
                <p className="min-w-0 flex-1 leading-relaxed text-muted-foreground">
                  Applies to the app, not inside cards (cards get the variables). <code className="font-mono">@import</code> and <code className="font-mono">url()</code> pointing at other sites are removed; <code className="font-mono">data:</code> URLs are fine.
                </p>
                <span className={cn("tabular shrink-0", tooBig ? "text-destructive" : "text-muted-foreground")}>
                  {css.length.toLocaleString()} / {MAX_THEME_CSS.toLocaleString()}
                </span>
              </div>
              {sanitized.error && <p className="text-xs text-destructive">{sanitized.error}</p>}
              {sanitized.removed.length > 0 && (
                <div className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs">
                  <div className="text-warning">Will be removed when saved:</div>
                  <ul className="mt-1 flex flex-col gap-0.5 font-mono text-[12px] text-foreground/80">
                    {sanitized.removed.map((r, i) => <li key={i} className="[overflow-wrap:anywhere]">{r}</li>)}
                  </ul>
                </div>
              )}
            </TabsContent>

            <TabsContent value="preview" className="mt-4 lg:hidden">
              <ThemeSample />
            </TabsContent>
          </Tabs>

          <div className="hidden lg:block">
            <div className="sticky top-20 flex flex-col gap-2 pb-16">
              <div className="text-xs font-medium text-muted-foreground">Preview</div>
              <ThemeSample />
            </div>
          </div>
        </div>
      </Block>

      <div className="sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] z-10 flex flex-wrap items-center gap-2 rounded-b-xl border-t bg-background/95 px-4 py-3 backdrop-blur sm:px-5 md:bottom-0">
        <span className="min-w-0 flex-1 truncate text-sm">
          {!nameOk ? <span className="text-destructive">Give it a name</span>
            : bad.length ? <span className="text-destructive">Fix {bad.length === 1 ? bad[0] : `${bad.length} values`}</span>
            : tooBig ? <span className="text-destructive">CSS is too long</span>
            : dirty ? <span className="text-muted-foreground">{isNew ? "Not saved yet" : "Unsaved changes"}</span>
            : <span className="text-muted-foreground">No changes</span>}
        </span>
        <Button variant="ghost" size="sm" className="h-10 gap-1.5 md:h-8" onClick={onCancel}>
          <RotateCcw className="size-4" />Cancel
        </Button>
        <Button size="sm" className="h-10 gap-1.5 md:h-8" onClick={save} disabled={!canSave || (!dirty && !isNew)}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}{isNew ? "Save and use" : "Save"} <kbd className="hidden text-[10px] opacity-60 sm:inline">Ctrl S</kbd>
        </Button>
      </div>
    </div>
  );
}

function VarRow({ name, label, kind, value, original, onChange }: {
  name: string;
  label: string;
  kind?: "color" | "length" | "font";
  value: string;
  original?: string;
  onChange(v: string): void;
}) {
  const valid = validValue(kind, value);
  const hex = useMemo(() => (kind ? null : toHex(value)), [kind, value]);
  const changed = original !== undefined && original !== value;
  return (
    <div className="flex min-w-0 items-center gap-3">
      {kind ? (
        <div className="flex size-10 shrink-0 items-center justify-center rounded-md border text-[11px] text-muted-foreground" aria-hidden="true">
          {kind === "length" ? <span className="size-5 border-t-2 border-l-2 border-foreground/70" style={{ borderTopLeftRadius: valid ? value : 0 }} /> : <span style={{ fontFamily: valid ? value : undefined }} className="text-base text-foreground">Aa</span>}
        </div>
      ) : (
        <label className="relative size-10 shrink-0 cursor-pointer overflow-hidden rounded-md ring-1 ring-foreground/20" title={`Pick ${label.toLowerCase()}`} style={{ background: "repeating-conic-gradient(#8884 0 25%, transparent 0 50%) 50% / 10px 10px" }}>
          <span className="absolute inset-0 rounded-md" style={{ background: valid ? value : "transparent" }} />
          <input
            type="color"
            aria-label={`${label} color`}
            className="absolute inset-0 size-full cursor-pointer opacity-0"
            value={hex ? hex.slice(0, 7) : "#000000"}
            onChange={(e) => onChange(e.target.value + (hex && hex.length === 9 ? hex.slice(7) : ""))}
          />
        </label>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-baseline gap-2 text-xs">
          <span className="truncate font-medium text-foreground/90">{label}</span>
          <code className="hidden truncate font-mono text-[11px] text-muted-foreground sm:inline">{name}</code>
          {changed && (
            <button type="button" className="ml-auto shrink-0 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => onChange(original!)}>
              reset
            </button>
          )}
        </div>
        <Input
          value={value}
          spellCheck={false}
          autoComplete="off"
          aria-label={`${label} value`}
          aria-invalid={!valid}
          className="h-9 font-mono text-[13px] md:text-[13px]"
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </div>
  );
}
