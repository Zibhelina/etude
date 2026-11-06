// Security audit (5 Nov), the smaller items: a private collection on shared machines, a card's script errors kept out
// of error reports, a card reading only its own type's assets, card frames kept on Etude's pages in the desktop app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Etude } from "../src/core/engine.ts";
import { createApp } from "../src/server/app.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const mode = (p: string) => statSync(p).mode & 0o777;

test("the collection is its owner's only: database 0600 (its -wal too), the Etude home and media 0700", { skip: process.platform === "win32" }, async (t) => {
  const home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-private-"));
  const e = await Etude.open(join(home, "etude.db"), { home });
  e.importPack({ etude: "pack/1", name: "P", decks: [{ name: "P" }], items: [{ id: "p1", type: "basic", deck: "P", fields: { front: "Q", back: "A" } }] });
  assert.equal(mode(join(home, "etude.db")), 0o600);
  // The WebAssembly driver keeps no WAL file: it writes the whole database back (0600 too).
  if (process.env.ETUDE_SQL !== "wasm") assert.equal(mode(join(home, "etude.db-wal")), 0o600, "SQLite gives the WAL the database's mode");
  assert.equal(mode(home), 0o700);
  // An older install with open modes is tightened the next time it opens.
  e.close();
  const { chmodSync } = await import("node:fs");
  chmodSync(join(home, "etude.db"), 0o644);
  chmodSync(home, 0o755);
  const again = await Etude.open(join(home, "etude.db"), { home });
  t.after(() => {
    again.close();
    rmSync(home, { recursive: true, force: true });
  });
  assert.equal(mode(join(home, "etude.db")), 0o600);
  assert.equal(mode(home), 0o700);
});

test("a card type's own script failing answers 422 with its message and isn't sent as an error report", async (t) => {
  const home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-scripterr-"));
  const e = await Etude.open(join(home, "etude.db"), { home });
  // Closed before the folder goes: Windows won't delete an open database.
  t.after(() => {
    e.close();
    rmSync(home, { recursive: true, force: true });
  });
  e.importPack({
    etude: "pack/1",
    name: "Broken",
    decks: [{ name: "Broken" }],
    types: [{ id: "broken", name: "Broken", fields: [{ name: "q", kind: "markdown" }], grader: { kind: "self" }, prepare: "throw new Error('the card says: ' + fields.q)", template: { html: "<p>{{q}}</p>" } }],
    items: [{ id: "b1", type: "broken", deck: "Broken", fields: { q: "a private note" } }],
  });
  const r = await createApp(e).request(`/api/study/next?deck=Broken`);
  assert.equal(r.status, 422);
  assert.match((await r.json()).error, /the card says: a private note/);
  // The report path is for bugs in Etude; a script error returns before it.
  const onError = /app\.onError\(\(err, c\) => \{([\s\S]*?)\n {2}\}\);/.exec(read("src/server/app.ts"))?.[1] ?? "";
  assert.ok(onError.indexOf("err instanceof ScriptError") > 0 && onError.indexOf("err instanceof ScriptError") < onError.indexOf("telemetryFor("));
});

test("a card frame asks the app only for its own type's assets (the app checks; this keeps it in place)", () => {
  const frame = read("web/src/components/card-frame.tsx");
  assert.match(frame, /const assetType = \/\^\\\/type-assets\\\/\(\[\^\/\?#\]\+\)\\\/\/\.exec\(path\)\?\.\[1\];/);
  assert.match(frame, /if \(assetType && own && decodeURIComponent\(assetType\) !== own\)/);
});

test("desktop: a card frame can't navigate itself off Etude's pages", () => {
  const app = read("desktop/app.ts");
  const handler = /wc\.on\("will-frame-navigate", \(e\) => \{([\s\S]*?)\n {2}\}\);/.exec(app)?.[1] ?? "";
  assert.match(handler, /if \(e\.isMainFrame \|\| isOwnPage\(e\.url\) \|\| \/\^about:\(blank\|srcdoc\)\$\/\.test\(e\.url\)\) return;/);
  assert.match(handler, /e\.preventDefault\(\);/);
  assert.doesNotMatch(handler, /log\([^)]*e\.url\)/, "the address a card tried (with what it carried) isn't logged");
});
