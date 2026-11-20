import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { createApp } from "../src/server/app.ts";
import { run } from "../src/cli/run.ts";
import { AGENT_DENY } from "../src/core/agent.ts";
import type { CardTypeDef } from "../src/core/model.ts";

const dirs: string[] = [];
process.on("exit", () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const twoWay: CardTypeDef = {
  id: "two-way",
  name: "Two-way",
  faces: ["forward", "reverse"],
  fields: [{ name: "front", kind: "markdown", required: true }, { name: "back", kind: "markdown", required: true, private: true }],
  template: { html: "<div>{{md:front}}</div>", css: "", js: "" },
  grader: { kind: "self" },
};

async function setup(t: TestContext) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-cleanup-"));
  dirs.push(dir);
  const e = await Etude.open(join(dir, "etude.db"));
  t.after(() => e.close());
  const cli = async (...args: string[]) => {
    let out = "";
    let err = "";
    const code = await run(["--db", e.path, ...args], { stdout: (s) => (out += s), stderr: (s) => (err += s), stdin: () => "", isTTY: false, env: { ETUDE_HOME: dir } });
    return { code, json: out ? JSON.parse(out) : null, err };
  };
  const app = createApp(e, { webDist: null });
  const http = async (path: string, init?: { method: string; body: unknown }) =>
    (await app.request(path, init && { method: init.method, headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) })).json() as Promise<any>;
  return { e, dir, cli, http };
}

const faces = (e: Etude, item: string) => e.db.all<{ face: string }>("SELECT face FROM cards WHERE item_id = ? ORDER BY face", item).map((c) => c.face);
const review = (e: Etude, item: string, face: string) => {
  const card = e.db.get<{ id: number }>("SELECT id FROM cards WHERE item_id = ? AND face = ?", item, face)!.id;
  e.db.run("INSERT INTO reviews (card_id, ts, rating, state, card_before, due_after) VALUES (?, ?, 3, 0, '{}', ?)", card, new Date().toISOString(), new Date().toISOString());
};

test("removing a face leaves its cards; saving reports them and pruning deletes them with their history", async (t) => {
  const { e } = await setup(t);
  e.saveType(twoWay);
  e.upsertItem({ id: "hund", type: "two-way", deck: "German", fields: { front: "der Hund", back: "the dog" } });
  e.upsertItem({ id: "katze", type: "two-way", deck: "German", fields: { front: "die Katze", back: "the cat" } });
  review(e, "hund", "reverse");
  review(e, "hund", "forward");

  const saved = e.saveTypeReport({ ...twoWay, faces: ["forward"] });
  assert.deepEqual(saved.leftover, { cards: 2, reviews: 1 });
  assert.deepEqual(faces(e, "hund"), ["forward", "reverse"], "saving never deletes cards");
  assert.equal(e.saveTypeReport({ ...twoWay, faces: ["forward"] }).leftover, null, "an unchanged type isn't rechecked");
  assert.deepEqual(e.leftoverReport(), { cards: 2, reviewed: 1, reviews: 1, faces: [{ type: "two-way", typeName: "Two-way", face: "reverse", cards: 2, reviews: 1 }] });

  assert.deepEqual(e.deleteLeftoverCards({ type: "two-way" }), { cards: 2, reviews: 1 });
  assert.deepEqual(faces(e, "hund"), ["forward"]);
  assert.deepEqual(faces(e, "katze"), ["forward"]);
  assert.equal(e.db.get("SELECT COUNT(*) AS n FROM reviews")!.n, 1, "only the forward card's review is left");
  assert.equal(e.leftoverReport().cards, 0);
});

test("facesWhen decides per item: a face name that means different things per layout is only a leftover where it's gone", async (t) => {
  const { e } = await setup(t);
  const vocab: CardTypeDef = {
    ...twoWay,
    id: "vocab",
    faces: ["t0", "t1", "t2", "t3"],
    fields: [...twoWay.fields, { name: "layout", kind: "text", default: "mrgp" }],
  };
  e.saveType(vocab);
  e.upsertItem({ id: "junge", type: "vocab", deck: "German", fields: { front: "der Junge", back: "boy", layout: "mrgp" } });
  e.upsertItem({ id: "ort", type: "vocab", deck: "German", fields: { front: "der Ort", back: "place", layout: "mrp" } });
  // mrgp: t2 is the gender card, dropped now; mrp: t2 is the plural card and there is no t3.
  const facesWhen = 'return fields.layout === "mrp" ? ["t0", "t1", "t2"] : ["t0", "t1", "t3"];';
  assert.deepEqual(e.saveTypeReport({ ...vocab, facesWhen }).leftover, { cards: 2, reviews: 0 });
  assert.deepEqual(e.leftoverCards().map((c) => `${c.itemId}/${c.face}`), ["junge/t2", "ort/t3"]);
  e.deleteLeftoverCards();
  assert.deepEqual(faces(e, "junge"), ["t0", "t1", "t3"]);
  assert.deepEqual(faces(e, "ort"), ["t0", "t1", "t2"]);
});

test("an item keeps every card when facesWhen fails for it or would leave it with none", async (t) => {
  const { e } = await setup(t);
  e.saveType(twoWay);
  for (const id of ["ok", "boom", "empty"]) e.upsertItem({ id, type: "two-way", deck: "D", fields: { front: id, back: id } });
  e.saveType({ ...twoWay, facesWhen: 'if (fields.front === "boom") throw new Error("no"); return fields.front === "empty" ? [] : ["forward"];' });
  assert.deepEqual(e.leftoverCards().map((c) => `${c.itemId}/${c.face}`), ["ok/reverse"]);
  // Archived items are left alone, as Browse and study leave them out; unarchiving brings the card back.
  e.setArchived(["ok"], true);
  assert.deepEqual(e.leftoverCards(), []);
  assert.equal(e.search("is:leftover is:archived").total, 0);
  e.setArchived(["ok"], false);
  assert.deepEqual(e.leftoverCards().map((c) => `${c.itemId}/${c.face}`), ["ok/reverse"]);
  // Another type's leftovers are untouched when pruning one type.
  e.saveType({ ...twoWay, id: "other" });
  e.upsertItem({ id: "o", type: "other", deck: "D", fields: { front: "o", back: "o" } });
  e.saveType({ ...twoWay, id: "other", faces: ["reverse"] });
  assert.deepEqual(e.deleteLeftoverCards({ type: "two-way" }), { cards: 1, reviews: 0 });
  assert.deepEqual(faces(e, "o"), ["forward", "reverse"]);
});

test("CLI and HTTP: type import reports leftovers, card prune previews and asks for --yes", async (t) => {
  const { e, dir, cli, http } = await setup(t);
  e.saveType(twoWay);
  e.upsertItem({ id: "hund", type: "two-way", deck: "German", fields: { front: "der Hund", back: "the dog" } });
  writeFileSync(join(dir, "type.json"), JSON.stringify({ ...twoWay, faces: ["forward"] }));
  assert.deepEqual((await cli("type", "import", join(dir, "type.json"))).json.leftover, { cards: 1, reviews: 0 });

  assert.equal((await cli("card", "prune")).code, 2);
  const dry = await cli("card", "prune", "--type", "two-way", "--dry-run");
  assert.equal(dry.json.cards, 1);
  assert.equal(dry.json.dryRun, true);
  assert.deepEqual(faces(e, "hund"), ["forward", "reverse"]);
  assert.equal((await cli("card", "prune", "--type", "nope", "--yes")).code, 3);

  assert.deepEqual((await http("/api/types/two-way", { method: "PUT", body: { ...twoWay, faces: ["reverse"] } })).leftover, { cards: 1, reviews: 0 });
  assert.equal((await http("/api/types/two-way/leftover")).cards, 1);
  assert.equal((await http("/api/cleanup")).leftover.cards, 1);
  assert.deepEqual(await http("/api/cleanup/cards", { method: "POST", body: { type: "two-way" } }), { cards: 1, reviews: 0 });
  assert.deepEqual(faces(e, "hund"), ["reverse"]);
});

test("unused media: only files nothing names, whatever the form of the reference", async (t) => {
  const { e, cli, http } = await setup(t);
  const old = new Date(Date.now() - 2 * 3600_000);
  const put = (rel: string, recent = false) => {
    const p = join(e.mediaDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "x".repeat(10));
    if (!recent) utimesSync(p, old, old);
  };
  const named = ["files/abc123.png", "anki/my file.mp3", "anki/Junge.mp3", "anki/flag.png", "anki/deck.png", "anki/sound.mp3", "anki/Bayern.png"];
  const unused = ["anki/Bayern (1).png", "anki/unused.mp3", "files/def456.png"];
  const kept = ["anki/_font.ttf", "anki/.hidden.png", "anki/noext", ".tmp/x.png"];
  for (const f of [...named, ...unused, ...kept]) put(f);
  put("anki/recent.mp3", true);

  e.saveType({ ...twoWay, template: { html: "<div>{{md:front}}</div>", css: ".flag { background: url(/media/anki/flag.png) }" } });
  e.upsertItem({ id: "a", type: "two-way", deck: "German", fields: { front: "![](/media/files/abc123.png) [sound:sound.mp3]", back: '<audio src="/media/anki/my%20file.mp3"></audio>' } });
  e.upsertItem({ id: "b", type: "basic", deck: "German", fields: { front: "Bayern", back: '<img src="/media/anki/Bayern.png">', extra: JSON.stringify({ audio: "/media/anki/Junge.mp3" }) } });
  e.updateDeck("German", { description: "![map](/media/anki/deck.png)" });

  assert.deepEqual(e.unusedMedia().map((f) => f.path), unused.slice().sort());
  assert.equal((await http("/api/cleanup")).media.count, 3);

  assert.equal((await cli("media", "prune")).code, 2);
  const dry = await cli("media", "prune", "--dry-run");
  assert.deepEqual([dry.json.count, dry.json.bytes, dry.json.dryRun], [3, 30, true]);
  assert.ok(unused.every((f) => existsSync(join(e.mediaDir, f))));

  assert.deepEqual((await cli("media", "prune", "--yes")).json.count, 3);
  assert.ok(unused.every((f) => !existsSync(join(e.mediaDir, f))));
  assert.ok([...named, ...kept, "anki/recent.mp3"].every((f) => existsSync(join(e.mediaDir, f))));
  assert.deepEqual(e.unusedMedia(), []);
  assert.ok(AGENT_DENY.includes("media prune"), "the assistant's undo can't bring files back");
});

test("unused media: a picture only a page on disk shows is kept, the trash included, and nothing goes while a folder is away", async (t) => {
  const { e, dir, cli } = await setup(t);
  const old = new Date(Date.now() - 2 * 3600_000);
  const put = (rel: string) => {
    const p = join(e.mediaDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "x".repeat(10));
    utimesSync(p, old, old);
  };
  const shown = ["files/page.png", "files/in trash.png", "files/hidden trash.webp", "files/notes.png", "files/web.png", "files/deep.pdf"];
  const unused = ["files/nobody.png", "files/in-node-modules.png"];
  for (const f of [...shown, ...unused]) put(f);

  const vault = join(dir, "Vault");
  const page = (doc: object) => JSON.stringify({ etude: 1, kind: "page", doc: { type: "doc", content: [doc] } }, null, 1);
  const files: Record<string, string> = {
    "Journal/Monday.etude": page({ type: "image", attrs: { src: "/media/files/page.png" } }),
    "trash/Old.etude": page({ type: "image", attrs: { src: "/media/files/in%20trash.png" } }),
    "Notes.md": "![](/media/files/notes.png)",
    "Site/index.html": '<img src="/media/files/web.png">',
    "a/b/c/d/Deep.etude": page({ type: "notePdf", attrs: { src: "/media/files/deep.pdf", name: "deep.pdf" } }),
    // dependencies are never pages
    "app/node_modules/pkg/README.md": "![](/media/files/in-node-modules.png)",
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(vault, rel)), { recursive: true });
    writeFileSync(join(vault, rel), text);
  }
  e.folders.open(vault, { trash: "trash" });
  // A second folder whose trash is a dot-name the Notebook doesn't show.
  const other = join(dir, "Other");
  mkdirSync(join(other, ".trash"), { recursive: true });
  writeFileSync(join(other, ".trash", "Gone.etude"), page({ type: "image", attrs: { src: "/media/files/hidden%20trash.webp" } }));
  e.folders.open(other);

  assert.deepEqual(e.unusedMedia().map((f) => f.path), unused.slice().sort());
  assert.equal((await cli("media", "prune", "--yes")).json.count, 2);
  assert.ok(shown.every((f) => existsSync(join(e.mediaDir, f))), "every picture a page shows is still there");

  // The page goes for good: its picture is unused now.
  rmSync(join(vault, "Journal/Monday.etude"));
  assert.deepEqual(e.unusedMedia().map((f) => f.path), ["files/page.png"]);

  // A folder that isn't there (a drive not plugged in) may hold pages that show anything: nothing counts as unused.
  rmSync(other, { recursive: true });
  assert.deepEqual(e.unusedMedia(), []);
  assert.equal((await cli("media", "prune", "--yes")).json.count, 0);
  assert.ok(existsSync(join(e.mediaDir, "files/page.png")));
});

test("unused media: a web file or template that names a folder of the media uses what's in it", async (t) => {
  const { e } = await setup(t);
  const old = new Date(Date.now() - 2 * 3600_000);
  const put = (rel: string) => {
    const p = join(e.mediaDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "x");
    utimesSync(p, old, old);
  };
  const lab = ["design-lab/site-01/img/bk.webp", "design-lab/site-01/img/wk.webp", "design-lab/site-01/img/deep/sub.png", "design lab 2/hero/a.png"];
  const other = ["design-lab/site-02/img/old.webp", "files/loose.png", "anki/loose.mp3"];
  for (const f of [...lab, ...other]) put(f);
  // A prototype builds its piece names in JavaScript: only the folder is in its text.
  e.notes.create({ title: "Site", kind: "web", content: '<script>for (const p of ["bk","wk"]) img.src = `media/design-lab/site-01/img/${p}.webp`;</script><img src="media/design%20lab%202/hero/a.png">' } as any);
  // Every page names /media/files/ and /media/anki/: that alone keeps nothing there.
  e.upsertItem({ id: "x", type: "basic", deck: "D", fields: { front: "![](/media/files/other.png) /media/anki/", back: "b" } });
  assert.deepEqual(e.unusedMedia().map((f) => f.path), other.slice().sort());
});

test("is:leftover finds exactly the cards a prune would delete, and follows edits", async (t) => {
  const { e, cli, http } = await setup(t);
  const vocab: CardTypeDef = { ...twoWay, id: "vocab", faces: ["t0", "t1", "t2", "t3"], fields: [...twoWay.fields, { name: "layout", kind: "text", default: "mrgp" }] };
  e.saveType(vocab);
  e.upsertItem({ id: "junge", type: "vocab", deck: "German", fields: { front: "der Junge", back: "boy", layout: "mrgp" } });
  e.upsertItem({ id: "ort", type: "vocab", deck: "German", fields: { front: "der Ort", back: "place", layout: "mrp" } });
  e.saveType({ ...vocab, facesWhen: 'return fields.layout === "mrp" ? ["t0", "t1", "t2"] : ["t0", "t1", "t3"];' });
  const found = (q: string) => e.search(q).rows.map((r) => `${r.itemId}/${r.face}`).sort();
  assert.deepEqual(found("is:leftover"), ["junge/t2", "ort/t3"]);
  assert.deepEqual(found("is:leftover face:t2"), ["junge/t2"]);
  assert.deepEqual(found("deck:German -is:leftover"), ["junge/t0", "junge/t1", "junge/t3", "ort/t0", "ort/t1", "ort/t2"]);
  assert.deepEqual((await cli("card", "list", "is:leftover", "type:vocab")).json.rows.map((r: { face: string }) => r.face).sort(), ["t2", "t3"]);

  // Switching der Ort to mrgp makes its t2 (now gender) a leftover and its t3 a card again.
  e.upsertItem({ id: "ort", type: "vocab", deck: "German", fields: { front: "der Ort", back: "place", layout: "mrgp" } });
  assert.deepEqual(found("is:leftover"), ["junge/t2", "ort/t2"]);

  assert.deepEqual(e.leftoverReport({ face: "t2" }).cards, 2);
  assert.deepEqual(await http("/api/cleanup/cards", { method: "POST", body: { type: "vocab", face: "t3" } }), { cards: 0, reviews: 0 });
  assert.equal((await cli("card", "prune", "--type", "vocab", "--face", "t2", "--yes")).json.cards, 2);
  assert.deepEqual(found("is:leftover"), []);
  assert.deepEqual(faces(e, "ort"), ["t0", "t1", "t3"]);
});
