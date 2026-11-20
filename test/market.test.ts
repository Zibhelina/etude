import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { buildIndex, buildSubmission, checkEntry, entryJson, entryPath, fetchIndex, installEntry, installFile, installState, installedEntries, metaOf, packItemIds, publishFile, type MarketFile } from "../src/core/market.ts";
import { syncFor } from "../src/core/sync/client.ts";
import { drain } from "../src/core/sync/log.ts";
import { project } from "../src/core/sync/project.ts";

const dir = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-market-"));
const SHOWCASE = JSON.parse(readFileSync(new URL("../examples/showcase.pack.json", import.meta.url), "utf8"));

async function source() {
  const e = await Etude.open(":memory:");
  e.saveTheme({ id: "sea", name: "Sea", scheme: "dark", vars: { "--highlight": "oklch(0.7 0.13 200)" } });
  e.importPack(SHOWCASE);
  return e;
}

/** Writes entries into a market folder and indexes it, like the repository's CI. */
async function market(files: MarketFile[]) {
  const root = dir();
  for (const f of files) {
    mkdirSync(join(root, "entries", `${f.kind}s`), { recursive: true });
    writeFileSync(join(root, entryPath(f.kind, f.id)), entryJson(f));
  }
  const { index, problems } = await buildIndex(root, { dryRunInto: () => Etude.open(":memory:") });
  assert.deepEqual(problems, []);
  writeFileSync(join(root, "index.json"), JSON.stringify(index));
  return root;
}

test("submissions: themes, decks and types become valid entries", async () => {
  const e = await source();
  const theme = buildSubmission(e, { kind: "theme", ref: "sea", author: "ana", tags: ["Dark"] });
  assert.equal(theme.id, "sea");
  assert.deepEqual(theme.tags, ["dark"]);
  assert.deepEqual(checkEntry(theme), []);

  const deck = buildSubmission(e, { kind: "deck", ref: "Etude Showcase", author: "ana" });
  assert.equal(deck.content.etude, "pack/1");
  assert.equal(deck.content.items.length, SHOWCASE.items.length);
  assert.ok(deck.content.types.length > 0, "custom types the deck uses come along");
  assert.equal(JSON.stringify(deck).includes('"reviews"'), false);

  const type = buildSubmission(e, { kind: "type", ref: "chess", author: "ana", examples: 1 });
  assert.equal(type.content.types[0].id, "chess");
  assert.equal(type.content.items.length, 1);
  assert.equal(type.content.types[0].updated, undefined);

  assert.throws(() => buildSubmission(e, { kind: "theme", ref: "midnight" }), /ships with Etude/);
  assert.throws(() => buildSubmission(e, { kind: "type", ref: "numeric" }), /ships with Etude/);
});

test("checkEntry rejects bad files", () => {
  assert.match(checkEntry({}).join(), /etudeMarket/);
  const bad = { etudeMarket: 1, kind: "deck", id: "X Y", name: "", author: "a", content: { etude: "pack/1", items: [] } };
  const errs = checkEntry(bad).join("; ");
  assert.match(errs, /id must be/);
  assert.match(errs, /name is required/);
  assert.match(errs, /at least one item/);
  const remote = { etudeMarket: 1, kind: "theme", id: "t", name: "T", author: "a", content: { id: "t", name: "T", vars: {}, css: "@import url(https://evil.example/x.css);" } };
  assert.match(checkEntry(remote).join(), /remote references/);
});

test("install from a market folder, reinstall, update detection", async () => {
  const src = await source();
  const theme = buildSubmission(src, { kind: "theme", ref: "sea", author: "ana" });
  const deck = buildSubmission(src, { kind: "deck", ref: "Etude Showcase", id: "showcase", author: "ana" });
  const type = buildSubmission(src, { kind: "type", ref: "chess", id: "chess-move", author: "ana" });
  const url = await market([theme, deck, type]);
  const index = await fetchIndex(url, { refresh: true });
  assert.equal(index.entries.length, 3);

  const e = await Etude.open(":memory:");
  // A theme with the same id already exists here: the installed one gets a fresh id.
  e.saveTheme({ id: "sea", name: "My own sea", scheme: "light", vars: {} });
  const t = await installEntry(e, "sea", { url });
  assert.equal(t.result, "created");
  assert.equal(t.ids[0], "sea-2");
  assert.equal(e.theme("sea").name, "My own sea");
  const t2 = await installEntry(e, "sea", { url });
  assert.equal(t2.result, "unchanged");
  assert.equal(t2.ids[0], "sea-2", "an update keeps the id it got the first time");

  const dry = await installEntry(e, "showcase", { url, dryRun: true });
  assert.equal((dry.report as any).items.created, SHOWCASE.items.length);
  assert.ok(!e.deckTree().some((d) => d.name === "Etude Showcase"), "dry run writes nothing");
  assert.equal(installedEntries(e).showcase, undefined);

  const d = await installEntry(e, "showcase", { url });
  assert.equal(d.result, "created");
  assert.deepEqual(d.ids, ["Etude Showcase"]);
  assert.equal(e.watchList({ deck: "Etude Showcase" }).length, SHOWCASE.items.length);
  const again = await installEntry(e, "showcase", { url });
  assert.equal(again.result, "unchanged");
  assert.equal((again.report as any).items.unchanged, SHOWCASE.items.length);

  await installEntry(e, "chess-move", { url });
  assert.equal(e.type("chess").name, type.content.types[0].name);

  const entry = index.entries.find((x) => x.id === "showcase")!;
  assert.equal(installState(e, entry), "installed");
  assert.equal(installState(e, { ...entry, version: "2" }), "update");
});

test("installFile refuses invalid entries and the index flags them", async () => {
  const e = await Etude.open(":memory:");
  assert.throws(() => installFile(e, { etudeMarket: 1, kind: "type", id: "zz", name: "Z", author: "a", content: { etude: "pack/1", types: [{ id: "BAD" }] } } as any), /invalid market entry/);
  const root = dir();
  mkdirSync(join(root, "entries", "decks"), { recursive: true });
  writeFileSync(join(root, "entries", "decks", "wrong-name.json"), JSON.stringify({ etudeMarket: 1, kind: "deck", id: "other", name: "D", author: "a", content: { etude: "pack/1", items: [{ id: "x", type: "nope", deck: "D", fields: {} }] } }));
  const { problems } = await buildIndex(root, { dryRunInto: () => Etude.open(":memory:") });
  const errs = problems[0].errors.join("; ");
  assert.match(errs, /named other\.json/);
});

test("publish opens a pull request through a fork when you can't push", async () => {
  const src = await source();
  const file = buildSubmission(src, { kind: "theme", ref: "sea", author: "ana" });
  const calls: { args: string[]; input?: any }[] = [];
  const gh = (args: string[], input?: any) => {
    calls.push({ args, input });
    const path = args.find((a) => a.startsWith("repos/") || a === "user") ?? "";
    if (path === "user") return { login: "ana" };
    if (path === "repos/Zibhelina/etude-market") return { default_branch: "main", permissions: { push: false } };
    if (path.endsWith("/git/ref/heads/main")) return { object: { sha: "abc123" } };
    if (path.includes("/contents/") && !args.includes("PUT")) throw new Error("404");
    if (path.endsWith("/pulls")) return { html_url: "https://github.com/Zibhelina/etude-market/pull/7", number: 7 };
    return {};
  };
  const r = publishFile(file, { gh });
  assert.equal(r.number, 7);
  assert.equal(r.fork, "ana/etude-market");
  const put = calls.find((c) => c.args.includes("PUT"))!;
  assert.ok(put.args.includes("repos/ana/etude-market/contents/entries/themes/sea.json"));
  assert.deepEqual(JSON.parse(Buffer.from(put.input.content, "base64").toString()), JSON.parse(entryJson(file)));
  const pr = calls.find((c) => c.args.at(-2) === "repos/Zibhelina/etude-market/pulls" || c.args.includes("repos/Zibhelina/etude-market/pulls"))!;
  assert.match(pr.input.head, /^ana:theme-sea-/);
  assert.equal(pr.input.base, "main");
});

/** A deck entry with two subdecks, as the Market serves it. */
const deckEntry = (version: string, items: any[]): MarketFile => ({
  etudeMarket: 1,
  kind: "deck",
  id: "pharm",
  name: "Pharm",
  description: "",
  author: "ana",
  tags: [],
  version,
  updated: "",
  content: { etude: "pack/1", decks: [{ name: "Pharm" }, { name: "Pharm::Renal" }], items },
});
const P1 = { id: "p1", type: "basic", deck: "Pharm", fields: { front: "ACE inhibitor ending", back: "-pril" } };
const P2 = { id: "p2", type: "basic", deck: "Pharm::Renal", fields: { front: "Loop diuretic", back: "furosemide" } };
const itemIds = (e: Etude) => e.db.all("SELECT id FROM items ORDER BY id").map((r) => r.id as string);

test("with no tombstones a deck installs under the pack's ids: no Sync, or Sync with nothing deleted", async () => {
  const v1 = deckEntry("1", [P1, P2]);
  const e = await Etude.open(":memory:");
  const out = installFile(e, v1);
  assert.equal(out.remap, undefined);
  assert.deepEqual(itemIds(e), ["p1", "p2"]);
  assert.equal("remap" in installedEntries(e).pharm, false);
  assert.deepEqual(packItemIds(e, v1.content.items), {});
  // Without Sync a deleted deck still reads as installed, and installing it again uses the same ids.
  e.deleteDeck("Pharm", { items: true });
  assert.equal(installState(e, metaOf(v1)), "installed");
  const again = installFile(e, v1);
  assert.equal(again.result, "updated");
  assert.equal(again.remap, undefined);
  assert.deepEqual(itemIds(e), ["p1", "p2"]);

  const root = dir();
  const s = await Etude.open(join(root, "s.db"), { home: join(root, "home") });
  try {
    syncFor(s).setup({ folder: join(root, "shared") });
    assert.equal(installFile(s, v1).remap, undefined);
    drain(s.db);
    const twice = installFile(s, v1);
    assert.equal(twice.result, "unchanged");
    assert.equal(twice.remap, undefined);
    assert.deepEqual(itemIds(s), ["p1", "p2"]);
    assert.equal(installState(s, metaOf(v1)), "installed");
  } finally {
    s.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a deck deleted on a synced collection installs again under fresh ids, even before the delete was synced", async () => {
  const root = dir();
  const e = await Etude.open(join(root, "a.db"), { home: join(root, "home") });
  try {
    syncFor(e).setup({ folder: join(root, "shared") });
    const v1 = deckEntry("1", [P1, P2]);
    installFile(e, v1);
    drain(e.db);
    const faces = e.db.all("SELECT face FROM cards WHERE item_id = 'p1' ORDER BY face").map((r) => r.face as string);
    assert.ok(faces.length > 0);
    e.deleteDeck("Pharm", { items: true });
    // The delete only waits in the outbox, and already counts.
    assert.equal(installState(e, metaOf(v1)), null);
    const r = installFile(e, v1);
    assert.equal(r.result, "created", "a deck Sync took away is installed afresh");
    assert.deepEqual(r.remap, { p1: "p1.r1", p2: "p2.r1" });
    assert.deepEqual(installedEntries(e).pharm.remap, { p1: "p1.r1", p2: "p2.r1" });
    assert.deepEqual(itemIds(e), ["p1.r1", "p2.r1"]);
    assert.deepEqual(e.db.all("SELECT face FROM cards WHERE item_id = 'p1.r1' ORDER BY face").map((x) => x.face), faces, "cards follow the new id");
    // What the projection makes of the registers: the old ids stay deleted, the new ones show.
    drain(e.db);
    project(e);
    assert.deepEqual(itemIds(e), ["p1.r1", "p2.r1"]);
    assert.deepEqual(e.db.all("SELECT DISTINCT item_id FROM cards ORDER BY item_id").map((x) => x.item_id), ["p1.r1", "p2.r1"]);
    assert.equal(installState(e, metaOf(v1)), "installed");
    const again = installFile(e, v1);
    assert.deepEqual([again.remap, again.report.items.created], [{ p1: "p1.r1", p2: "p2.r1" }, 0]);
    assert.deepEqual(itemIds(e), ["p1.r1", "p2.r1"]);
  } finally {
    e.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the state a reinstall by an earlier version left: decks back but empty, the deleted ids written again; the deck reads as gone and comes back", async () => {
  const root = dir();
  const e = await Etude.open(join(root, "a.db"), { home: join(root, "home") });
  try {
    syncFor(e).setup({ folder: join(root, "shared") });
    const v1 = deckEntry("1", [P1, P2]);
    installFile(e, v1);
    e.deleteDeck("Pharm", { items: true });
    drain(e.db);
    // An earlier version imported the same ids again; the next sync hides them, and the decks stay, empty.
    e.importPack(v1.content);
    assert.equal(installState(e, metaOf(v1)), null, "items Sync deleted don't count, even before the projection hides them");
    drain(e.db);
    project(e);
    assert.deepEqual(itemIds(e), []);
    assert.deepEqual(e.db.all("SELECT name FROM decks WHERE name LIKE 'Pharm%' ORDER BY name").map((d) => d.name), ["Pharm", "Pharm::Renal"]);
    assert.equal(installState(e, metaOf(v1)), null);
    assert.deepEqual(installFile(e, v1).remap, { p1: "p1.r1", p2: "p2.r1" });
    drain(e.db);
    project(e);
    assert.deepEqual(itemIds(e), ["p1.r1", "p2.r1"]);
    assert.deepEqual(e.db.all("SELECT d.name FROM items i JOIN decks d ON d.id = i.deck_id ORDER BY i.id").map((d) => d.name), ["Pharm", "Pharm::Renal"]);
  } finally {
    e.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fresh ids: the first free one, never another pack item's, within the item id limit, and the record's earlier choice wins", async () => {
  const root = dir();
  const e = await Etude.open(join(root, "a.db"), { home: join(root, "home") });
  try {
    syncFor(e).setup({ folder: join(root, "shared") });
    const long = "x".repeat(200);
    const items = ["a", "a.r1", "b", "constructor", long].map((id) => ({ id, type: "basic", deck: "D", fields: { front: id.slice(0, 20), back: "?" } }));
    e.importPack({ etude: "pack/1", items: [...items, { id: "b.r1", type: "basic", deck: "D", fields: { front: "b.r1", back: "?" } }] });
    e.deleteItems(["a", "b", "b.r1", "constructor", long]);
    drain(e.db);
    // a.r1 is the pack's own item, and b.r1 was deleted too.
    assert.deepEqual(packItemIds(e, items), { a: "a.r2", b: "b.r2", constructor: "constructor.r1", [long]: "x".repeat(197) + ".r1" });
    // An earlier choice that's alive is kept; one that was deleted moves on.
    assert.deepEqual(packItemIds(e, items, { a: "a.r5", b: "b.r1" }).a, "a.r5");
    assert.equal(packItemIds(e, items, { a: "a.r5", b: "b.r1" }).b, "b.r2");
    assert.deepEqual(Object.keys(packItemIds(e, [{ id: "c" }, { id: "BAD id" }, {}, null])), []);
  } finally {
    e.close();
    rmSync(root, { recursive: true, force: true });
  }
});
