import { test } from "node:test";
import assert from "node:assert/strict";
import { actOf } from "../web/src/components/type-editor/acts.ts";
import { Etude } from "../src/core/engine.ts";

test("every shipped type lands in a gallery group, and custom types are read from what they say", async () => {
  const e = await Etude.open(":memory:");
  const acts = Object.fromEntries(e.listTypes().filter((t) => t.shipped).map((t) => [t.id, actOf(t)]));
  assert.equal(acts.basic, "remember");
  assert.equal(acts.mcq, "pick");
  assert.equal(acts.order, "place");
  assert.equal(acts.code, "write");
  e.close();

  const t = (description: string, extra = {}) => actOf({ id: "x", name: "X", description, ...extra });
  assert.equal(t("Play a chord on a two-octave piano."), "play");
  assert.equal(t("Drag events onto a timeline between fixed anchors."), "place");
  assert.equal(t("A chord is played and you pick its quality by ear."), "pick");
  assert.equal(t("Write a regular expression. Hidden tests are checked."), "write");
  assert.equal(t("A 30-second mental arithmetic sprint."), "games");
  assert.equal(t("Anything at all.", { scheduler: "drill" }), "games");
  assert.equal(t("A word and its meaning."), "remember");
});
