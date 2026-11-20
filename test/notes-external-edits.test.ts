import { test } from "node:test";
import assert from "node:assert/strict";
import { Etude } from "../src/core/engine.ts";
import { createApp } from "../src/server/app.ts";
import { docFromText } from "../src/core/notes.ts";
import { merge3, mergeDocs } from "../src/core/doc-merge.ts";

test("doc merge: each side's change survives, a clash keeps both", () => {
  const base = ["a", "b", "c"];
  assert.deepEqual(merge3(base, base, ["a", "b", "c", "T"]), { result: ["a", "b", "c", "T"], conflicts: 0 });
  assert.deepEqual(merge3(base, ["a", "B", "c"], ["a", "b", "c", "T"]), { result: ["a", "B", "c", "T"], conflicts: 0 });
  assert.deepEqual(merge3(base, ["M", "a", "b", "c"], ["a", "b", "c", "T"]), { result: ["M", "a", "b", "c", "T"], conflicts: 0 });
  assert.deepEqual(merge3(base, ["a", "c"], ["a", "b", "c", "T"]), { result: ["a", "c", "T"], conflicts: 0 });
  assert.deepEqual(merge3(base, ["a", "X", "c"], ["a", "Y", "c"]), { result: ["a", "X", "Y", "c"], conflicts: 1 });
  assert.deepEqual(merge3(base, ["a", "X", "c"], ["a", "X", "c"]), { result: ["a", "X", "c"], conflicts: 0 });
  assert.deepEqual(merge3([], ["m"], ["t"]), { result: ["m", "t"], conflicts: 1 });
  const p = (t: string) => ({ type: "paragraph", content: [{ type: "text", text: t }] });
  const d = (...xs: unknown[]) => ({ type: "doc" as const, content: xs });
  assert.deepEqual(mergeDocs(d(p("one")), d(p("one"), p("typed")), d(p("one"), p("table"))).doc, d(p("one"), p("typed"), p("table")));
});

test("notes: a body save with an old base is refused, so an open editor can merge", async (t) => {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  const app = createApp(e);
  const j = (method: string, path: string, body?: unknown) =>
    Promise.resolve(app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })).then(async (r: Response) => ({ status: r.status, body: await r.json() }));
  const n = e.notes.create({ title: "Journal", doc: docFromText("- [ ] Lab 2") });
  const opened = n.updated;
  assert.deepEqual((await j("GET", `/api/notes/${n.id}/stamp`)).body, { updated: opened });
  await new Promise((r) => setTimeout(r, 5));
  e.notes.update(n.id, { doc: docFromText("- [ ] Lab 2\n# Timeline") });
  const stale = await j("PATCH", `/api/notes/${n.id}`, { doc: docFromText("- [ ] Lab 2\nmine"), base: opened });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "changed");
  assert.match(e.notes.get(n.id).text, /Timeline/);
  const now = (await j("GET", `/api/notes/${n.id}/stamp`)).body.updated;
  assert.notEqual(now, opened);
  const ok = await j("PATCH", `/api/notes/${n.id}`, { doc: docFromText("- [ ] Lab 2\n# Timeline\nmine"), base: now });
  assert.equal(ok.status, 200);
  assert.match(ok.body.text, /Timeline\nmine/);
  // Look and icon changes, and saves without a base, go in as before.
  assert.equal((await j("PATCH", `/api/notes/${n.id}`, { icon: "📘", base: opened })).status, 200);
  assert.equal((await j("PATCH", `/api/notes/${n.id}`, { doc: docFromText("plain") })).status, 200);
});
