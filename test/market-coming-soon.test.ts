import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Etude } from "../src/core/engine.ts";
import { COMING_SOON_FILE, fetchComingSoon, fetchComingSoonAsset, MAX_COVER_BYTES, parseComingSoon } from "../src/core/market.ts";
import { createApp } from "../src/server/app.ts";
import { run } from "../src/cli/run.ts";

const dir = (p = "etude-soon-") => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), p));

const GOOD = {
  etude: "coming-soon/1",
  entries: [
    {
      id: "kanji-mage",
      kind: "deck",
      name: "Kanji Mage",
      tagline: "Write kanji to cast spells.",
      description: "Monsters run at you.\n\nWrite the kanji.",
      tags: ["japanese", "kanji"],
      facts: [{ label: "Kanji", value: "1,026" }, { label: "Grades", value: "6" }],
      parts: ["Grade 1", "Grade 2"],
      cover: "covers/coming-soon/kanji-mage.webp",
      media: ["media/coming-soon/kanji-mage/01-run.webp", "media/coming-soon/kanji-mage/02-clip.mp4"],
    },
    { id: "logic-puzzles", name: "Logic Puzzles" },
  ],
};

/** A catalog folder with an index (empty), optionally a coming-soon.json, and its pictures. */
function catalog(soon?: unknown) {
  const root = dir();
  writeFileSync(join(root, "index.json"), JSON.stringify({ etude: "market/1", generated: "2026-11-05T00:00:00Z", repo: "x/y", entries: [] }));
  if (soon !== undefined) writeFileSync(join(root, COMING_SOON_FILE), typeof soon === "string" ? soon : JSON.stringify(soon));
  mkdirSync(join(root, "covers/coming-soon"), { recursive: true });
  mkdirSync(join(root, "media/coming-soon/kanji-mage"), { recursive: true });
  writeFileSync(join(root, "covers/coming-soon/kanji-mage.webp"), "cover");
  writeFileSync(join(root, "media/coming-soon/kanji-mage/01-run.webp"), "still");
  writeFileSync(join(root, "media/coming-soon/kanji-mage/02-clip.mp4"), "clip");
  return root;
}

test("coming soon: a good file parses, with defaults for what's left out", () => {
  const { entries, problems } = parseComingSoon(GOOD);
  assert.deepEqual(problems, []);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].facts[0].value, "1,026");
  assert.deepEqual(entries[0].media.length, 2);
  assert.deepEqual(entries[1], { id: "logic-puzzles", kind: "deck", name: "Logic Puzzles", tagline: "", description: "", tags: [], facts: [], parts: [], media: [] });
});

test("coming soon: a missing file is an empty list, a broken one never breaks the market", async () => {
  assert.deepEqual(await fetchComingSoon(catalog()), { entries: [], problems: [] });
  const broken = await fetchComingSoon(catalog("{ not json"));
  assert.equal(broken.entries.length, 0);
  assert.match(broken.problems[0], /isn't valid JSON/);
  assert.match(parseComingSoon({ etude: "market/1", entries: [] }).problems[0], /coming-soon\/1/);
  assert.match(parseComingSoon([]).problems[0], /coming-soon\/1/);
});

test("coming soon: junk paths, other entries' pictures and bad fields are dropped", () => {
  const bad = (x: object) => parseComingSoon({ etude: "coming-soon/1", entries: [{ id: "kanji-mage", name: "Kanji Mage", ...x }] });
  for (const cover of ["../../.env", "covers/decks/kanji-mage.webp", "covers/coming-soon/other.webp", "https://evil.example/a.webp", "covers/coming-soon/kanji-mage.svg", "covers/coming-soon/../x.webp"]) {
    const r = bad({ cover });
    assert.equal(r.entries.length, 0, cover);
    assert.match(r.problems[0], /cover must be/, cover);
  }
  for (const m of ["media/coming-soon/kanji-mage/../../../secret.png", "media/coming-soon/other/a.webp", "media/decks/kanji-mage/a.webp", "media/coming-soon/kanji-mage/x.html", "media/coming-soon/kanji-mage/.env", 7]) {
    assert.equal(bad({ media: [m] }).entries.length, 0, String(m));
  }
  assert.equal(bad({ media: Array.from({ length: 13 }, (_, i) => `media/coming-soon/kanji-mage/${i}.webp`) }).entries.length, 0);
  assert.equal(bad({ kind: "theme" }).entries.length, 0);
  assert.equal(bad({ name: "" }).entries.length, 0);
  assert.equal(bad({ facts: [{ label: "x" }] }).entries.length, 0);
  assert.equal(bad({ id: "Kanji Mage" }).entries.length, 0);
  // One bad entry doesn't take the good ones with it; ids are unique.
  const mixed = parseComingSoon({ etude: "coming-soon/1", entries: [GOOD.entries[0], { id: "x" }, GOOD.entries[0], null] });
  assert.equal(mixed.entries.length, 1);
  assert.equal(mixed.problems.length, 3);
});

test("coming soon: pictures only from their own folders, with size caps", async () => {
  const root = catalog(GOOD);
  assert.equal((await fetchComingSoonAsset(root, "covers/coming-soon/kanji-mage.webp")).type, "image/webp");
  assert.equal((await fetchComingSoonAsset(root, "media/coming-soon/kanji-mage/02-clip.mp4")).type, "video/mp4");
  for (const p of ["../index.json", "index.json", "entries/decks/x.json", "media/decks/kanji-mage/a.webp", "covers/coming-soon/kanji-mage.svg", "https://example.com/a.webp"]) {
    await assert.rejects(fetchComingSoonAsset(root, p), /unexpected coming-soon path/, p);
  }
  writeFileSync(join(root, "covers/coming-soon/big-one.webp"), Buffer.alloc(MAX_COVER_BYTES + 1));
  await assert.rejects(fetchComingSoonAsset(root, "covers/coming-soon/big-one.webp"), /too large/);
});

test("coming soon: /api/market lists them, slots serve pictures, nothing else comes through", async () => {
  const e = await Etude.open(":memory:");
  try {
    const root = catalog(GOOD);
    e.updateSettings({ market: { url: root, repo: "x/y" } } as any);
    const app = createApp(e);
    const market = (await (await app.request("/api/market")).json()) as any;
    assert.deepEqual(market.comingSoon.map((x: any) => x.id), ["kanji-mage", "logic-puzzles"]);
    assert.equal(market.entries.length, 0, "never mixed into installable entries");
    const cover = await app.request("/api/market/coming-soon/kanji-mage/cover");
    assert.equal(cover.status, 200);
    assert.equal(cover.headers.get("content-type"), "image/webp");
    assert.equal(await cover.text(), "cover");
    assert.equal(await (await app.request("/api/market/coming-soon/kanji-mage/1")).text(), "clip");
    assert.equal((await app.request("/api/market/coming-soon/kanji-mage/2")).status, 404);
    assert.equal((await app.request("/api/market/coming-soon/logic-puzzles/cover")).status, 404);
    assert.equal((await app.request("/api/market/coming-soon/nope/cover")).status, 404);
    assert.equal((await app.request("/api/market/coming-soon/kanji-mage/..%2F..%2Findex.json")).status, 404);
    assert.equal((await (await app.request("/api/market/coming-soon")).json() as any).entries.length, 2);
    // A catalog without the file: the market still answers, with an empty shelf.
    e.updateSettings({ market: { url: catalog(), repo: "x/y" } } as any);
    const plain = (await (await app.request("/api/market")).json()) as any;
    assert.deepEqual(plain.comingSoon, []);
  } finally {
    e.close();
  }
});

test("coming soon: etude market coming-soon prints the list as JSON", async () => {
  const home = dir("etude-soon-cli-");
  let out = "", err = "";
  const code = await run(["market", "coming-soon", "--url", catalog(GOOD), "--json"], { stdout: (s) => (out += s), stderr: (s) => (err += s), stdin: () => "", isTTY: false, env: { ETUDE_HOME: home } });
  assert.equal(code, 0, err);
  const j = JSON.parse(out);
  assert.deepEqual(j.entries.map((x: any) => x.name), ["Kanji Mage", "Logic Puzzles"]);
  assert.deepEqual(j.problems, []);
  assert.equal(j.entries[0].cover, "covers/coming-soon/kanji-mage.webp");
});
