import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPublicContent } from "../site/public-content.ts";

function fixture(t: { after(fn: () => void): void }) {
  const site = mkdtempSync(join(tmpdir(), "etude-public-site-"));
  t.after(() => rmSync(site, { recursive: true, force: true }));
  mkdirSync(join(site, "decks"));
  return site;
}

test("site rejects an unpublished deck before copying public files", (t) => {
  const site = fixture(t);
  writeFileSync(join(site, "decks", "unreleased.json"), JSON.stringify({ type: { id: "unreleased" } }));
  assert.throws(() => checkPublicContent(site), /unapproved public demo/);
});

test("site rejects unpublished assets even without a demo entry", (t) => {
  const site = fixture(t);
  mkdirSync(join(site, "src/type-assets/unreleased"), { recursive: true });
  writeFileSync(join(site, "src/type-assets/unreleased", "model.bin"), "private");
  assert.throws(() => checkPublicContent(site), /unapproved public assets/);
});

test("site checks the actual type instead of trusting the demo filename", (t) => {
  const site = fixture(t);
  writeFileSync(join(site, "decks", "element.json"), JSON.stringify({ type: { id: "unreleased" } }));
  assert.throws(() => checkPublicContent(site), /type mismatch/);
});

test("the public website sources contain only approved demos", () => {
  checkPublicContent(new URL("../site", import.meta.url).pathname);
});
