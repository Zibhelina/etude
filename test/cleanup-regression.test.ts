import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Etude } from "../src/core/engine.ts";

test("media cleanup keeps referenced parentheses and URL-encoded Unicode filenames", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "cleanup-names-"));
  const e = await Etude.open(join(dir, "etude.db"));
  t.after(() => { e.close(); rmSync(dir, { recursive: true, force: true }); });
  mkdirSync(join(e.mediaDir, "anki"), { recursive: true });
  const names = ["Bayern (1).png", "Äpfel.png", "full.png"];
  const old = new Date(Date.now() - 7200_000);
  for (const name of names) {
    const path = join(e.mediaDir, "anki", name);
    writeFileSync(path, "image");
    utimesSync(path, old, old);
  }
  e.upsertItem({ id: "names", type: "basic", deck: "D", fields: {
    front: '<img src="/media/anki/Bayern (1).png"><img src="/media/anki/%C3%84pfel.png"><img src="/media/anki/full%2Epng">', back: "back",
  } });
  assert.deepEqual(e.unusedMedia(), []);
});

test("leftover cache follows edits even when updated timestamps do not advance", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "cleanup-cache-"));
  const e = await Etude.open(join(dir, "etude.db"));
  t.after(() => { e.close(); rmSync(dir, { recursive: true, force: true }); });
  e.saveType({ id: "conditional", name: "Conditional", faces: ["a", "b"], facesWhen: 'return fields.front === "both" ? ["a", "b"] : ["a"];', fields: [{ name: "front", kind: "text" }], template: { html: "{{front}}" }, grader: { kind: "self" } });
  e.upsertItem({ id: "x", type: "conditional", deck: "D", fields: { front: "both" } });
  assert.equal(e.leftoverReport().cards, 0);
  e.db.run("UPDATE items SET fields = ? WHERE id = ?", JSON.stringify({ front: "one" }), "x");
  assert.equal(e.leftoverReport().cards, 1);
  e.db.run("UPDATE items SET archived = 1 WHERE id = ?", "x");
  assert.equal(e.leftoverReport().cards, 0);
});
