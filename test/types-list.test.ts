import { test } from "node:test";
import assert from "node:assert/strict";
import { Etude } from "../src/core/engine.ts";

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
