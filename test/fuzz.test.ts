import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { syncFor } from "../src/core/sync/client.ts";
import * as sched from "../src/core/scheduler.ts";
import { DEFAULT_PRESET, type CardRow } from "../src/core/model.ts";

const temp = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "fuzz-test-"));
const DAY = 86400_000;
const password = "a test Sync password";
/** Every card's schedule, by stable identity. */
const schedules = (e: Etude) => e.db.all("SELECT item_id, face, state, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, learning_steps, last_review FROM cards ORDER BY item_id, face").map((r) => ({ ...r }));
async function devices(dir: string, n: number) {
  const es: Etude[] = [];
  for (let i = 0; i < n; i++) {
    const e = await Etude.open(join(dir, `d${i}`, "c.db"), { home: join(dir, `h${i}`) });
    syncFor(e).setup({ folder: join(dir, "shared") });
    await syncFor(e).unlock({ password });
    await syncFor(e).now();
    es.push(e);
  }
  return es;
}
const card = (over: Partial<CardRow & { sync_id: string }> = {}): CardRow & { sync_id?: string } => ({
  ...sched.emptyCard(new Date("2027-01-01T00:00:00Z")),
  id: 1,
  item_id: "item-1",
  face: "main",
  suspended: 0,
  buried_until: null,
  ...over,
});
/** The seed ts-fsrs drew this review's fuzz from. */
const seedOf = (row: CardRow, at: Date) => {
  const f = sched.engine({ ...DEFAULT_PRESET, enableFuzz: true });
  f.next(sched.toFsrs(row), at, 3);
  return (f as any)._seed as string;
};

test("the fuzz seed is the card's key and the review's number, with no time or floating point in it", () => {
  const reviewed = card({ state: 2, reps: 3, stability: 12.345678901234567, difficulty: 5.4321, last_review: "2027-01-01T00:00:00.000Z", due: "2027-01-13T00:00:00.000Z" });
  const at = new Date("2027-01-14T09:30:00.123Z");
  assert.equal(seedOf(reviewed, at), '["item-1","main"]:4');
  assert.equal(seedOf({ ...reviewed, sync_id: '["item-0","front"]' } as CardRow, at), '["item-0","front"]:4', "the sync key when there is one");
  assert.equal(sched.cardKey({ item_id: 'quote " and ü', face: "main" }), JSON.stringify(['quote " and ü', "main"]));
  // The last bit of stability or difficulty can differ between JavaScript engines; it doesn't move the seed.
  const bit = (x: number) => { const b = new Float64Array([x]), i = new BigUint64Array(b.buffer); i[0] ^= 1n; return b[0]; };
  assert.notEqual(bit(reviewed.stability), reviewed.stability);
  assert.equal(seedOf({ ...reviewed, stability: bit(reviewed.stability), difficulty: bit(reviewed.difficulty) }, at), '["item-1","main"]:4');
  // Neither does the moment: the rating buttons and the rating a few seconds later draw the same fuzz.
  assert.equal(seedOf(reviewed, new Date(at.getTime() + 4321)), '["item-1","main"]:4');
  assert.equal(seedOf({ ...reviewed, reps: 4 }, at), '["item-1","main"]:5', "the next review draws again");
});

test("the rating buttons show the interval that rating then gives", async () => {
  const dir = temp();
  const e = await Etude.open(join(dir, "a.db"), { home: join(dir, "home") });
  try {
    for (let i = 0; i < 12; i++) e.upsertItem({ id: `item-${i}`, deck: "Fuzz", type: "basic", fields: { front: `q ${i}`, back: "a" } });
    const ids = e.db.all("SELECT id FROM cards").map((r) => r.id as number);
    // Reviewed three weeks ago, so every rating but Again lands on a fuzzed interval of days.
    for (const id of ids) e.rate(id, 4, { at: new Date(Date.now() - 21 * DAY) });
    let fuzzed = 0;
    for (const id of ids) for (const rating of [1, 2, 3, 4] as const) {
      const shown = new Date(e.cardSchedule(id).intervals[rating]).getTime();
      const before = Date.now();
      const due = new Date(e.rate(id, rating).due).getTime();
      // Both count from their own moment, a few milliseconds apart.
      assert.ok(Math.abs(due - shown) <= Date.now() - before + 1000, `card ${id}, rating ${rating}: shown ${new Date(shown).toISOString()}, given ${new Date(due).toISOString()}`);
      if (rating > 1 && Math.round((due - Date.now()) / DAY) > 2) fuzzed++;
      e.undo();
    }
    assert.ok(fuzzed > 20, "the comparison covered fuzzed intervals");
  } finally {
    e.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fuzzed review keeps its date through sync, on the device that made it and on another", async () => {
  const dir = temp();
  const [a, b] = await devices(dir, 2);
  try {
    for (let i = 0; i < 16; i++) a.upsertItem({ id: `item-${i}`, deck: "Fuzz", type: "basic", fields: { front: `q ${i}`, back: "a" } });
    await syncFor(a).now();
    await syncFor(b).now();
    const ids = a.db.all("SELECT id FROM cards ORDER BY id").map((r) => r.id as number);
    const start = Date.now() - 200 * DAY;
    for (let round = 0; round < 5; round++) {
      ids.forEach((id, i) => a.rate(id, ([4, 3, 3, 2, 1] as const)[(i + round) % 5], { at: new Date(start + round * 40 * DAY + i * 60_000) }));
      const rated = schedules(a);
      await syncFor(a).now();
      assert.deepEqual(schedules(a), rated, `round ${round}: the sync left this device's dates alone`);
      await syncFor(b).now();
      assert.deepEqual(schedules(b), rated, `round ${round}: the other device has the same dates`);
    }
    // The fuzz was really on: some intervals are off the unfuzzed ones.
    const plain = a.db.all("SELECT r.ts, r.rating, c.item_id, c.face, c.sync_id FROM reviews r JOIN cards c ON c.id = r.card_id ORDER BY c.id, r.ts");
    const off = ids.filter((id) => {
      const c = a.db.get("SELECT * FROM cards WHERE id = ?", id) as CardRow & { created: string };
      const history = plain.filter((r) => r.item_id === c.item_id && r.face === c.face);
      return sched.replay(history as { ts: string; rating: number }[], new Date(history[0].ts), { ...DEFAULT_PRESET, enableFuzz: false }, sched.cardKey(c)).due !== c.due;
    });
    assert.ok(off.length > ids.length / 2, `${off.length} of ${ids.length} cards fuzzed`);
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fuzz spreads cards learned together, and the spread survives sync", async () => {
  const dir = temp();
  const [e] = await devices(dir, 1);
  try {
    const at = new Date(Date.now() - 60 * DAY);
    for (const fuzz of [true, false]) {
      const deck = fuzz ? "Spread" : "Together";
      e.ensureDeck(deck);
      e.updateDeck(deck, { config: { enableFuzz: fuzz } });
      for (let i = 0; i < 50; i++) e.upsertItem({ id: `${deck}-${i}`, deck, type: "basic", fields: { front: `q ${i}`, back: "a" } });
      const ids = e.db.all("SELECT c.id FROM cards c JOIN items i ON i.id = c.item_id WHERE i.deck_id = (SELECT id FROM decks WHERE name = ?)", deck).map((r) => r.id as number);
      // Every card gets Good on the same days: learning, then intervals long enough to fuzz.
      for (const day of [0, 1, 4, 20]) for (const id of ids) e.rate(id, 3, { at: new Date(at.getTime() + day * DAY) });
    }
    const dues = (deck: string) => new Set(e.db.all("SELECT c.due FROM cards c JOIN items i ON i.id = c.item_id JOIN decks d ON d.id = i.deck_id WHERE d.name = ?", deck).map((r) => r.due));
    const check = () => {
      assert.ok(dues("Spread").size > 5, `with fuzz, ${dues("Spread").size} different dates`);
      assert.equal(dues("Together").size, 1, "without fuzz, one date");
    };
    check();
    await syncFor(e).now();
    check();
  } finally {
    e.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rescheduling here gives what the sync replay gives", async () => {
  const dir = temp();
  const [e] = await devices(dir, 1);
  try {
    for (let i = 0; i < 16; i++) e.upsertItem({ id: `item-${i}`, deck: "Fuzz", type: "basic", fields: { front: `q ${i}`, back: "a" } });
    const ids = e.db.all("SELECT id FROM cards ORDER BY id").map((r) => r.id as number);
    const start = Date.now() - 300 * DAY;
    for (let round = 0; round < 6; round++) ids.forEach((id, i) => e.rate(id, ([3, 4, 1, 3, 2, 3] as const)[(i * 7 + round) % 6], { at: new Date(start + round * 45 * DAY + i * 3_600_000) }));
    await syncFor(e).now();
    const canonical = schedules(e);
    assert.equal(e.reschedule().rescheduled, ids.length);
    assert.deepEqual(schedules(e), canonical);
    await syncFor(e).now();
    assert.deepEqual(schedules(e), canonical);
  } finally {
    e.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rescheduling follows the sync replay for reviews made at the same moment and for reset cards", async () => {
  const dir = temp();
  const [a, b] = await devices(dir, 2);
  try {
    a.upsertItem({ id: "tied", deck: "Fuzz", type: "basic", fields: { front: "q", back: "a" } });
    await syncFor(a).now();
    await syncFor(b).now();
    const id = (e: Etude) => e.db.get("SELECT id FROM cards WHERE item_id = 'tied'")!.id as number;
    // Each device inserted its own review first; the sync replay orders the two by sync id on both.
    const at = new Date(Date.now() - 90 * DAY);
    a.rate(id(a), 4, { at });
    b.rate(id(b), 1, { at });
    for (const e of [a, b, a, b]) await syncFor(e).now();
    a.rate(id(a), 3, { at: new Date(at.getTime() + 30 * DAY) });
    for (const e of [a, b, a, b]) await syncFor(e).now();
    for (const e of [a, b]) {
      const canonical = schedules(e);
      e.reschedule();
      assert.deepEqual(schedules(e), canonical);
    }
    // After a reset, only the reviews that follow it count.
    a.resetCards([id(a)]);
    for (const days of [0, 2, 12]) a.rate(id(a), 3, { at: new Date(Date.now() + 60_000 + days * DAY) });
    for (const e of [a, b]) await syncFor(e).now();
    for (const e of [a, b]) {
      const canonical = schedules(e);
      e.reschedule();
      assert.deepEqual(schedules(e), canonical);
      assert.equal(canonical[0].reps, 3);
    }
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the first sync after the replay changed rebuilds every card once", async () => {
  const { VERSION } = await import("../src/core/sync/project.ts");
  const { muted } = await import("../src/core/sync/log.ts");
  const dir = temp();
  const [e] = await devices(dir, 1);
  try {
    for (let i = 0; i < 8; i++) e.upsertItem({ id: `item-${i}`, deck: "Fuzz", type: "basic", fields: { front: `q ${i}`, back: "a" } });
    const ids = e.db.all("SELECT id FROM cards ORDER BY id").map((r) => r.id as number);
    const start = Date.now() - 120 * DAY;
    for (const day of [0, 3, 20, 60]) ids.forEach((id) => e.rate(id, 3, { at: new Date(start + day * DAY) }));
    await syncFor(e).now();
    const fuzzed = schedules(e);
    // What projection version 1 left: unfuzzed schedules, saved as canonical.
    e.db.tx(() => muted(e.db, () => {
      for (const c of e.db.all("SELECT c.*, i.created FROM cards c JOIN items i ON i.id = c.item_id")) {
        const history = e.db.all("SELECT ts, rating FROM reviews WHERE card_id = ? ORDER BY ts", c.id) as { ts: string; rating: number }[];
        const s = { ...sched.replay(history, new Date(c.created), { ...DEFAULT_PRESET, enableFuzz: false }, sched.cardKey(c as CardRow)), sched_state: null };
        e.db.run("UPDATE cards SET state=?, due=?, stability=?, difficulty=?, elapsed_days=?, scheduled_days=?, reps=?, lapses=?, learning_steps=?, last_review=? WHERE id=?", s.state, s.due, s.stability, s.difficulty, s.elapsed_days, s.scheduled_days, s.reps, s.lapses, s.learning_steps, s.last_review, c.id);
        e.db.run("UPDATE sync_replay SET row = ? WHERE card = ?", JSON.stringify(s), c.sync_id);
      }
      e.db.run("UPDATE sync_meta SET value = replace(value, ?, '\"[1,') WHERE key = 'projection'", `"[${VERSION},`);
    }));
    assert.notDeepEqual(schedules(e), fuzzed);
    await syncFor(e).now();
    assert.deepEqual(schedules(e), fuzzed);
  } finally {
    e.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a scheduler script's random draws differ between cards and stay put through sync", async () => {
  const { runSchedule } = await import("../src/core/schedulers.ts");
  await (await import("../src/core/sandbox.ts")).initSandbox();
  const def = { id: "spread", name: "Spread", schedule: "return { due: Date.now() + Math.floor(Math.random() * 30) * 86400000, state: { r: Math.random() } };" } as any;
  const run = (key?: string) => runSchedule(def, { state: null, reps: 2, due: "2027-01-01T00:00:00.000Z", lastReview: null, created: "2027-01-01T00:00:00.000Z" }, { rating: 3, score: null, verdict: null, details: null, ms: null, at: "2027-01-05T00:00:00.000Z" }, {}, { now: "2027-01-05T00:00:00.000Z", day: [], doneToday: 0, history: [] }, key);
  assert.deepEqual(run('["a","main"]'), run('["a","main"]'), "the same card and review draw the same");
  assert.notDeepEqual(run('["a","main"]'), run('["b","main"]'), "another card draws differently");
  const dir = temp();
  const [a, b] = await devices(dir, 2);
  try {
    a.saveScheduler({ id: "spread", name: "Spread", schedule: def.schedule });
    a.ensureDeck("Scripted");
    a.updateDeck("Scripted", { config: { scheduler: "spread" } });
    for (let i = 0; i < 20; i++) a.upsertItem({ id: `s-${i}`, deck: "Scripted", type: "basic", fields: { front: `q ${i}`, back: "a" } });
    const at = new Date(Date.now() - 10 * DAY);
    for (const c of a.db.all("SELECT id FROM cards")) a.rate(c.id as number, 3, { at });
    const rated = schedules(a);
    assert.ok(new Set(rated.map((r) => r.due)).size > 10, "cards answered together come back on different days");
    await syncFor(a).now();
    await syncFor(b).now();
    assert.deepEqual(schedules(a), rated);
    assert.deepEqual(schedules(b), rated);
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
