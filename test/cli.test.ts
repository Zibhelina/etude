import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli/run.ts";
import { COMMANDS } from "../src/cli/registry.ts";

const MAIN = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));

function home() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-cli-"));
  return dir;
}

/** Runs the CLI in-process against a temp home. Returns exit code, parsed stdout and stderr. */
function cli(dir: string) {
  return async (args: string[], stdin = "") => {
    let out = "", err = "";
    const code = await run(args, {
      stdout: (s) => (out += s),
      stderr: (s) => (err += s),
      stdin: () => stdin,
      isTTY: false,
      env: { ETUDE_HOME: dir },
    });
    let json: any = null;
    try {
      json = JSON.parse(out);
    } catch {}
    let error: any = null;
    try {
      error = JSON.parse(err);
    } catch {}
    return { code, out, json, err, error };
  };
}

const ok = (r: { code: number; err: string }) => assert.equal(r.code, 0, r.err);

test("help, catalog and unknown commands", async () => {
  const e = cli(home());
  const top = await e(["--help"]);
  ok(top);
  assert.match(top.out, /Groups:/);
  for (const g of ["deck", "preset", "item", "card", "tag", "type", "study", "stats", "settings", "pack", "db"]) {
    const h = await e([g, "--help"]);
    ok(h);
    assert.match(h.out, new RegExp(`etude ${g}`));
  }
  const ch = await e(["card", "due", "--help"]);
  ok(ch);
  assert.match(ch.out, /--date/);
  assert.match(ch.out, /supports --dry-run/);

  const cat = await e(["commands"]);
  ok(cat);
  assert.equal(cat.json.etude, "cli/1");
  assert.ok(cat.json.commands.length >= 80);
  const due = cat.json.commands.find((c: any) => c.name === "card due");
  assert.equal(due.writes, true);
  assert.equal(due.dryRun, true);
  assert.ok(due.flags.some((f: any) => f.name === "--in" && f.type === "string"));
  assert.ok(cat.json.exitCodes.some((c: any) => c.code === "not_found" && c.exit === 3));
  // Every command documents itself.
  for (const c of COMMANDS) assert.ok(c.summary, c.name);

  const bad = await e(["frobnicate"]);
  assert.equal(bad.code, 2);
  assert.equal(bad.error.code, "usage");
  const badFlag = await e(["deck", "list", "--nope"]);
  assert.equal(badFlag.code, 2);
});

test("decks, presets, settings inheritance and reset to inherited", async () => {
  const e = cli(home());
  ok(await e(["preset", "create", "exam", "--name", "Exam", "desiredRetention=0.92", "newPerDay=50", "deadline=2026-12-01T16:00:00Z"]));
  const dup = await e(["preset", "create", "exam"]);
  assert.equal(dup.code, 5);
  assert.equal(dup.error.code, "conflict");

  const c = await e(["deck", "create", "Course::Unit 1", "--preset", "exam", "--instructions", "Units matter."]);
  ok(c);
  assert.equal(c.json.deck.resolved.newPerDay, 50);
  ok(await e(["deck", "create", "Course"]));
  ok(await e(["deck", "set", "Course", "newPerDay=10", "learningSteps=1m 5m"]));
  // The child's preset wins over the parent's own override for newPerDay.
  let s = await e(["deck", "show", "Course::Unit 1"]);
  assert.equal(s.json.resolved.newPerDay, 50);
  assert.deepEqual(s.json.resolved.learningSteps, ["1m", "5m"]);
  assert.equal(s.json.sources.newPerDay.kind, "preset");
  assert.equal(s.json.sources.learningSteps.kind, "parent");

  ok(await e(["deck", "set", "Course::Unit 1", "newPerDay=7", "autoRate.good=0.8"]));
  s = await e(["deck", "show", "Course::Unit 1"]);
  assert.equal(s.json.resolved.newPerDay, 7);
  assert.deepEqual(s.json.resolved.autoRate, { good: 0.8, hard: 0.5 });
  assert.equal(s.json.sources.newPerDay.kind, "deck");
  const un = await e(["deck", "unset", "Course::Unit 1", "newPerDay"]);
  ok(un);
  assert.deepEqual(un.json.removed, ["newPerDay"]);
  s = await e(["deck", "show", "Course::Unit 1"]);
  assert.equal(s.json.resolved.newPerDay, 50);

  const bad = await e(["deck", "set", "Course", "desiredRetention=2"]);
  assert.equal(bad.code, 4);
  const unknownKey = await e(["deck", "set", "Course", "colour=red"]);
  assert.equal(unknownKey.code, 4);

  // Preset from deck, applied.
  const pf = await e(["preset", "create", "course", "--from-deck", "Course", "--apply"]);
  ok(pf);
  assert.equal(pf.json.preset.config.newPerDay, 10);
  s = await e(["deck", "show", "Course"]);
  assert.equal(s.json.presetId, "course");
  assert.deepEqual(s.json.config, {});
  assert.equal(s.json.resolved.newPerDay, 10);

  const inUse = await e(["preset", "delete", "exam", "--yes"]);
  assert.equal(inUse.code, 5);
  ok(await e(["deck", "preset", "Course::Unit 1", "none"]));
  const noYes = await e(["preset", "delete", "exam"]);
  assert.equal(noYes.code, 2);
  ok(await e(["preset", "delete", "exam", "--yes"]));
  assert.equal((await e(["preset", "show", "exam"])).code, 3);

  // Save to preset: the preset changes and the deck's colliding override goes away.
  ok(await e(["deck", "set", "Course", "newPerDay=12"]));
  const tp = await e(["deck", "set", "Course", "newPerDay=15", "--to-preset"]);
  ok(tp);
  assert.equal(tp.json.presetConfig.newPerDay, 15);
  assert.deepEqual(tp.json.removedOverrides, ["newPerDay"]);
  assert.equal((await e(["deck", "show", "Course"])).json.sources.newPerDay.kind, "preset");
  const child = await e(["deck", "set", "Course::Unit 1", "newPerDay=1", "--to-preset"]);
  assert.equal(child.code, 4);
  assert.match(child.error.error, /uses preset "course"/);
  ok(await e(["deck", "unset", "Course::Unit 1", "--all"]));

  ok(await e(["preset", "rename", "course", "Course defaults"]));
  assert.equal((await e(["preset", "show", "course"])).json.name, "Course defaults");
  assert.deepEqual((await e(["preset", "decks", "course"])).json, [{ deck: "Course", archived: false }]);

  // Description from stdin, instructions from a file.
  ok(await e(["deck", "description", "Course", "-"], "# About\nnotes"));
  assert.equal((await e(["deck", "description", "Course"])).json.description, "# About\nnotes");

  // Rename with subdecks, archive, delete.
  const mv = await e(["deck", "rename", "Course", "School::Course"]);
  ok(mv);
  assert.deepEqual(mv.json.decks.map((d: any) => d.to), ["School::Course", "School::Course::Unit 1"]);
  ok(await e(["deck", "archive", "School::Course", "--subdecks"]));
  const list = await e(["deck", "list"]);
  assert.ok(!list.json.some((d: any) => d.name.startsWith("School::Course")));
  assert.ok((await e(["deck", "list", "--archived"])).json.some((d: any) => d.name === "School::Course" && d.archived));
  ok(await e(["deck", "unarchive", "School::Course", "--subdecks"]));
  const del = await e(["deck", "delete", "School", "--yes"]);
  ok(del);
  assert.equal((await e(["deck", "show", "School"])).code, 3);
});

test("items: add from flags, files and stdin; edit; bulk ops; delete needs --yes", async () => {
  const dir = home();
  const e = cli(dir);
  const add = await e(["item", "add", "--deck", "Spanish", "--front", "el perro", "--back", "the dog", "-t", "vocab,animals"]);
  ok(add);
  assert.equal(add.json.result, "created");
  assert.equal(add.json.item.id, "spanish.el-perro");
  assert.deepEqual(add.json.item.tags, ["vocab", "animals"]);

  // Idempotent with the same content; conflict with different content unless --upsert.
  const again = await e(["item", "add", "--deck", "Spanish", "--id", "spanish.el-perro", "--front", "el perro", "--back", "the dog", "-t", "vocab", "-t", "animals"]);
  ok(again);
  assert.equal(again.json.result, "unchanged");
  const clash = await e(["item", "add", "--deck", "Spanish", "--id", "spanish.el-perro", "--front", "el gato", "--back", "the cat"]);
  assert.equal(clash.code, 5);
  ok(await e(["item", "add", "--deck", "Spanish", "--id", "spanish.el-perro", "--front", "el perro", "--back", "the dog!", "--upsert"]));

  // Numbers are coerced by field kind; bad numbers are rejected.
  const num = await e(["item", "add", "--type", "numeric", "--deck", "Net", "--id", "n.1", "--prompt", "1000 B at 10 Mbps, ms?", "--answer", "0.8", "--unit", "ms"]);
  ok(num);
  assert.equal((await e(["item", "show", "n.1"])).json.fields.answer, 0.8);
  assert.equal((await e(["item", "add", "--type", "numeric", "--deck", "Net", "--id", "n.bad", "--prompt", "x", "--answer", "lots"])).code, 4);
  assert.equal((await e(["item", "add", "--type", "numeric", "--deck", "Net", "--id", "n.bad", "--prompt", "x", "--colour", "red"])).code, 2);
  assert.equal((await e(["item", "add", "--type", "nope", "--deck", "Net", "--prompt", "x"])).code, 3);

  // Fields from a JSON file, a markdown file and stdin.
  writeFileSync(join(dir, "mcq.json"), JSON.stringify({ prompt: "Edge device?", options: [{ text: "laptop", correct: true }, { text: "core router" }] }));
  ok(await e(["item", "add", "--type", "mcq", "--deck", "Net", "--id", "n.mcq", "--fields-file", join(dir, "mcq.json")]));
  writeFileSync(join(dir, "ref.md"), "Axial **tilt**.\n");
  const free = await e(["item", "add", "--type", "free", "--deck", "Net", "--id", "n.free", "--prompt", "-", "--reference-file", join(dir, "ref.md")], "Why seasons?");
  ok(free);
  const fshow = await e(["item", "show", "n.free"]);
  assert.equal(fshow.json.fields.prompt, "Why seasons?");
  assert.equal(fshow.json.fields.reference, "Axial **tilt**.\n");
  ok(await e(["item", "add", "--type", "typed", "--deck", "Net", "--id", "n.typed", "--prompt", "PDU?", "--answers", "-"], '["segment"]'));
  assert.deepEqual((await e(["item", "show", "n.typed"])).json.fields.answers, ["segment"]);

  // Edit: --set with JSON values, --unset, tags.
  const ed = await e(["item", "edit", "n.1", "--set", "answer=1.2", "--set", "tags=[\"a\",\"b\"]", "--unset", "unit"]);
  ok(ed);
  assert.deepEqual(ed.json.changed.sort(), ["fields.answer", "fields.unit", "tags"]);
  const after = await e(["item", "show", "n.1"]);
  assert.equal(after.json.fields.answer, 1.2);
  assert.equal(after.json.fields.unit, undefined);
  assert.deepEqual(after.json.tags, ["a", "b"]);

  // Dry run changes nothing.
  const dry = await e(["item", "edit", "n.1", "--set", "answer=99", "--dry-run"]);
  ok(dry);
  assert.equal(dry.json.dryRun, true);
  assert.equal((await e(["item", "show", "n.1"])).json.fields.answer, 1.2);

  // Bulk by query and by stdin ids.
  ok(await e(["item", "tag", "--query", "deck:Net type:numeric", "-t", "math"]));
  assert.deepEqual((await e(["item", "show", "n.1"])).json.tags, ["a", "b", "math"]);
  ok(await e(["item", "untag", "-", "-t", "a"], "n.1\n"));
  assert.deepEqual((await e(["item", "show", "n.1"])).json.tags, ["b", "math"]);
  const mv = await e(["item", "move", "n.mcq", "n.typed", "--to", "Net::Intro"]);
  ok(mv);
  assert.equal(mv.json.count, 2);
  const ids = await e(["item", "list", "deck:Net::Intro", "--ids"]);
  assert.deepEqual(ids.out.trim().split("\n").sort(), ["n.mcq", "n.typed"]);

  // Archive hides from lists; unarchive restores.
  ok(await e(["item", "archive", "n.typed"]));
  assert.equal((await e(["item", "list", "deck:Net::Intro"])).json.total, 1);
  ok(await e(["item", "unarchive", "--query", "id:n.typed"]));
  assert.equal((await e(["item", "list", "deck:Net::Intro"])).json.total, 2);

  // Duplicate, preview, variants.
  const dupl = await e(["item", "duplicate", "n.1"]);
  ok(dupl);
  assert.equal(dupl.json.id, "n.1-2");
  const pv = await e(["item", "preview", "n.mcq", "--seed", "3"]);
  ok(pv);
  assert.equal(pv.json.key, undefined);
  assert.ok(!JSON.stringify(pv.json.view).includes("correct"));
  assert.ok((await e(["item", "preview", "n.mcq", "--with-key"])).json.key.correct);
  ok(await e(["item", "add", "--type", "numeric", "--deck", "Net", "--id", "n.gen", "--prompt", "x", "--answer", "1", "--generator", "const a = rng.int(1, 50); return { prompt: `${a} + 1?`, answer: a + 1 };"]));
  const vars = await e(["item", "variants", "n.gen", "-n", "8"]);
  ok(vars);
  assert.equal(vars.json.variants.length, 8);
  assert.ok(vars.json.distinct > 1);

  // Delete requires --yes; missing ids are not found.
  assert.equal((await e(["item", "delete", "n.1-2"])).code, 2);
  ok(await e(["item", "delete", "n.1-2", "--yes"]));
  const gone = await e(["item", "show", "n.1-2"]);
  assert.equal(gone.code, 3);
  assert.equal(gone.error.code, "not_found");
  assert.equal((await e(["item", "archive", "nope.1"])).code, 3);
});

test("cards: suspend, bury, reset, due dates, intervals, reschedule", async () => {
  const e = cli(home());
  ok(await e(["deck", "create", "D"]));
  for (let i = 1; i <= 3; i++) ok(await e(["item", "add", "--deck", "D", "--id", `d.${i}`, "--front", `q${i}`, "--back", `a${i}`]));
  const cardOf = async (id: string) => (await e(["item", "show", id])).json.cards[0].id as number;
  const c1 = await cardOf("d.1");

  assert.equal((await e(["study", "counts", "--deck", "D"])).json.new, 3);
  ok(await e(["card", "suspend", "d.1"]));
  assert.equal((await e(["study", "counts", "--deck", "D"])).json.new, 2);
  assert.deepEqual((await e(["card", "list", "is:suspended", "--ids"])).out.trim(), String(c1));
  ok(await e(["card", "unsuspend", "-"], `${c1}\n`));

  ok(await e(["card", "bury", "d.2"]));
  assert.equal((await e(["study", "counts", "--deck", "D"])).json.new, 2);
  ok(await e(["card", "unbury", "d.2"]));
  assert.equal((await e(["study", "counts", "--deck", "D"])).json.new, 3);

  // A new card pushed to a later date waits.
  const due = await e(["card", "due", "d.3", "--in", "2d"]);
  ok(due);
  assert.equal((await e(["study", "counts", "--deck", "D"])).json.new, 2);
  assert.equal((await e(["card", "show", "d.3"])).json.stateName, "new");
  ok(await e(["card", "due", "d.3", "--now"]));
  assert.equal((await e(["study", "counts", "--deck", "D"])).json.new, 3);

  // A review card keeps stability when its date moves.
  ok(await e(["study", "rate", "d.1", "easy"]));
  const before = (await e(["card", "show", "d.1"])).json;
  assert.equal(before.stateName, "review");
  const moved = await e(["card", "due", String(c1), "--date", "2030-01-15"]);
  ok(moved);
  const afterMove = (await e(["card", "show", "d.1"])).json;
  assert.equal(afterMove.stability, before.stability);
  assert.equal(afterMove.difficulty, before.difficulty);
  assert.equal(new Date(afterMove.due).getFullYear(), 2030);
  assert.equal(new Date(afterMove.due).getDate(), 15);
  const dry = await e(["card", "due", "d.1", "--now", "--dry-run"]);
  ok(dry);
  assert.equal((await e(["card", "show", "d.1"])).json.due, afterMove.due);
  assert.equal((await e(["card", "due", "d.1"])).code, 2);
  assert.equal((await e(["card", "due", "d.1", "--in", "soon"])).code, 4);

  const iv = await e(["card", "intervals", "d.2"]);
  ok(iv);
  assert.deepEqual(Object.keys(iv.json.intervals), ["again", "hard", "good", "easy"]);
  assert.ok(new Date(iv.json.intervals.easy.due) > new Date(iv.json.intervals.again.due));

  ok(await e(["card", "reset", "d.1"]));
  assert.equal((await e(["card", "show", "d.1"])).json.stateName, "new");
  const rs = await e(["card", "reschedule", "--deck", "D"]);
  ok(rs);
  assert.equal(rs.json.rescheduled, 1);
  assert.equal((await e(["card", "show", "d.1"])).json.stateName, "review");
});

test("study: next, submit, rate, answer, undo; private fields stay hidden", async () => {
  const e = cli(home());
  ok(await e(["deck", "create", "S", "--set", "newPerDay=100"]));
  ok(await e(["item", "add", "--type", "numeric", "--deck", "S", "--id", "s.num", "--prompt", "2+2?", "--answer", "4", "--explanation", "secret working"]));
  ok(await e(["item", "add", "--type", "typed", "--deck", "S", "--id", "s.typed", "--prompt", "Capital of France?", "--answers", '["Paris"]']));
  ok(await e(["item", "add", "--deck", "S", "--id", "s.basic", "--front", "front", "--back", "hidden back"]));

  const n = await e(["study", "next", "--deck", "S"]);
  ok(n);
  assert.equal(n.json.card.itemId, "s.num");
  assert.ok(!JSON.stringify(n.json.card).includes("secret working"));
  assert.ok(n.json.card.answerFormat.includes("JSON array"));
  const { cardId, seed } = n.json.card;

  const sub = await e(["study", "submit", String(cardId), "--seed", String(seed), "--answer", '["4"]']);
  ok(sub);
  assert.equal(sub.json.grade.verdict, "correct");
  assert.equal(sub.json.suggested.name, "good");
  assert.equal(sub.json.key.explanation, "secret working");
  const rate = await e(["study", "rate", String(cardId), "good", "--attempt", String(sub.json.attemptId)]);
  ok(rate);
  assert.equal(rate.json.state, "learning");
  const twice = await e(["study", "rate", String(cardId), "good", "--attempt", String(sub.json.attemptId)]);
  assert.equal(twice.code, 5);
  assert.equal((await e(["study", "rate", String(cardId), "great"])).code, 4);
  assert.equal((await e(["study", "submit", String(cardId), "--answer", "4"])).code, 2);

  // Answer from stdin, rated automatically.
  const a = await e(["study", "answer", "s.typed", "--seed", "1", "--answer", "-"], "paris\n");
  ok(a);
  assert.equal(a.json.grade.verdict, "correct");
  assert.equal(a.json.rated.rating, "good");

  // Wrong answer gets "again".
  const wrong = await e(["study", "answer", "s.num", "--seed", "2", "--answer", '["5"]', "--practice"]);
  ok(wrong);
  assert.equal(wrong.json.rated.rating, "again");

  // Self-graded: no rating applied, a hint instead.
  const self = await e(["study", "answer", "s.basic", "--seed", "1", "--answer", ""]);
  ok(self);
  assert.equal(self.json.rated, null);
  assert.equal(self.json.needsRating, true);
  assert.equal(self.json.key.back, "hidden back");
  ok(await e(["study", "rate", "s.basic", "3", "--attempt", String(self.json.attemptId)]));

  const card = await e(["study", "card", "s.num", "--seed", "9"]);
  ok(card);
  assert.equal(card.json.seed, 9);

  const counts = await e(["study", "counts", "--deck", "S"]);
  ok(counts);
  assert.ok(counts.json.doneToday >= 3);
  const undo = await e(["study", "undo"]);
  ok(undo);
  assert.equal(undo.json.undone.itemId, "s.basic");
  assert.equal((await e(["card", "show", "s.basic"])).json.stateName, "new");

  const fb = await e(["study", "feedback", "99999"]);
  assert.equal(fb.code, 3);

  // Answers stay as typed unless they are structured JSON; a one-blank cloze takes a bare string.
  ok(await e(["item", "add", "--type", "cloze", "--deck", "S", "--id", "s.cloze", "--text", "HTTP uses port {{80}}."]));
  const cz = await e(["study", "submit", "s.cloze", "--seed", "1", "--answer", "80", "--practice"]);
  ok(cz);
  assert.deepEqual(cz.json.answer, ["80"]);
  assert.equal(cz.json.grade.verdict, "correct");
  const verb = await e(["study", "submit", "s.basic", "--seed", "1", "--answer", "80", "--practice"]);
  assert.equal(verb.json.answer, "80");
  ok(await e(["item", "add", "--type", "cloze", "--deck", "S", "--id", "s.cloze2", "--text", "{{a}} and {{b}}"]));
  assert.equal((await e(["study", "submit", "s.cloze2", "--seed", "1", "--answer", "a b", "--practice"])).code, 4);
});

test("tags, types, stats and settings", async () => {
  const dir = home();
  const e = cli(dir);
  ok(await e(["item", "add", "--deck", "T", "--id", "t.1", "--front", "a", "--back", "b", "-t", "net::delay"]));
  ok(await e(["item", "add", "--deck", "T", "--id", "t.2", "--front", "c", "--back", "d", "-t", "net::intro"]));
  ok(await e(["tag", "instructions", "net::delay", "Accept ms or s."]));
  const tl = await e(["tag", "list"]);
  assert.deepEqual(tl.json.map((t: any) => t.tag), ["net::delay", "net::intro"]);
  const rn = await e(["tag", "rename", "net", "cs::net"]);
  ok(rn);
  assert.equal((await e(["tag", "instructions", "cs::net::delay"])).json.instructions, "Accept ms or s.");
  assert.equal((await e(["tag", "items", "cs::net", "--ids"])).out.trim().split("\n").length, 2);
  assert.equal((await e(["tag", "rename", "nothing", "x"])).code, 3);

  // Type scaffold, validate, preview, test-grade, import, use, delete.
  const tdir = join(dir, "vocab");
  ok(await e(["type", "new", "vocab", "-o", tdir]));
  assert.ok(existsSync(join(tdir, "type.json")));
  ok(await e(["type", "validate", tdir]));
  const pv = await e(["type", "preview", "--from", tdir, "--fields", '{"prompt":"saudade","answer":"longing"}']);
  ok(pv);
  assert.deepEqual(pv.json.view, { prompt: "saudade" });
  const tg = await e(["type", "test-grade", "--from", tdir, "--fields", '{"prompt":"saudade","answer":"longing"}', "--answer", "Longing."]);
  ok(tg);
  assert.equal(tg.json.grade.score, 1);
  const dry = await e(["type", "import", tdir, "--dry-run"]);
  ok(dry);
  assert.equal((await e(["type", "show", "vocab"])).code, 3);
  assert.equal((await e(["type", "import", tdir])).json.result, "created");
  assert.equal((await e(["type", "import", tdir])).json.result, "unchanged");
  ok(await e(["item", "add", "--type", "vocab", "--deck", "T", "--id", "t.v", "--prompt", "saudade", "--answer", "longing"]));
  assert.equal((await e(["type", "delete", "vocab", "--yes"])).code, 5);

  writeFileSync(join(tdir, "grade.js"), "return { score: ");
  const broken = await e(["type", "validate", tdir]);
  assert.equal(broken.code, 4);
  assert.equal(broken.json.ok, false);
  assert.equal((await e(["type", "import", tdir])).code, 4);

  const json = await e(["type", "export", "typed", "--json"]);
  ok(json);
  const copy = await e(["type", "import", "-", "--id", "typed2"], JSON.stringify(json.json));
  ok(copy);
  assert.equal(copy.json.result, "created");
  ok(await e(["type", "delete", "typed2", "--yes"]));
  const exp = await e(["type", "export", "numeric", "-o", join(dir, "numeric")]);
  ok(exp);
  assert.ok(exp.json.files.includes("grade.js"));

  // Edited built-in, then reset.
  const def = (await e(["type", "export", "basic", "--json"])).json;
  def.description = "Mine now";
  ok(await e(["type", "import", "-"], JSON.stringify(def)));
  assert.equal((await e(["type", "list"])).json.find((t: any) => t.id === "basic").edited, true);
  ok(await e(["type", "reset", "basic", "--yes"]));
  assert.equal((await e(["type", "list"])).json.find((t: any) => t.id === "basic").edited, false);

  const st = await e(["stats", "--deck", "T"]);
  ok(st);
  assert.equal(st.json.cards.total, 3);
  ok(await e(["stats", "forecast"]));
  ok(await e(["stats", "tags"]));
  ok(await e(["stats", "weak", "--lapses", "0"]));

  const set = await e(["settings", "set", "dayStartHour=5", "ai.feedback.model=x/y"]);
  ok(set);
  assert.equal((await e(["settings", "get", "dayStartHour"])).json.value, 5);
  assert.equal((await e(["settings", "set", "dayStartHour=30"])).code, 4);
  assert.equal((await e(["settings", "set", "ai.feedback.apiKey=sk-1"])).code, 4);
  ok(await e(["settings", "unset", "dayStartHour"]));
  assert.equal((await e(["settings", "get", "dayStartHour"])).json.value, 4);
  const all = await e(["settings"]);
  ok(all);
  assert.ok("keyStatus" in all.json);
});

test("packs: new, check, import (dry run, idempotent), export, round trip; db backup and check", async () => {
  const dir = home();
  const e = cli(dir);
  const pf = join(dir, "p.pack.json");
  ok(await e(["pack", "new", pf, "--deck", "Starter", "--prefix", "st"]));
  const chk = await e(["pack", "check", pf]);
  ok(chk);
  assert.equal(chk.json.files[0].items, 9);
  const dry = await e(["pack", "import", pf, "--dry-run"]);
  ok(dry);
  assert.equal(dry.json.reports[0].items.created, 9);
  assert.equal((await e(["item", "list"])).json.total, 0);
  assert.equal((await e(["pack", "import", pf])).json[0].items.created, 9);
  assert.equal((await e(["pack", "import", pf])).json[0].items.unchanged, 9);
  const viaStdin = await e(["pack", "import", "-"], readFileSync(pf, "utf8"));
  ok(viaStdin);

  const broken = JSON.parse(readFileSync(pf, "utf8"));
  broken.items[1].fields.answers = [];
  broken.items[2].fields.generator = "return { prompt: 'x', answer: NaN };";
  writeFileSync(join(dir, "bad.json"), JSON.stringify(broken));
  const bad = await e(["pack", "check", join(dir, "bad.json")]);
  assert.equal(bad.code, 4);
  assert.equal(bad.json.ok, false);
  assert.ok(bad.json.files[0].errors.length >= 2);

  const out = join(dir, "export.json");
  ok(await e(["pack", "export", "--deck", "Starter", "-o", out]));
  assert.equal((await e(["pack", "export", "--deck", "Starter", "-o", out])).code, 5);
  const other = home();
  const e2 = cli(other);
  const r = await e2(["pack", "import", out]);
  ok(r);
  assert.equal(r.json[0].items.created, 9);
  assert.equal((await e2(["deck", "show", "Starter"])).json.presetId, "st-default");

  const b = await e(["db", "backup"]);
  ok(b);
  assert.ok(existsSync(b.json.backup));
  const again = await e(["db", "backup", b.json.backup]);
  assert.equal(again.code, 5);
  const chkdb = await e(["db", "check"]);
  ok(chkdb);
  assert.equal(chkdb.json.ok, true);
  const info = await e(["db", "info"]);
  ok(info);
  assert.equal(info.json.schemaVersion, 1);
  assert.equal(info.json.journalMode, "wal");
  const p = await e(["db", "path"]);
  assert.equal(p.json.source, "ETUDE_HOME");

  // Restore needs --yes and brings back the backed-up content.
  ok(await e(["item", "delete", "--query", "deck:Starter", "--yes"]));
  assert.equal((await e(["item", "list"])).json.total, 0);
  ok(await e(["db", "restore", b.json.backup, "--yes"]));
  assert.equal((await e(["item", "list"])).json.total, 9);
});

test("old top-level commands still work", async () => {
  const dir = home();
  const e = cli(dir);
  writeFileSync(join(dir, "p.json"), JSON.stringify({ etude: "pack/1", items: [{ id: "x.1", type: "basic", deck: "X", fields: { front: "f", back: "b" } }] }));
  ok(await e(["import", join(dir, "p.json"), "--dry-run"]));
  ok(await e(["import", join(dir, "p.json")]));
  assert.equal((await e(["decks"])).json[0].deck, "X");
  assert.equal((await e(["search", "deck:X"])).json.total, 1);
  assert.equal((await e(["show", "x.1"])).json.id, "x.1");
  assert.equal((await e(["next", "--deck", "X"])).json.card.itemId, "x.1");
  ok(await e(["stats", "--deck", "X"]));
  ok(await e(["reschedule", "--deck", "X"]));
  ok(await e(["types"]));
  ok(await e(["export", "--q", "deck:X", "-o", join(dir, "e.json")]));
  assert.equal(JSON.parse(readFileSync(join(dir, "e.json"), "utf8")).items.length, 1);
  ok(await e(["type-export", "basic", "-o", join(dir, "basic")]));
  ok(await e(["type-import", join(dir, "basic")]));
});

test("subprocess: exit codes, stderr JSON, stdin, --db", () => {
  const dir = home();
  const db = join(dir, "sub.db");
  const sh = (args: string[], input = "") => spawnSync(process.execPath, [MAIN, "--db", db, ...args], { input, encoding: "utf8", env: { ...process.env, ETUDE_HOME: join(dir, "h") } });
  const a = sh(["item", "add", "--deck", "P", "--id", "p.1", "--front", "-", "--back", "b"], "front from stdin");
  assert.equal(a.status, 0, a.stderr);
  assert.equal(JSON.parse(a.stdout).result, "created");
  assert.ok(existsSync(db));
  const s = sh(["item", "show", "p.1"]);
  assert.equal(JSON.parse(s.stdout).fields.front, "front from stdin");
  const nf = sh(["item", "show", "nope"]);
  assert.equal(nf.status, 3);
  assert.equal(nf.stdout, "");
  assert.deepEqual(Object.keys(JSON.parse(nf.stderr)), ["error", "code"]);
  const usage = sh(["item", "delete", "p.1"]);
  assert.equal(usage.status, 2);
  const neg = sh(["deck", "set", "P", "deadlineMargin=-1"]);
  assert.equal(neg.status, 4);
  const pretty = sh(["deck", "list", "--pretty"]);
  assert.match(pretty.stdout, /^\[\n  \{/);
  const table = sh(["item", "list", "--format", "table"]);
  assert.match(table.stdout, /^id\s+type/);
  const where = sh(["db", "path"]);
  assert.equal(JSON.parse(where.stdout).source, "flag");

  // A real pipe between two processes: ids out of one, into the next.
  const ids = sh(["card", "list", "--ids"]).stdout;
  const piped = sh(["card", "suspend", "-", "--dry-run"], ids);
  assert.equal(piped.status, 0, piped.stderr);
  assert.equal(JSON.parse(piped.stdout).count, 1);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
});
