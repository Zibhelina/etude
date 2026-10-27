import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildIndex, fetchMarketMedia, MAX_MEDIA_BYTES } from "../src/core/market.ts";

const fixture = () => {
 const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-gallery-"));
 mkdirSync(join(root, "entries/themes"), { recursive: true });
 writeFileSync(join(root, "entries/themes/sample.json"), JSON.stringify({ etudeMarket: 1, kind: "theme", id: "sample", name: "Sample", author: "author", version: "1", tags: [], updated: "2026-10-26", content: { id: "sample", name: "Sample", scheme: "dark", vars: {} } }));
 const media = join(root, "media/themes/sample");
 mkdirSync(media, { recursive: true });
 return { root, media };
};

test("market galleries: index discovers ordered media and serves typed bytes", async () => {
 const { root, media } = fixture();
 writeFileSync(join(media, "02-screen.webp"), "screen");
 writeFileSync(join(media, "01-preview.mp4"), "clip");
 const { index, problems } = await buildIndex(root);
 assert.deepEqual(problems, []);
 assert.deepEqual(index.entries[0].media, ["media/themes/sample/01-preview.mp4", "media/themes/sample/02-screen.webp"]);
 const r = await fetchMarketMedia(root, index.entries[0].media![0]);
 assert.equal(r.type, "video/mp4"); assert.equal(r.body.toString(), "clip");
 assert.equal((await fetchMarketMedia(root, index.entries[0].media![1])).type, "image/webp");
});
test("market galleries: invalid names, oversized media, excess slides are rejected", async () => {
 const { root, media } = fixture();
 writeFileSync(join(media, "unsafe.html"), "no");
 assert.equal((await buildIndex(root)).problems.length, 1);
 const { root: r2, media: m2 } = fixture();
 writeFileSync(join(m2, "big.mp4"), Buffer.alloc(MAX_MEDIA_BYTES + 1));
 assert.equal((await buildIndex(r2)).problems.length, 1);
 const { root: r3, media: m3 } = fixture();
 for (let i = 0; i < 13; i++) writeFileSync(join(m3, `${i}.png`), "x");
 assert.equal((await buildIndex(r3)).problems.length, 1);
});
test("market galleries: traversal, remote URLs, private paths and SVGs never reach disk/network", async () => {
 for (const path of ["../../.env", "media/decks/foo/../../../secret.png", "https://example.com/a.mp4", "media/decks/foo/script.svg", "media/decks/foo/.env", "entries/decks/foo.json"])
  await assert.rejects(fetchMarketMedia("/missing", path), /unexpected media path/);
 await assert.rejects(fetchMarketMedia("/missing", "media/decks/foo/missing.png"), /has no/);
});
