import { test } from "node:test";
import assert from "node:assert/strict";
import { Etude } from "../src/core/engine.ts";

const pack = {
  etude: "pack/1",
  presets: [{ id: "exam", name: "Exam", config: { desiredRetention: 0.92, newPerDay: 50 } }],
  decks: [{ name: "Net", preset: "exam", instructions: "Units must be right." }],
  tags: [{ name: "net::delay", instructions: "Accept ms or s if converted correctly." }],
  items: [
    { id: "n.basic", type: "basic", deck: "Net::Intro", tags: ["net::intro"], fields: { front: "What is a router?", back: "A packet switch at the network layer." } },
    { id: "n.typed", type: "typed", deck: "Net::Intro", fields: { prompt: "PDU at the transport layer?", answers: ["segment"] } },
    {
      id: "n.num",
      type: "numeric",
      deck: "Net::Delay",
      tags: ["net::delay"],
      fields: {
        prompt: "x",
        answer: 1,
        generator: "const L = rng.pick([1000, 2000]); const R = rng.pick([10, 100]); return { prompt: `${L} B on ${R} Mbps`, answer: L * 8 / (R * 1e6) * 1e3, unit: 'ms' };",
      },
    },
    { id: "n.parts", type: "numeric", deck: "Net::Delay", fields: { prompt: "two", parts: [{ label: "a", answer: 0.5, unit: "ms" }, { label: "b", answer: 10, unit: "ms" }] } },
    { id: "n.mcq", type: "mcq", deck: "Net::Intro", fields: { prompt: "Edge device?", options: [{ text: "laptop", correct: true }, { text: "core router" }, { text: "IXP switch" }] } },
    { id: "n.multi", type: "mcq", deck: "Net::Intro", fields: { prompt: "Which?", options: [{ text: "a", correct: true }, { text: "b", correct: true }, { text: "c" }] } },
    { id: "n.order", type: "order", deck: "Net::Layers", fields: { prompt: "Top to bottom", steps: ["application", "transport", "network", "link", "physical"] } },
    { id: "n.match", type: "match", deck: "Net::Layers", fields: { prompt: "PDU", pairs: [["transport", "segment"], ["network", "datagram"], ["link", "frame"]] } },
    { id: "n.cloze", type: "cloze", deck: "Net::Delay", fields: { text: "$d_{trans} = {{L}}/{{R}}$ and HTTP uses port {{80|eighty}}" } },
    { id: "n.free", type: "free", deck: "Net::Delay", fields: { prompt: "Why?", reference: "Because.", rubric: "Must say because." } },
  ],
};

async function setup() {
  const e = await Etude.open(":memory:");
  e.updateSettings({ ai: { decision: null, feedback: null, vision: null, autoFeedback: "never", language: "English" } });
  const r = e.importPack(pack);
  return { e, r };
}

const key = (e: Etude, itemId: string, seed: number) => e.prepare(itemId, "main", seed).key as any;
const cardOf = (e: Etude, itemId: string) => e.db.get("SELECT id FROM cards WHERE item_id = ?", itemId)!.id as number;

test("import is idempotent and keeps scheduling", async () => {
  const { e, r } = await setup();
  assert.equal(r.items.created, pack.items.length);
  const id = cardOf(e, "n.basic");
  e.rate(id, 3);
  const before = e.db.get("SELECT * FROM cards WHERE id = ?", id);
  const again = e.importPack(pack);
  assert.equal(again.items.unchanged, pack.items.length);
  const edited = structuredClone(pack);
  edited.items[0].fields.back = "Changed.";
  const r3 = e.importPack(edited);
  assert.equal(r3.items.updated, 1);
  assert.deepEqual(e.db.get("SELECT * FROM cards WHERE id = ?", id), before);
});

test("presets cascade through the deck tree", async () => {
  const { e } = await setup();
  assert.equal(e.configFor("Net::Delay").desiredRetention, 0.92);
  e.updateDeck("Net::Delay", { config: { desiredRetention: 0.95 } });
  assert.equal(e.configFor("Net::Delay").desiredRetention, 0.95);
  assert.equal(e.configFor("Net::Intro").desiredRetention, 0.92);
});

test("script graders", async () => {
  const { e } = await setup();
  const t = cardOf(e, "n.typed");
  assert.equal((await e.submit(t, 1, "  Segment. ")).grade.score, 1);
  assert.equal((await e.submit(t, 1, "datagram")).grade.score, 0);

  const n = cardOf(e, "n.num");
  for (const seed of [1, 2, 3, 4, 5]) {
    const k = key(e, "n.num", seed);
    const right = await e.submit(n, seed, [String(k.parts[0].answer)]);
    assert.equal(right.grade.score, 1, `seed ${seed}`);
    const wrong = await e.submit(n, seed, [String(k.parts[0].answer * 8)]);
    assert.equal(wrong.grade.score, 0);
  }
  const p = cardOf(e, "n.parts");
  const half = await e.submit(p, 1, ["1/2", "11"]);
  assert.equal(half.grade.score, 0.5);
  assert.equal(half.grade.verdict, "partial");
  assert.equal((await e.submit(p, 1, ["5e-1 ms", "10"])).grade.score, 1);

  const m = cardOf(e, "n.mcq");
  const mk = key(e, "n.mcq", 7);
  assert.equal((await e.submit(m, 7, mk.correct)).grade.score, 1);
  assert.equal((await e.submit(m, 7, ["o1"])).grade.score, 0);
  const mm = cardOf(e, "n.multi");
  assert.equal((await e.submit(mm, 1, ["o0", "o1"])).grade.score, 1);
  assert.equal((await e.submit(mm, 1, ["o0"])).grade.score, 0.5);

  const o = cardOf(e, "n.order");
  assert.equal((await e.submit(o, 3, ["s0", "s1", "s2", "s3", "s4"])).grade.score, 1);
  const swapped = await e.submit(o, 3, ["s1", "s0", "s2", "s3", "s4"]);
  assert.ok(swapped.grade.score! < 1 && swapped.grade.score! >= 0.8);

  const ma = cardOf(e, "n.match");
  assert.equal((await e.submit(ma, 2, { l0: "r0", l1: "r1", l2: "r2" })).grade.score, 1);
  assert.equal((await e.submit(ma, 2, { l0: "r1", l1: "r0", l2: "r2" })).grade.score, 1 / 3);

  const c = cardOf(e, "n.cloze");
  assert.equal((await e.submit(c, 1, ["L", "r", "Eighty"])).grade.score, 1);
  assert.equal((await e.submit(c, 1, ["L", "x", "80"])).grade.score, 2 / 3);
});

test("generated items vary by seed and replay exactly", async () => {
  const { e } = await setup();
  const prompts = new Set<string>();
  for (let s = 1; s <= 40; s++) prompts.add(e.prepare("n.num", "main", s).view.prompt as string);
  assert.ok(prompts.size >= 3);
  assert.deepEqual(e.prepare("n.num", "main", 9), e.prepare("n.num", "main", 9));
  // Private fields never reach the view.
  const v = e.prepare("n.mcq", "main", 1).view as any;
  assert.ok(v.options.every((o: any) => !("correct" in o)));
  assert.ok(!("answers" in e.prepare("n.typed", "main", 1).view));
});

test("AI grading failure falls back to self-rating, not an error", async () => {
  const { e } = await setup();
  const r = await e.submit(cardOf(e, "n.free"), 1, "because");
  assert.equal(r.grade.verdict, "ungraded");
  assert.ok(r.grade.grader.error);
});

test("study queue, rating, undo", async () => {
  const { e } = await setup();
  const first = e.next({ deck: "Net" });
  assert.ok(first.card);
  assert.equal(first.counts.new, pack.items.length);
  e.rate(first.card!.cardId, 3);
  const after = e.db.get("SELECT state, due FROM cards WHERE id = ?", first.card!.cardId)!;
  assert.equal(after.state, 1);
  assert.equal(e.counts({ deck: "Net" }).new, pack.items.length - 1);
  const u = e.undo();
  assert.equal(u!.cardId, first.card!.cardId);
  assert.equal(e.db.get("SELECT state FROM cards WHERE id = ?", first.card!.cardId)!.state, 0);
  // Easy on a new card graduates it out of today's queue.
  e.rate(first.card!.cardId, 4);
  const n2 = e.next({ deck: "Net" }, { exclude: first.card!.cardId });
  assert.notEqual(n2.card!.cardId, first.card!.cardId);
});

test("exam deadline caps intervals", async () => {
  const { e } = await setup();
  const deadline = new Date(Date.now() + 3 * 86400_000).toISOString();
  e.savePreset({ id: "exam", name: "Exam", config: { desiredRetention: 0.92, deadline, deadlineMargin: 12 } });
  const id = cardOf(e, "n.basic");
  e.rate(id, 4);
  const due = new Date(e.db.get("SELECT due FROM cards WHERE id = ?", id)!.due);
  assert.ok(due < new Date(deadline), `due ${due.toISOString()} should be before ${deadline}`);
});

test("search language", async () => {
  const { e } = await setup();
  assert.equal(e.search("deck:Net").total, pack.items.length);
  assert.equal(e.search("deck:Net::Delay").total, 4);
  assert.equal(e.search("tag:net").total, 2);
  assert.equal(e.search("type:mcq OR type:order").total, 3);
  assert.equal(e.search("deck:Net -type:mcq").total, pack.items.length - 2);
  assert.equal(e.search("is:new").total, pack.items.length);
  assert.equal(e.search('"core router"').total, 1);
  assert.throws(() => e.search("bogus:1"));
});

test("custom types: save, validate, use", async () => {
  const { e } = await setup();
  e.saveType({
    id: "port",
    name: "Port number",
    fields: [{ name: "service", kind: "text", required: true }, { name: "port", kind: "number", required: true, private: true }],
    template: { html: "<p>Port for {{service}}?</p><input id=a>", js: "etude.getAnswer(() => etude.$('#a').value)" },
    grader: { kind: "script", code: "return { score: Number(answer) === key.port ? 1 : 0 };" },
  });
  e.upsertItem({ id: "n.port", type: "port", deck: "Net", fields: { service: "HTTP", port: 80 } });
  const id = cardOf(e, "n.port");
  assert.equal((await e.submit(id, 1, "80")).grade.score, 1);
  assert.throws(() => e.saveType({ id: "Bad Id", name: "", fields: [], template: { html: "" }, grader: { kind: "self" } } as any));
  assert.throws(() => e.saveType({ id: "broken", name: "b", fields: [], template: { html: "x" }, grader: { kind: "script", code: "return {" } }));
  const exported = e.exportPack({ deck: "Net" });
  assert.equal(exported.types.length, 1);
  assert.equal(exported.items.length, pack.items.length + 1);
  const e2 = await Etude.open(":memory:");
  e2.importPack(exported);
  assert.equal(e2.search("").total, pack.items.length + 1);
});

test("runaway scripts are stopped", async () => {
  const { e } = await setup();
  assert.throws(() => e.upsertItem({ id: "n.loop", type: "numeric", deck: "Net", fields: { prompt: "x", answer: 1, generator: "while (true) {}" } }), /timed out/);
});
