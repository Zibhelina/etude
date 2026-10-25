import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { buildIndex, buildSubmission, checkEntry, entryJson, entryPath, fetchIndex, installEntry, installFile, installState, installedEntries, publishFile, type MarketFile } from "../src/core/market.ts";

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
