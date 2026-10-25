import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { BulkBar, CheckBox, groupItems, ItemEditor, ItemRow, NewItemDialog, OrderSelect, SearchHints } from "@/components/item-editor";
import { api, type SearchRow, type TypeSummary } from "@/lib/api";
import { cn } from "@/lib/utils";

const PAGE = 200;

export function BrowsePage({ initialQuery, openItem }: { initialQuery: string; openItem: string | null }) {
  const [query, setQuery] = useState(initialQuery);
  const [order, setOrder] = useState("added");
  const [rows, setRows] = useState<SearchRow[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(openItem);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [decks, setDecks] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [types, setTypes] = useState<TypeSummary[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);

  const run = useCallback(async (q = query) => {
    try {
      const r = await api.search(q, { limit: PAGE, order });
      setRows(r.rows);
      setTotal(r.total);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [query, order]);

  useEffect(() => {
    const t = setTimeout(() => run(query), 180);
    return () => clearTimeout(t);
  }, [query, order]);

  useEffect(() => {
    const p = new URLSearchParams();
    if (query) p.set("q", query);
    if (selected) p.set("item", selected);
    const url = `/browse${p.toString() ? `?${p}` : ""}`;
    if (location.pathname + location.search !== url) history.replaceState(null, "", url);
  }, [query, selected]);

  const reloadMeta = () => {
    api.decks().then((d) => setDecks(d.map((x) => x.name)));
    api.tags().then((t) => setTags(t.map((x) => x.tag)));
    api.types().then(setTypes);
  };
  useEffect(reloadMeta, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const items = useMemo(() => groupItems(rows), [rows]);

  const allChecked = items.length > 0 && items.every((r) => checked.has(r.itemId));

  return (
    <div className="flex h-[calc(100dvh-4rem-env(safe-area-inset-bottom))] min-w-0 md:h-dvh">
      <section className={cn("min-w-0 flex-col border-r md:flex md:w-[20rem] md:shrink-0 lg:w-[24rem] xl:w-[28rem]", selected ? "hidden" : "flex w-full")}>
        <div className="flex flex-col gap-2 border-b p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder='deck:"Networks" tag:exam::core is:due' className="pl-8 font-mono text-[13px]" />
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <CheckBox checked={allChecked} label="Select all" onClick={() => setChecked(allChecked ? new Set() : new Set(items.map((r) => r.itemId)))} />
            <span className="tabular">{error ? <span className="text-destructive">{error}</span> : `${total} card${total === 1 ? "" : "s"}${total > PAGE ? `, showing ${PAGE}` : ""}`}</span>
            <div className="flex-1" />
            <OrderSelect value={order} onChange={setOrder} />
            <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" onClick={() => setCreating(true)}><Plus className="size-3.5" />Add</Button>
          </div>
          <SearchHints onPick={(s) => setQuery((q) => (q ? `${q} ${s}` : s))} />
        </div>

        <BulkBar
          checked={checked}
          rows={rows}
          decks={decks}
          tags={tags}
          onClear={() => setChecked(new Set())}
          onDone={() => { run(); reloadMeta(); }}
          onDeleted={(ids) => { if (selected && ids.includes(selected)) setSelected(null); }}
        />

        <div className="min-h-0 flex-1 overflow-y-auto">
          {items.map((r) => (
            <ItemRow
              key={r.itemId}
              row={r}
              active={selected === r.itemId}
              checked={checked.has(r.itemId)}
              onOpen={() => setSelected(r.itemId)}
              onToggle={() => {
                const n = new Set(checked);
                n.has(r.itemId) ? n.delete(r.itemId) : n.add(r.itemId);
                setChecked(n);
              }}
            />
          ))}
          {!items.length && !error && <div className="p-8 text-center text-sm text-muted-foreground">No cards match.</div>}
        </div>
      </section>

      <section className={cn("min-w-0 flex-1 overflow-y-auto", selected ? "block" : "hidden md:block")}>
        {selected ? (
          <ItemEditor
            key={selected}
            id={selected}
            onBack={() => setSelected(null)}
            decks={decks}
            tags={tags}
            onSaved={() => { run(); reloadMeta(); }}
            onDeleted={() => { setSelected(null); run(); reloadMeta(); }}
            onDuplicate={(newId) => { setSelected(newId); run(); }}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-10 text-center text-sm text-muted-foreground">
            <span>Pick a card to inspect and edit it.</span>
            <span className="text-xs"><kbd>Ctrl K</kbd> to search</span>
          </div>
        )}
      </section>

      <NewItemDialog open={creating} onOpenChange={setCreating} decks={decks} types={types} onCreated={(id) => { setSelected(id); run(); reloadMeta(); }} />
    </div>
  );
}
