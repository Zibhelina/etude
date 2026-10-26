import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { createApp } from "../src/server/app.ts";
import { run } from "../src/cli/run.ts";

const dirs: string[] = [];
process.on("exit", () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function setup(t: TestContext) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-bury-"));
  dirs.push(dir);
  const e = await Etude.open(join(dir, "etude.db"));
  t.after(() => e.close());
  e.saveType({
    id: "two-way",
    name: "Two-way",
    faces: ["forward", "reverse"],
    fields: [{ name: "front", kind: "markdown", required: true }, { name: "back", kind: "markdown", required: true, private: true }],
    template: { html: "<div>{{md:front}}</div>", css: "", js: "" },
    grader: { kind: "self" },
  });
  e.upsertItem({ id: "w.hund", type: "two-way", deck: "German", fields: { front: "der Hund", back: "the dog" } });
  e.upsertItem({ id: "w.katze", type: "two-way", deck: "German", fields: { front: "die Katze", back: "the cat" } });
  const app = createApp(e, { webDist: null });
  const post = async (body: unknown) => {
    const response = await app.request("/api/cards-bulk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return response.json() as Promise<{ ok: boolean; count: number; cardIds: number[] }>;
  };
  const cards = (item: string) => e.db.all<{ id: number; buried_until: string | null }>("SELECT id, buried_until FROM cards WHERE item_id = ? ORDER BY id", item);
  return { e, post, cards };
}

test("burying a card hides only that card until the next study day without reviewing it", async (t) => {
  const { e, post, cards } = await setup(t);
  const [fwd, rev] = cards("w.hund");
  const before = e.db.get("SELECT * FROM cards WHERE id = ?", fwd.id)!;
  const r = await post({ action: "bury", cardIds: [fwd.id] });
  assert.equal(r.count, 1);
  assert.deepEqual(r.cardIds, [fwd.id]);
  const after = cards("w.hund");
  assert.equal(after[0].buried_until, new Date(e.dayStart().getTime() + 86400_000).toISOString());
  assert.equal(after[1].buried_until, null);
  assert.notEqual(e.next({ deck: "German" }).card?.cardId, fwd.id);
  assert.equal(e.counts({ deck: "German" }).new, 3);
  assert.equal(rev.buried_until, null);
  const afterSchedule = e.db.get("SELECT * FROM cards WHERE id = ?", fwd.id)!;
  assert.deepEqual({ ...afterSchedule, buried_until: before.buried_until }, { ...before });
  assert.equal(e.db.get("SELECT COUNT(*) AS n FROM reviews")!.n, 0);
});

test("burying a note hides every card of the item, and unbury brings them back", async (t) => {
  const { e, post, cards } = await setup(t);
  const [fwd, rev] = cards("w.hund");
  const r = await post({ action: "bury-note", cardIds: [fwd.id] });
  assert.equal(r.count, 2);
  assert.deepEqual(r.cardIds, [fwd.id, rev.id]);
  assert.ok(cards("w.hund").every((c) => c.buried_until));
  assert.ok(cards("w.katze").every((c) => !c.buried_until), "other items are untouched");
  assert.deepEqual(e.queue({ deck: "German" }).news.map((c) => c.id), cards("w.katze").map((c) => c.id));
  await post({ action: "unbury", cardIds: r.cardIds });
  assert.ok(cards("w.hund").every((c) => !c.buried_until));
  assert.equal(e.counts({ deck: "German" }).new, 4);
});

test("burying and undo preserve a sibling's existing burial", async (t) => {
  const { e, post, cards } = await setup(t);
  const [fwd, rev] = cards("w.hund");
  const until = new Date(Date.now() + 3 * 86400_000);
  e.setBuried([rev.id], until);
  const r = await post({ action: "bury-note", cardIds: [fwd.id, rev.id, fwd.id] });
  assert.deepEqual(r.cardIds, [fwd.id]);
  assert.equal(cards("w.hund")[1].buried_until, until.toISOString());
  assert.deepEqual((await post({ action: "bury-note", cardIds: [fwd.id] })).cardIds, []);
  await post({ action: "unbury", cardIds: r.cardIds });
  assert.equal(cards("w.hund")[0].buried_until, null);
  assert.equal(cards("w.hund")[1].buried_until, until.toISOString());
});

test("expired burials re-enter the study queue and can be buried again", async (t) => {
  const { e, post, cards } = await setup(t);
  const [fwd] = cards("w.hund");
  e.setBuried([fwd.id], new Date(Date.now() - 1000));
  assert.equal(e.counts({ deck: "German" }).new, 4);
  assert.deepEqual((await post({ action: "bury", cardIds: [fwd.id] })).cardIds, [fwd.id]);
  assert.equal(e.counts({ deck: "German" }).new, 3);
  assert.deepEqual((await post({ action: "bury-note", cardIds: [] })).cardIds, []);
});

test("suspending a card (@) leaves its sibling; suspending the note (!) takes every card of the item", async (t) => {
  const { e, post, cards } = await setup(t);
  const [fwd, rev] = cards("w.hund");
  const suspended = (item: string) => e.db.all<{ suspended: number }>("SELECT suspended FROM cards WHERE item_id = ? ORDER BY id", item).map((c) => c.suspended);
  assert.deepEqual((await post({ action: "suspend", cardIds: [fwd.id] })).cardIds, [fwd.id]);
  assert.deepEqual(suspended("w.hund"), [1, 0]);
  assert.equal(e.counts({ deck: "German" }).new, 3);
  await post({ action: "unsuspend", cardIds: [fwd.id] });
  const r = await post({ action: "suspend-note", cardIds: [rev.id] });
  assert.deepEqual(r.cardIds, [fwd.id, rev.id]);
  assert.deepEqual(suspended("w.hund"), [1, 1]);
  assert.deepEqual(suspended("w.katze"), [0, 0], "other items are untouched");
  assert.equal(e.db.get("SELECT COUNT(*) AS n FROM reviews")!.n, 0);
  await post({ action: "unsuspend", cardIds: r.cardIds });
  assert.equal(e.counts({ deck: "German" }).new, 4);
});

test("undoing a note suspension keeps a sibling that was already suspended", async (t) => {
  const { e, post, cards } = await setup(t);
  const [fwd, rev] = cards("w.hund");
  e.setSuspended([rev.id], true);
  const r = await post({ action: "suspend-note", cardIds: [fwd.id, fwd.id] });
  assert.deepEqual(r.cardIds, [fwd.id]);
  assert.deepEqual((await post({ action: "suspend-note", cardIds: [fwd.id] })).cardIds, []);
  await post({ action: "unsuspend", cardIds: r.cardIds });
  assert.deepEqual(e.db.all<{ suspended: number }>("SELECT suspended FROM cards WHERE item_id = 'w.hund' ORDER BY id").map((c) => c.suspended), [0, 1]);
});

test("CLI: card suspend --note takes the selected cards' items", async (t) => {
  const { e, cards } = await setup(t);
  const [fwd] = cards("w.hund");
  let out = "";
  const code = await run(["--db", e.path, "card", "suspend", String(fwd.id), "--note"], { stdout: (s) => (out += s), stderr: () => {}, stdin: () => "", isTTY: false, env: {} });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out).cards.map((c: { suspended: boolean }) => c.suspended), [true, true]);
});
