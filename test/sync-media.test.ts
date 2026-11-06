import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { syncFor } from "../src/core/sync/client.ts";

// The collection syncs first; media files follow in a background task. These hold one device's blob
// transfers to see what is there while the media is still on its way.

const password = "a test Sync password";
const temp = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "sync-media-"));

type Gate = { calls: number; open: () => void; fail: (e: Error | null) => void };
/** Holds a transfer until `open()`; `fail(e)` makes the next ones throw instead. An aborted transfer stops waiting. */
function gate(): Gate & { wait: (signal?: AbortSignal) => Promise<void> } {
  let release!: () => void, error: Error | null = null;
  const opened = new Promise<void>((r) => (release = r));
  const g = {
    calls: 0,
    open: () => release(),
    fail: (e: Error | null) => void (error = e),
    wait: async (signal?: AbortSignal) => {
      g.calls++;
      if (error) throw error;
      await new Promise<void>((resolve, reject) => {
        opened.then(resolve);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  };
  return g;
}
/** This device's blob downloads (`get`) and uploads (`put`) wait at their gates. */
function hold(e: Etude) {
  const s = syncFor(e) as any, real = s.transport.bind(s), gates = { get: gate(), put: gate() };
  s.transport = () => {
    const t = real();
    return Object.assign(Object.create(t), {
      getBlob: async (name: string, signal?: AbortSignal) => (await gates.get.wait(signal), t.getBlob(name, signal)),
      putBlob: async (name: string, bytes: Uint8Array, signal?: AbortSignal) => (await gates.put.wait(signal), t.putBlob(name, bytes, signal)),
    });
  };
  return gates;
}
/** Resolves once `check` holds, polling briefly. */
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 500 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(check(), what);
}
async function pair(t: any) {
  const dir = temp();
  for (const d of ["a", "b"]) mkdirSync(join(dir, d));
  const a = await Etude.open(join(dir, "a", "a.db"), { home: join(dir, "ha") }), b = await Etude.open(join(dir, "b", "b.db"), { home: join(dir, "hb") });
  t.after(() => { for (const e of [a, b]) try { e.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  for (const e of [a, b]) { syncFor(e).setup({ folder: join(dir, "shared") }); await syncFor(e).unlock({ password }); }
  return { a, b };
}
const item = (e: Etude, id: string, deck = "Remote") => e.upsertItem({ id, deck, type: "basic", fields: { front: `front of ${id}`, back: "back" }, tags: [] });
const clip = (e: Etude, name: string, text: string) => { mkdirSync(join(e.mediaDir, "anki"), { recursive: true }); writeFileSync(join(e.mediaDir, "anki", name), text); };
const file = (e: Etude, name: string) => join(e.mediaDir, "anki", name);

test("F1: the collection is there before any media file; the files follow", async (t) => {
  const { a, b } = await pair(t);
  item(a, "one");item(a, "two");clip(a, "one.mp3", "first sound");clip(a, "two.mp3", "second sound");
  await syncFor(a).now({ waitMedia: true });
  const held = hold(b);
  const st = await syncFor(b).now();
  // Decks, items and cards answer through the engine while both downloads wait.
  assert.ok(b.deckTree().some((d: any) => d.name === "Remote"));
  assert.equal(b.item("one").cards.length, 1);assert.equal(b.item("two").cards.length, 1);
  assert.equal(st.busy, false);assert.equal(st.error, null);assert.ok(st.lastSync);
  await until(() => held.get.calls > 0, "the media task asks for a blob");
  assert.equal(syncFor(b).status().media.active, true);
  assert.ok(!existsSync(file(b, "one.mp3")) && !existsSync(file(b, "two.mp3")));
  held.get.open();await syncFor(b).mediaSettled();
  assert.equal(readFileSync(file(b, "one.mp3"), "utf8"), "first sound");assert.equal(readFileSync(file(b, "two.mp3"), "utf8"), "second sound");
  const done = syncFor(b).status().media;
  assert.deepEqual({ active: done.active, progress: done.progress, error: done.error, received: done.received }, { active: false, progress: null, error: null, received: 2 });
});

test("F2: a review made here reaches another device while this device's media upload waits", async (t) => {
  const { a, b } = await pair(t);
  item(a, "one");await syncFor(a).now({ waitMedia: true });await syncFor(b).now({ waitMedia: true });
  const held = hold(a);
  clip(a, "new.mp3", "a new sound");a.rate(a.item("one").cards[0].id, 3);
  await syncFor(a).now();
  await until(() => held.put.calls > 0, "the media upload is under way");
  await syncFor(b).now();
  assert.equal(b.db.get("SELECT count(*) n FROM reviews")!.n, 1, "the review arrived");
  assert.equal(b.item("one").cards[0].reps, 1);
  assert.ok(!existsSync(file(b, "new.mp3")));
  held.put.open();await syncFor(a).mediaSettled();
  await syncFor(b).now({ waitMedia: true });
  assert.equal(readFileSync(file(b, "new.mp3"), "utf8"), "a new sound");
});

test("a sync during the media works, never starts a second media task, and the media runs again for what came in meanwhile", async (t) => {
  const { a, b } = await pair(t);
  item(a, "one");clip(a, "one.mp3", "first");
  await syncFor(a).now({ waitMedia: true });
  const s = syncFor(b) as any, media = s.media.bind(s);let running = 0, most = 0, passes = 0;
  s.media = async (...args: any[]) => { running++;passes++;most = Math.max(most, running);try { return await media(...args); } finally { running--; } };
  const held = hold(b);
  await syncFor(b).now();
  await until(() => held.get.calls > 0, "b's media waits for its download");
  // Meanwhile: a new item and file on a, and two more syncs on b.
  item(a, "two");clip(a, "two.mp3", "second");await syncFor(a).now({ waitMedia: true });
  const task = s.mediaTask;
  await syncFor(b).now();await syncFor(b).now();
  assert.equal(s.mediaTask, task, "the same media task");
  assert.equal(b.item("two").cards.length, 1, "the collection synced during the media");
  held.get.open();await syncFor(b).mediaSettled();
  assert.equal(most, 1, "never two media passes at once");
  assert.equal(passes, 2, "one more pass for the file that came in");
  assert.equal(readFileSync(file(b, "one.mp3"), "utf8"), "first");assert.equal(readFileSync(file(b, "two.mp3"), "utf8"), "second");
  assert.equal(syncFor(b).status().media.error, null);
});

test("off() during the media stops it cleanly, and turning Sync back on finishes the files", async (t) => {
  const { a, b } = await pair(t);
  item(a, "one");for (let i = 0; i < 5; i++) clip(a, `${i}.mp3`, `sound ${i}`);
  await syncFor(a).now({ waitMedia: true });
  const held = hold(b);
  await syncFor(b).now();
  await until(() => held.get.calls > 0, "b's media waits for its download");
  const st = await syncFor(b).off();
  assert.equal(st.configured, false);
  assert.deepEqual(st.media, { active: false, progress: null, error: null, received: 0 });
  // Nothing half written, under any name.
  const left = existsSync(join(b.mediaDir, "anki")) ? readdirSync(join(b.mediaDir, "anki")) : [];
  assert.deepEqual(left, []);
  held.get.open();
  syncFor(b).setup({ folder: (syncFor(a).status() as any).folder });await syncFor(b).unlock({ password });
  await syncFor(b).now({ waitMedia: true });
  for (let i = 0; i < 5; i++) assert.equal(readFileSync(file(b, `${i}.mp3`), "utf8"), `sound ${i}`);
});

test("F5: a media failure leaves the collection synced, shows only on the media, and the next sync tries again", async (t) => {
  const { a, b } = await pair(t);
  item(a, "one");clip(a, "one.mp3", "first");
  await syncFor(a).now({ waitMedia: true });
  const held = hold(b);held.get.open();
  held.get.fail(new Error("the disk said no"));
  const st = await syncFor(b).now();
  assert.equal(st.error, null);assert.equal(b.item("one").cards.length, 1);
  await syncFor(b).mediaSettled();
  const after = syncFor(b).status();
  assert.equal(after.error, null, "the collection's error stays clear");
  assert.equal(after.media.error, "the disk said no");
  // The CLI waits for the media and reports its failure.
  await assert.rejects(syncFor(b).now({ waitMedia: true }), /the disk said no/);
  // An automatic sync keeps a network failure quiet, as it does for the collection.
  held.get.fail(new TypeError("fetch failed"));
  await syncFor(b).auto();await syncFor(b).mediaSettled();
  assert.equal(syncFor(b).status().media.error, null);
  assert.ok(!existsSync(file(b, "one.mp3")));
  // The next sync tries again.
  held.get.fail(null);
  await syncFor(b).now({ waitMedia: true });
  assert.equal(readFileSync(file(b, "one.mp3"), "utf8"), "first");
  assert.equal(syncFor(b).status().media.error, null);
});

test("closing the collection stops the media task", async (t) => {
  const { a, b } = await pair(t);
  item(a, "one");clip(a, "one.mp3", "first");
  await syncFor(a).now({ waitMedia: true });
  const held = hold(b);
  await syncFor(b).now();
  await until(() => held.get.calls > 0, "b's media waits for its download");
  const s = syncFor(b) as any, task = s.mediaTask;
  b.close();
  await task;
  assert.equal(s.mediaTask, null);assert.equal(s.mediaError, null);
  assert.ok(!existsSync(file(b, "one.mp3")));
});
