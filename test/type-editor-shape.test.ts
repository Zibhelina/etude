import { test } from "node:test";
import assert from "node:assert/strict";
import { Etude } from "../src/core/engine.ts";
import type { CardTypeDef } from "../src/core/model.ts";
import { exportShape } from "../web/src/components/type-editor/shape.ts";

test("saving from the type editor keeps what it has no controls for", async () => {
  const e = await Etude.open(":memory:");
  // Every built-in, as the editor loads it (GET /api/types/:id) and saves it back unchanged.
  for (const { id } of e.listTypes()) {
    const { updated: _u, builtin: _b, ...stored } = e.type(id);
    assert.deepEqual(e.saveTypeReport(exportShape({ ...e.type(id), assetFiles: [] })).type, stored, id);
  }

  const full = {
    id: "drill",
    name: "Drill",
    description: "",
    fields: [
      { name: "text", kind: "markdown", label: "", description: "", required: false, private: false },
      { name: "code", kind: "code", language: "field:lang" },
      { name: "lang", kind: "text" },
    ],
    titleField: "text",
    template: { html: "<div></div>" },
    grader: { kind: "script", code: "return { score: 1, details: { wpm: 60 } };" },
    demo: "return 'x';",
    metrics: [{ key: "wpm", label: "WPM", better: "higher" }],
    showVerdict: false,
    updated: "2026-10-26T00:00:00.000Z",
    builtin: false,
    assetFiles: [{ name: "a.json", size: 2, hash: "h" }],
  } as CardTypeDef & { updated: string; builtin: boolean; assetFiles: unknown };
  const shape = exportShape(full);
  assert.deepEqual(shape.fields, [{ name: "text", kind: "markdown" }, { name: "code", kind: "code", language: "field:lang" }, { name: "lang", kind: "text" }]);
  for (const k of ["updated", "builtin", "assetFiles"]) assert.ok(!(k in shape), k);
  const saved = e.saveType(shape);
  assert.equal(saved.demo, "return 'x';");
  assert.deepEqual(saved.metrics, [{ key: "wpm", label: "WPM", better: "higher" }]);
  assert.equal(saved.showVerdict, false);
  assert.equal(saved.titleField, "text");
  assert.equal(saved.fields[1].language, "field:lang");
  e.close();
});
