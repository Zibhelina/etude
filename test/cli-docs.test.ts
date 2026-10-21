import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DOC_PATH, MARKER, render } from "../scripts/gen-cli-docs.ts";
import { COMMANDS } from "../src/cli/registry.ts";

test("docs/cli.md matches the command registry", () => {
  const current = readFileSync(DOC_PATH, "utf8");
  assert.ok(current.includes(MARKER), "docs/cli.md lost its generated-section marker");
  assert.ok(render(current) === current, "docs/cli.md is out of date: run `node scripts/gen-cli-docs.ts`");
  for (const c of COMMANDS.filter((x) => !x.legacy)) assert.ok(current.includes(`### etude ${c.name}\n`), `no section for ${c.name}`);
});
