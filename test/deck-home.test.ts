import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { createApp } from "../src/server/app.ts";
import { run } from "../src/cli/run.ts";

async function open() {
  const dir = mkdtempSync(join(tmpdir(), "etude-home-"));
  const e = await Etude.open(join(dir, "etude.db"), { home: dir });
  return { e, dir, done: () => (e.close(), rmSync(dir, { recursive: true, force: true })) };
}

test("deck home: recursive per-deck home (never inherited from parent) and type default fallback", async () => {
  const { e, done } = await open();
  try {
    e.saveType({
      id: "song-game",
      name: "Song Game",
      fields: [
        { name: "title", kind: "text", required: true },
        { name: "secretKey", kind: "text", private: true },
      ],
      template: { html: "<div>{{title}}</div>" },
      grader: { kind: "script", code: "return { score: Number(answer?.stars ?? 0) / 3, details: { part: answer?.part ?? 0, stars: answer?.stars ?? 0 } };" },
      scheduler: "drill",
      home: { html: "<div id='map'>{{deck.title}}</div>", js: "etude.openCard(etude.cards[0]?.cardId);" },
    });
    e.ensureDeck("Music");
    e.ensureDeck("Music::Rock");
    e.ensureDeck("Music::Rock::Ballads");
    // Root has custom HTML home; Rock has catalog; Ballads inherits NOTHING from Music or Rock and uses song-game's type home.
    e.updateDeck("Music", { config: { home: { html: "<h1>World Map</h1>" } } });
    e.updateDeck("Music::Rock", { config: { home: "catalog" } });
    e.upsertItem({ id: "s1", type: "song-game", deck: "Music::Rock::Ballads", fields: { title: "Bohemian", secretKey: "TOP-SECRET" }, tags: ["classic"] });
    e.upsertItem({ id: "b1", type: "basic", deck: "Music::Plain", fields: { front: "Q", back: "A" } });

    assert.equal(e.resolveDeckHome("Music").kind, "custom");
    assert.equal(e.resolveDeckHome("Music::Rock").kind, "catalog");
    assert.equal(e.resolveDeckHome("Music::Rock::Ballads").kind, "custom");
    assert.equal(e.resolveDeckHome("Music::Rock::Ballads").source, "type");
    assert.equal(e.resolveDeckHome("Music::Plain").kind, "queue", "parent custom home never leaks into plain subdeck");

    // deckHome() exposes direct subdecks, public fields only, and strips private fields.
    const rootHome = e.deckHome("Music");
    assert.deepEqual(rootHome.subdecks.map((s) => [s.name, s.home]), [["Music::Plain", "queue"], ["Music::Rock", "catalog"]]);

    const balladsHome = e.deckHome("Music::Rock::Ballads");
    assert.equal(balladsHome.cards.length, 1);
    assert.equal(balladsHome.cards[0].fields.title, "Bohemian");
    assert.equal("secretKey" in balladsHome.cards[0].fields, false, "private fields never appear in deckHome");

    // Explicit queue overrides the card type's default home.
    e.updateDeck("Music::Rock::Ballads", { config: { home: "queue" } });
    assert.equal(e.resolveDeckHome("Music::Rock::Ballads").kind, "queue");
  } finally {
    done();
  }
});

test("etude.record & progress: folds scheduler state into sched_state and replays deterministically", async () => {
  const { e, done } = await open();
  try {
    e.saveScheduler({
      id: "star-fold",
      name: "Star Fold",
      ratings: false,
      schedule: `
        const prev = (card.state && card.state.parts) ? { ...card.state.parts } : {};
        const part = String(attempt.details?.part ?? 0);
        const stars = Math.max(prev[part] ?? 0, Number(attempt.details?.stars ?? 0));
        prev[part] = stars;
        const total = Object.values(prev).reduce((a, b) => a + b, 0);
        return { due: new Date(new Date(attempt.at).getTime() + 86400000).toISOString(), state: { parts: prev, stars: total } };
      `,
    });
    e.saveType({
      id: "piano-track",
      name: "Piano Track",
      fields: [{ name: "title", kind: "text", required: true }],
      template: { html: "<div>{{title}}</div>" },
      grader: { kind: "script", code: "return { score: (answer?.stars ?? 0) / 3, details: answer };" },
      scheduler: "star-fold",
      home: "catalog",
    });
    e.upsertItem({ id: "track.1", type: "piano-track", deck: "Piano", fields: { title: "Golden Hour" } });
    const cardId = e.db.get<{ id: number }>("SELECT id FROM cards WHERE item_id = ?", "track.1")!.id;

    // Initial progress is null.
    assert.equal(e.present(cardId).progress, null);

    // Record part 1 with 2 stars, then part 2 with 3 stars, then part 1 with 1 star (should keep max 2!).
    const r1 = await e.recordRun(cardId, 1, { part: 1, stars: 2 }, { durationMs: 4200 });
    assert.deepEqual(r1.progress, { parts: { "1": 2 }, stars: 2 });
    const r2 = await e.recordRun(cardId, 1, { part: 2, stars: 3 }, { durationMs: 5100 });
    assert.deepEqual(r2.progress, { parts: { "1": 2, "2": 3 }, stars: 5 });
    const r3 = await e.recordRun(cardId, 1, { part: 1, stars: 1 }, { durationMs: 3000 });
    assert.deepEqual(r3.progress, { parts: { "1": 2, "2": 3 }, stars: 5 });

    // present() and deckHome() both see the folded progress.
    assert.deepEqual(e.present(cardId).progress, { parts: { "1": 2, "2": 3 }, stars: 5 });
    assert.deepEqual(e.deckHome("Piano").cards[0].progress, { parts: { "1": 2, "2": 3 }, stars: 5 });

    // Reschedule replays from attempt/review log and reconstructs identical state.
    e.reschedule({ deck: "Piano" });
    assert.deepEqual(e.present(cardId).progress, { parts: { "1": 2, "2": 3 }, stars: 5 });
  } finally {
    done();
  }
});

test("deck home HTTP routes, sandboxed frame CSP, and CLI", async () => {
  const { e, dir, done } = await open();
  try {
    e.ensureDeck("Arcade");
    e.updateDeck("Arcade", { config: { home: { html: "<div id='ok'>Hi</div>" } } });
    e.upsertItem({ id: "a1", type: "basic", deck: "Arcade", fields: { front: "F", back: "B" } });
    const cardId = e.db.get<{ id: number }>("SELECT id FROM cards WHERE item_id = ?", "a1")!.id;
    const app = createApp(e);

    const homeRes = await app.request("/api/decks/Arcade/home");
    assert.equal(homeRes.status, 200);
    const homeJson = await homeRes.json();
    assert.equal(homeJson.deck.home, "custom");
    assert.equal(homeJson.cards.length, 1);

    const frameRes = await app.request("/frame-home/Arcade");
    assert.equal(frameRes.status, 200);
    const html = await frameRes.text();
    assert.ok(html.includes("Content-Security-Policy"));
    assert.ok(html.includes("bootHome"));
    assert.ok(html.includes("\\u003cdiv id='ok'>Hi\\u003c/div>"));

    const recRes = await app.request("/api/study/record", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cardId, seed: 1, answer: "ok" }),
    });
    assert.equal(recRes.status, 200);

    const out: string[] = [];
    const code = await run(["--db", e.path, "deck", "home", "Arcade", "--mode", "catalog"], {
      stdout: (s: string) => out.push(s),
      stderr: () => {},
      env: { ETUDE_HOME: dir },
      tty: false,
    } as any);
    assert.equal(code, 0);
    assert.equal(JSON.parse(out.join("")).deck.home, "catalog");
  } finally {
    done();
  }
});
