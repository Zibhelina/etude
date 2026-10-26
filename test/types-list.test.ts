import { test } from "node:test";
import assert from "node:assert/strict";
import { Etude } from "../src/core/engine.ts";
import { createApp } from "../src/server/app.ts";

test("listTypes marks shipped, edited and custom types", async () => {
  const e = await Etude.open(":memory:");
  const find = (id: string) => e.listTypes().find((t) => t.id === id)!;

  const fresh = find("numeric");
  assert.equal(fresh.builtin, true);
  assert.equal(fresh.shipped, true);
  assert.equal(fresh.edited, false);

  const def = e.type("numeric");
  e.saveType({ ...def, template: { ...def.template, css: def.template.css + "\n.parts { gap: 2rem; }" } });
  const edited = find("numeric");
  assert.equal(edited.builtin, false);
  assert.equal(edited.shipped, true);
  assert.equal(edited.edited, true);

  e.resetType("numeric");
  assert.equal(find("numeric").edited, false);
  assert.equal(find("numeric").builtin, true);

  e.saveType({ id: "tf", name: "True or false", fields: [{ name: "claim", kind: "markdown" }], template: { html: "{{claim}}" }, grader: { kind: "self" } });
  const custom = find("tf");
  assert.equal(custom.builtin, false);
  assert.equal(custom.shipped, false);
  assert.equal(custom.edited, false);
  e.close();
});

test("archived items keep a type from being deleted, and the list counts them apart", async () => {
  const e = await Etude.open(":memory:");
  const app = createApp(e, { webDist: null });
  e.saveType({ id: "tf", name: "True or false", fields: [{ name: "claim", kind: "markdown" }], template: { html: "{{claim}}" }, grader: { kind: "self" } });
  e.upsertItem({ id: "a", type: "tf", deck: "D", fields: { claim: "x" } });
  e.setArchived(["a"], true);
  const t = e.listTypes().find((x) => x.id === "tf")!;
  assert.deepEqual([t.items, t.archived], [0, 1]);
  assert.throws(() => e.deleteType("tf"), /used by 1 item\(s\), all archived/);

  e.deleteItems(["a"]);
  // Changes must be JSON, so the web client sends {} with a DELETE.
  assert.equal((await app.request("/api/types/tf", { method: "DELETE" })).status, 415);
  assert.equal((await app.request("/api/types/tf", { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" })).status, 200);
  assert.ok(!e.listTypes().some((x) => x.id === "tf"));
  e.close();
});
