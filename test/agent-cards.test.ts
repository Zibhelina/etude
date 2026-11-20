// Agent cards (Settings → AI → Agents): Minimi's brain from the old default model, the card's own entry in this
// device's ai.agents behind Hermes and other agents (created, updated and removed with the card), the CLI's
// brain shortcuts (--hermes, --provider/--model/--effort), sync, and the guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { agentFor } from "../src/core/agent.ts";
import { pickToBrain, viaOf } from "../src/core/agent-profiles.ts";
import { agentRefusal } from "../src/core/agent-guard.ts";
import { syncFor } from "../src/core/sync/client.ts";
import { parseInvocation, run } from "../src/cli/run.ts";

const temp = (p = "etude-cards-") => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), p));
async function open(home?: string) {
  const dir = temp();
  const e = await Etude.open(join(dir, "etude.db"), { home: home ?? dir });
  return { dir, e, done: () => (e.close(), rmSync(dir, { recursive: true, force: true })) };
}
const io = (out: string[], dir: string) => ({ stdout: (s: string) => out.push(s), stderr: (s: string) => out.push(s), stdin: () => "", isTTY: false, env: { ...process.env, ETUDE_HOME: dir } });
const HERMES = (p: string) => ({ command: "hermes", args: ["-p", p, "acp"] });

test("cards: Minimi's brain is the old default model (and effort) until he has his own", async () => {
  const { e, done } = await open();
  try {
    // Data from before agents had brains: the default model and effort lived in ai.agent.
    e.db.setSetting("settings", { ...e.db.setting("settings", {}), ai: { ...e.settings().ai, agent: { model: "openrouter:x/y", effort: "medium" } } });
    assert.deepEqual(e.settings().agentProfiles[0].brain, { kind: "model", model: "openrouter:x/y", effort: "medium" });
    assert.deepEqual(e.agentProfiles().profiles[0].brain, { kind: "model", model: "openrouter:x/y", effort: "medium" });
    // ai.agent stays readable as it was.
    assert.deepEqual(e.settings().ai.agent, { model: "openrouter:x/y", effort: "medium" });
    // A brain of his own wins over the old setting.
    e.setAgentBrain("minimi", { kind: "model", model: "chatgpt:gpt-6", effort: "low" });
    assert.deepEqual(e.settings().agentProfiles[0].brain, { kind: "model", model: "chatgpt:gpt-6", effort: "low" });

    // An old default that was an external agent isn't a model: Minimi keeps the default.
    const two = await open();
    try {
      two.e.db.setSetting("settings", { ai: { ...two.e.settings().ai, agent: { model: "agent:coach", effort: "low" } } });
      assert.deepEqual(two.e.settings().agentProfiles[0].brain, { kind: "model", model: null });
    } finally {
      two.done();
    }
  } finally {
    done();
  }
});

test("cards: Hermes and other agents get the card's own ai.agents entry, kept in step with the card", async () => {
  const { e, done } = await open();
  try {
    // An entry no card uses (set by hand) stays whatever the cards do.
    e.updateSettings({ ai: { ...e.settings().ai, agents: [{ id: "mine", name: "Mine", command: "my-agent", args: [] }] } });
    const coach = e.addAgentProfile({ name: "Coach", personality: "Notes." });
    assert.deepEqual(coach.brain, { kind: "model", model: null });
    const agents = () => e.settings().ai.agents ?? [];

    // Hermes: the profile keeps which kind it is and the Hermes profile; the command is the device's entry.
    let p = e.setAgentBrain("coach", { kind: "hermes", profile: "coach" });
    assert.deepEqual(p.brain, { kind: "external", agent: "coach", via: "hermes", hermes: "coach" });
    assert.deepEqual(
      agents().map((a) => [a.id, a.name, a.command, a.args]),
      [
        ["mine", "Mine", "my-agent", []],
        ["coach", "Coach", ...Object.values(HERMES("coach"))],
      ]
    );
    const view = agentFor(e)
      .profiles()
      .profiles.find((x) => x.id === "coach")!;
    assert.equal(view.available, true);
    assert.deepEqual(view.setup, { ...HERMES("coach"), via: "hermes" });

    // Another Hermes profile updates the same entry; a new name follows into it.
    e.setAgentBrain("coach", { kind: "hermes", profile: "coach-l1" });
    assert.deepEqual(agents().find((a) => a.id === "coach")!.args, ["-p", "coach-l1", "acp"]);
    assert.equal(agents().length, 2);
    e.editAgentProfile("coach", { name: "Coachy" });
    assert.equal(agents().find((a) => a.id === "coach")!.name, "Coachy");

    // A model brain: the entry goes. Back to Hermes: it comes back.
    p = e.setAgentBrain("coach", { kind: "model", model: "openrouter:a/b", effort: "high" });
    assert.deepEqual(p.brain, { kind: "model", model: "openrouter:a/b", effort: "high" });
    assert.deepEqual(
      agents().map((a) => a.id),
      ["mine"]
    );
    e.setAgentBrain("coach", { kind: "hermes", profile: "coach" });
    assert.deepEqual(
      agents().map((a) => a.id),
      ["mine", "coach"]
    );

    // Other agents: a preset, or a custom command with its environment.
    p = e.setAgentBrain("coach", { kind: "agent", preset: "gemini" });
    assert.deepEqual(p.brain, { kind: "external", agent: "coach", via: "gemini" });
    assert.deepEqual(agents().find((a) => a.id === "coach")!.command, "gemini");
    e.setAgentBrain("coach", { kind: "agent", preset: "custom", command: "my-acp", args: ["--stdio"], env: { TOKEN: "x" } });
    const custom = agents().find((a) => a.id === "coach")!;
    assert.deepEqual([custom.command, custom.args, custom.env], ["my-acp", ["--stdio"], { TOKEN: "x" }]);
    assert.equal(viaOf(custom), "custom");
    assert.throws(() => e.setAgentBrain("coach", { kind: "agent", preset: "custom", command: "  " }), /needs its command/);
    assert.throws(() => e.setAgentBrain("coach", { kind: "hermes", profile: "../evil" }), /Hermes profile/);
    assert.throws(() => e.setAgentBrain("coach", { kind: "model", model: "agent:x" }), /external agent/);
    assert.throws(() => e.setAgentBrain("coach", { kind: "model", model: "openrouter:a", effort: "max" }), /effort/);

    // Duplicating an agent's card gives the copy its own entry; removing a card takes its entry away.
    e.setAgentBrain("coach", { kind: "hermes", profile: "coach" });
    const copy = e.duplicateAgentProfile("coach", "Coach two");
    assert.equal(copy.brain.kind === "external" && copy.brain.agent, copy.id);
    assert.deepEqual(
      agents().map((a) => a.id),
      ["mine", "coach", copy.id]
    );
    e.removeAgentProfile(copy.id);
    e.removeAgentProfile("coach");
    assert.deepEqual(
      agents().map((a) => a.id),
      ["mine"]
    );
  } finally {
    done();
  }
});

test("cards: picks are checked before anything is saved", () => {
  assert.deepEqual(pickToBrain("x", "X", { kind: "hermes", profile: "" }).agent?.args, ["-p", "default", "acp"]);
  assert.equal(pickToBrain("x", "X", { kind: "model", model: null }).agent, null);
  assert.throws(() => pickToBrain("x", "X", { kind: "agent", preset: "hermes" }), /gemini, claude, codex or custom/);
  assert.throws(() => pickToBrain("x", "X", { kind: "nope" }), /model, hermes or agent/);
  assert.throws(() => pickToBrain("x", "X", null), /brain must be/);
});

test("cards CLI: --hermes and --provider/--model/--effort map to the card's brain", async () => {
  const { dir, e, done } = await open();
  try {
    const cli = async (...args: string[]) => {
      const out: string[] = [];
      const code = await run(["--db", e.path, ...args], io(out, dir));
      return { code, json: code === 0 ? JSON.parse(out.join("")) : out.join("") };
    };
    let r = await cli("agents", "add", "Coach", "--hermes", "coach", "--dry-run");
    assert.equal(r.code, 0, String(r.json));
    assert.ok(!e.agentProfiles().profiles.some((p) => p.id === "coach") && !(e.settings().ai.agents ?? []).length, "--dry-run saves neither the card nor its entry");

    r = await cli("agents", "add", "Coach", "--hermes", "coach", "--personality", "Notes.");
    assert.equal(r.code, 0, String(r.json));
    assert.deepEqual(r.json.brain, { kind: "external", agent: "coach", via: "hermes", hermes: "coach" });
    assert.deepEqual(r.json.setup, { ...HERMES("coach"), via: "hermes" });
    assert.equal(r.json.available, true);

    r = await cli("agents", "edit", "coach", "--provider", "openrouter", "--model", "a/b", "--effort", "high");
    assert.deepEqual(r.json.brain, { kind: "model", model: "openrouter:a/b", effort: "high" });
    assert.deepEqual(e.settings().ai.agents, [], "the Hermes entry went with the Hermes brain");
    r = await cli("agents", "edit", "coach", "--effort", "low");
    assert.deepEqual(r.json.brain, { kind: "model", model: "openrouter:a/b", effort: "low" }, "--effort alone keeps the model");
    r = await cli("agents", "edit", "coach", "--model", "chatgpt:gpt-6", "--name", "Coachy");
    assert.deepEqual([r.json.name, r.json.brain], ["Coachy", { kind: "model", model: "chatgpt:gpt-6", effort: "low" }]);
    r = await cli("agents", "edit", "coach", "--hermes", "coach");
    assert.deepEqual(r.json.brain, { kind: "external", agent: "coach", via: "hermes", hermes: "coach" });
    assert.equal(e.settings().ai.agents?.[0].name, "Coachy");

    for (const bad of [
      ["--provider", "bogus", "--model", "x"],
      ["--provider", "openrouter"],
      ["--hermes", "coach", "--model", "chatgpt:x"],
      ["--effort", "max"],
      ["--hermes", "../x"],
    ]) {
      assert.notEqual((await cli("agents", "edit", "coach", ...bad)).code, 0, bad.join(" "));
    }
  } finally {
    done();
  }
});

test("cards guard: Ask Etude and etude mcp can't set a brain or the entry behind it", async (t) => {
  for (const argv of [
    ["agents", "edit", "coach", "--hermes", "evil"],
    ["agents", "add", "Evil", "--provider", "openrouter", "--model", "x"],
    ["agents", "edit", "minimi", "--effort", "high"],
  ]) {
    const inv = parseInvocation(argv)!;
    assert.match(agentRefusal({ cmd: inv.cmd, values: inv.values, named: inv.named, attachmentDir: tmpdir() }) ?? "", /only be changed by the user/, argv.join(" "));
  }
  const dir = temp("etude-cards-guard-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "etude.db");
  const err: string[] = [];
  for (const opts of [{ agent: true }, { mcp: true }]) {
    assert.notEqual(await run(["--db", db, "agents", "add", "Evil", "--hermes", "evil"], io(err, dir), opts), 0);
    assert.notEqual(await run(["--db", db, "agents", "edit", "minimi", "--provider", "openrouter", "--model", "x"], io(err, dir), opts), 0);
    assert.notEqual(await run(["--db", db, "settings", "set", 'ai.agents=[{"id":"minimi","name":"x","command":"sh","args":[]}]'], io(err, dir), opts), 0);
  }
  const e = await Etude.open(db, { home: dir });
  try {
    assert.deepEqual(
      e.agentProfiles().profiles.map((p) => [p.id, p.brain]),
      [["minimi", { kind: "model", model: null }]]
    );
    assert.deepEqual(e.settings().ai.agents ?? [], []);
  } finally {
    e.close();
  }
});

test("cards sync: the brain's kind and Hermes profile travel, the entry doesn't; set it up on the other device", async () => {
  const dir = temp("sync-cards-");
  for (const d of ["a", "b"]) mkdirSync(join(dir, d));
  const a = await Etude.open(join(dir, "a", "a.db"), { home: join(dir, "ha") });
  const b = await Etude.open(join(dir, "b", "b.db"), { home: join(dir, "hb") });
  try {
    const folder = join(dir, "shared");
    for (const e of [a, b]) {
      syncFor(e).setup({ folder });
      await syncFor(e).unlock({ password: "a test Sync password" });
    }
    a.addAgentProfile({ name: "Coach" });
    a.setAgentBrain("coach", { kind: "hermes", profile: "coach" });
    await syncFor(a).now({ waitMedia: true });
    await syncFor(b).now({ waitMedia: true });
    const there = b.settings().agentProfiles.find((p) => p.id === "coach")!;
    assert.deepEqual(there.brain, { kind: "external", agent: "coach", via: "hermes", hermes: "coach" });
    assert.deepEqual(b.settings().ai.agents, []);
    const view = agentFor(b)
      .profiles()
      .profiles.find((p) => p.id === "coach")!;
    assert.deepEqual([view.available, view.note], [false, "Runs on the computer where it's set up"]);
    // "Set it up here" is the same pick again on this device.
    b.setAgentBrain("coach", { kind: "hermes", profile: there.brain.kind === "external" ? there.brain.hermes! : "" });
    assert.equal(
      agentFor(b)
        .profiles()
        .profiles.find((p) => p.id === "coach")!.available,
      true
    );
    assert.deepEqual(
      b.settings().ai.agents?.map((x) => x.args),
      [["-p", "coach", "acp"]]
    );
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cards: Hermes on this computer is found on PATH, its profiles from ~/.hermes/profiles", async (t) => {
  const dir = temp("etude-hermes-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  const home = join(dir, "hermes");
  for (const d of [bin, join(home, "profiles", "coach"), join(home, "profiles", "bob"), join(home, "profiles", ".deleted")]) mkdirSync(d, { recursive: true });
  const { writeFileSync, chmodSync } = await import("node:fs");
  writeFileSync(join(bin, "hermes"), "#!/bin/sh\n");
  chmodSync(join(bin, "hermes"), 0o755);
  writeFileSync(join(bin, "codex-acp"), "#!/bin/sh\n");
  chmodSync(join(bin, "codex-acp"), 0o755);
  const old = { PATH: process.env.PATH, HERMES_HOME: process.env.HERMES_HOME };
  t.after(() => {
    process.env.PATH = old.PATH;
    if (old.HERMES_HOME === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = old.HERMES_HOME;
  });
  const { e, done } = await open();
  t.after(done);
  process.env.HERMES_HOME = home;
  process.env.PATH = bin;
  assert.deepEqual(agentFor(e).hermes(), {
    installed: true,
    available: true,
    profiles: ["default", "bob", "coach"],
    presets: { hermes: true, antigravity: false, claude: false, codex: true, gemini: false },
  });
  // Started from inside a Hermes profile (HERMES_HOME is that profile's folder): the same list.
  process.env.HERMES_HOME = join(home, "profiles", "coach");
  assert.deepEqual(agentFor(e).hermes().profiles, ["default", "bob", "coach"]);
  process.env.PATH = join(dir, "nothing");
  assert.equal(agentFor(e).hermes().installed, false);
});
