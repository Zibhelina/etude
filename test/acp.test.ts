import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { agentFor, type AgentEvent, type AssistantContent } from "../src/core/agent.ts";
import { runningAgents } from "../src/core/acp.ts";
import { ACP_PRESETS, checkAgents, freeAgentId } from "../src/core/acp-agents.ts";
import { agentRefusal, agentsSettingRefusal } from "../src/core/agent-guard.ts";
import { run, parseInvocation } from "../src/cli/run.ts";

afterEach(() => {
  for (const c of runningAgents()) c.close();
});

const FAKE = join(import.meta.dirname, "fixtures", "fake-acp-agent.mjs");

/** A chat with an external agent: a profile whose brain is `agent`, then a conversation with it. */
function chat(e: Etude, a: ReturnType<typeof agentFor>, agent: string) {
  const id = `p-${agent}`;
  if (!e.agentProfiles().profiles.some((p) => p.id === id)) e.addAgentProfile({ id, name: agent, brain: { kind: "external", agent } });
  return a.createConversation(null, id);
}

async function setup(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-acp-"));
  const e = await Etude.open(join(dir, "etude.db"), { home: dir });
  const log = join(dir, "agent.jsonl");
  e.updateSettings({ ai: { ...e.settings().ai, agents: [{ id: "fake", name: "Fakey", command: process.execPath, args: [FAKE], env: { FAKE_ACP_LOG: log, ...env } }] } });
  const a = agentFor(e);
  const received = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { dir, e, a, received };
}

function alive(pid: number | undefined) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

test("acp: initialize, session/new with the etude MCP server, streamed text, one process reused", async () => {
  const { e, a, received } = await setup();
  const m = await a.models(false);
  assert.ok(!m.groups.some((x) => x.provider === "agent"), "agents are profiles' brains, not models");

  const conv = chat(e, a, "fake");
  const events: AgentEvent[] = [];
  const msg = await a.send(conv.id, { text: "hello", page: "/deck?name=Spanish" }, (ev) => events.push(ev));
  const c = msg.content as AssistantContent;
  assert.equal(c.text, "Hello!");
  assert.equal(c.model, "Fakey");
  assert.equal(c.modelRef, "agent:fake");
  assert.deepEqual(events.filter((x) => x.type === "text").map((x: any) => x.delta), ["Hel", "lo!"]);

  const got = received();
  const init = got.find((x) => x.method === "initialize");
  assert.equal(init.params.protocolVersion, 1);
  assert.deepEqual(init.params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  const sn = got.find((x) => x.method === "session/new");
  assert.equal(sn.params.mcpServers.length, 1);
  const mcp = sn.params.mcpServers[0];
  assert.equal(mcp.name, "etude_app");
  assert.equal(mcp.command, process.execPath);
  assert.equal(mcp.args.at(-1), "mcp");
  assert.ok(mcp.args[0].endsWith(join("bin", "etude.js")));
  assert.deepEqual(mcp.env.find((v: any) => v.name === "ETUDE_DB"), { name: "ETUDE_DB", value: e.path });
  const pr = got.find((x) => x.method === "session/prompt");
  assert.match(pr.params.prompt[0].text, /<etude-context>[\s\S]*deck "Spanish"/);
  assert.deepEqual(pr.params.prompt[1], { type: "text", text: "hello" });
  assert.equal(a.conversation(conv.id).acpSession, sn.params.mcpServers && pr.params.sessionId);
  assert.ok(!pr.params.prompt[0].text.includes("<user-notes>"), "no notes without a personality");

  // The profile's personality reaches the agent as the user's notes, inside the context block.
  e.editAgentProfile("p-fake", { personality: "Call me Sam. Short answers." });

  // A second message reuses the process and the session.
  const pid = runningAgents()[0]?.pid;
  await a.send(conv.id, { text: "again" });
  assert.equal(received().filter((x) => x.method === "initialize").length, 1);
  assert.equal(received().filter((x) => x.method === "session/new").length, 1);
  assert.equal(runningAgents()[0]?.pid, pid);
  const second = received().filter((x) => x.method === "session/prompt")[1];
  assert.match(second.params.prompt[0].text, /<etude-context>[\s\S]*notes for you as "fake"[\s\S]*<user-notes>\nCall me Sam\. Short answers\.\n<\/user-notes>\n<\/etude-context>/);
  e.close();
  assert.ok(await waitFor(() => !alive(pid)), "the agent stops when the collection closes");
});

test("acp: tool calls and their updates become tool steps; plans show as a step", async () => {
  const { e, a } = await setup();
  const conv = chat(e, a, "fake");
  const events: AgentEvent[] = [];
  const msg = await a.send(conv.id, { text: "tool" }, (ev) => events.push(ev));
  const c = msg.content as AssistantContent;
  const tool = c.items.find((i) => i.type === "tool") as any;
  assert.equal(tool.label, "Listing decks");
  assert.equal(tool.status, "done");
  assert.equal(tool.output, "3 decks");
  assert.equal(tool.writes, undefined, "a read step doesn't count as a write");
  assert.deepEqual(events.filter((x) => x.type === "tool_start" || x.type === "tool_end").map((x) => x.type), ["tool_start", "tool_end"]);
  assert.equal(c.text, "You have 3 decks.");
  assert.equal(c.changed, false);

  const p = (await a.send(conv.id, { text: "plan" })).content as AssistantContent;
  const plan = p.items.find((i) => i.type === "tool") as any;
  assert.equal(plan.label, "plan · 2 steps");
  assert.equal(plan.output, "[x] Look\n[ ] Make");
  e.close();
});

test("acp: a permission request shows the agent's options; allow and deny go back as the chosen optionId", async () => {
  const { e, a, received } = await setup();
  const conv = chat(e, a, "fake");
  for (const [choice, expect] of [
    ["yes", "allowed:yes"],
    ["no", "denied"],
  ] as const) {
    let waiting: any = null;
    let turnId = "";
    const done = a.send(conv.id, { text: "ask" }, (ev) => {
      if (ev.type === "start") turnId = ev.turnId;
      if (ev.type === "confirm") waiting = ev.item;
    });
    assert.ok(await waitFor(() => !!waiting));
    assert.deepEqual(waiting.options.map((o: any) => o.id), ["yes", "always", "no"]);
    assert.equal(waiting.status, "waiting");
    assert.match(waiting.summary, /Fakey wants to run Delete deck Old/);
    assert.match(waiting.preview, /"deck": "Old"/);
    assert.equal(a.confirm(turnId, waiting.id, true, "not-an-option"), false, "only the offered options");
    assert.ok(a.confirm(turnId, waiting.id, choice === "yes", choice));
    const c = (await done).content as AssistantContent;
    assert.equal(c.text, expect);
    const step = c.items.find((i) => i.type === "tool") as any;
    assert.equal(step.chose, choice === "yes" ? "Allow once" : "Reject");
    assert.equal(step.options, undefined);
  }
  const outcomes = received().filter((x) => x.permission).map((x) => x.permission.outcome);
  assert.deepEqual(outcomes, [{ outcome: "selected", optionId: "yes" }, { outcome: "selected", optionId: "no" }]);

  // The CLI without --yes denies, with --yes allows, without asking.
  const deny = (await a.send(conv.id, { text: "ask", autoConfirm: "deny" })).content as AssistantContent;
  assert.equal(deny.text, "denied");
  const allow = (await a.send(conv.id, { text: "ask", autoConfirm: true })).content as AssistantContent;
  assert.equal(allow.text, "allowed:yes");
  e.close();
});

test("acp: Steer hands words to the running turn through the agent's /steer; they land in the reply where they came", async () => {
  const { e, a, received } = await setup();
  const conv = chat(e, a, "fake");
  let turnId = "";
  const events: AgentEvent[] = [];
  const done = a.send(conv.id, { text: "work" }, (ev) => {
    if (ev.type === "start") turnId = ev.turnId;
    events.push(ev);
  });
  assert.ok(await waitFor(() => events.some((x) => x.type === "text")));
  assert.equal(await a.steer(turnId, "   "), false, "nothing to say");
  assert.equal(await a.steer(turnId, "use the blue one"), true);
  const c = (await done).content as AssistantContent;
  assert.deepEqual(c.items.map((i) => i.type), ["tool", "text", "steer", "text"]);
  assert.equal((c.items[2] as any).text, "use the blue one");
  assert.equal((c.items[3] as any).text, "Changed course: use the blue one");
  assert.ok(!c.text.includes("Steer queued"), "the agent's own receipt isn't part of the reply");
  assert.ok(events.some((x) => x.type === "steer" && x.text === "use the blue one"));
  assert.equal(received().filter((x) => x.method === "session/prompt").at(-1).params.prompt[0].text, "/steer use the blue one");
  assert.equal(await a.steer(turnId, "too late"), false, "the turn is over");
  // Saved with the reply, so a reload shows it in place.
  const saved = a.conversation(conv.id).messages.at(-1)!.content as AssistantContent;
  assert.ok(saved.items.some((i) => i.type === "steer"));
  e.close();
});

test("acp: a steer answered after the reply was done shows each answer once, and the saved reply keeps both apart", async () => {
  const { e, a } = await setup();
  const conv = chat(e, a, "fake");
  let turnId = "";
  const events: AgentEvent[] = [];
  const done = a.send(conv.id, { text: "late" }, (ev) => {
    if (ev.type === "start") turnId = ev.turnId;
    events.push(ev);
  });
  assert.ok(await waitFor(() => events.some((x) => x.type === "text")));
  assert.equal(await a.steer(turnId, "the cat"), true);
  const c = (await done).content as AssistantContent;
  assert.deepEqual(c.items.map((i) => i.type), ["tool", "text", "steer", "thought", "text"]);
  assert.equal((c.items[4] as any).text, "Second answer, about the cat.");
  assert.equal(c.text, "First answer.\n\nSecond answer, about the cat.");
  const streamed = events.flatMap((x) => (x.type === "text" ? [x.delta] : [])).join("");
  assert.equal(streamed.split("Second answer").length, 2, "the follow-up's answer streams once");
  e.close();
});

test("acp: a file sent with Steer goes to the agent as its path, and shows in the reply", async () => {
  const { e, a, received } = await setup();
  const conv = chat(e, a, "fake");
  let turnId = "";
  const events: AgentEvent[] = [];
  const done = a.send(conv.id, { text: "work" }, (ev) => {
    if (ev.type === "start") turnId = ev.turnId;
    events.push(ev);
  });
  assert.ok(await waitFor(() => events.some((x) => x.type === "text")));
  const pic = a.addAttachment(conv.id, "look.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  assert.equal(await a.steer(turnId, "this one", [pic.id]), true);
  const c = (await done).content as AssistantContent;
  const s = c.items.find((i) => i.type === "steer") as any;
  assert.equal(s.text, "this one");
  assert.equal(s.attachments[0].name, "look.png");
  const said = received().filter((x) => x.method === "session/prompt").at(-1).params.prompt[0].text as string;
  assert.match(said, /^\/steer this one\n\nAttached; open them from these paths:\n- look\.png \(image\): (?:\/|[A-Za-z]:\\).+\.png$/);
  e.close();
});

test("acp: an agent without /steer can't be steered; the turn runs on untouched", async () => {
  const { e, a, received } = await setup({ FAKE_ACP_STEER: "0" });
  const conv = chat(e, a, "fake");
  let turnId = "";
  let working = false;
  const done = a.send(conv.id, { text: "wait" }, (ev) => {
    if (ev.type === "start") turnId = ev.turnId;
    if (ev.type === "text") working = true;
  });
  assert.ok(await waitFor(() => working));
  assert.equal(await a.steer(turnId, "hello?"), false);
  assert.equal(received().filter((x) => x.method === "session/prompt").length, 1, "nothing was sent to it");
  a.stop(turnId);
  await done;
  e.close();
});

test("acp permissions: ask shows every request, dangerous lets plain edits through, allow lets everything through", async () => {
  const { e, a, received } = await setup();
  const conv = chat(e, a, "fake");
  assert.equal(a.permission(), "dangerous", "the default");
  assert.throws(() => a.setPermission("yolo"), /ask, dangerous, allow/);
  /** Runs a prompt; a request that reaches the user is noted and answered yes. */
  const turn = async (text: string) => {
    let asked = false;
    let turnId = "";
    const done = a.send(conv.id, { text }, (ev) => {
      if (ev.type === "start") turnId = ev.turnId;
      if (ev.type === "confirm") {
        asked = true;
        const id = ev.item.id;
        setTimeout(() => a.confirm(turnId, id, true, "yes"), 0);
      }
    });
    return { text: ((await done).content as AssistantContent).text, asked };
  };

  assert.deepEqual(await turn("edit /home/me/notes/plan.md"), { text: "edited", asked: false }, "dangerous: an ordinary edit isn't asked");
  assert.deepEqual(await turn("edit /home/me/app/.env"), { text: "edited", asked: true }, "dangerous: a sensitive file is");
  assert.deepEqual(await turn("edit /home/me/app/.git/config"), { text: "edited", asked: true });
  assert.deepEqual(await turn("ask"), { text: "allowed:yes", asked: true }, "dangerous: a delete is");

  a.setPermission("ask");
  assert.deepEqual(await turn("edit /home/me/notes/plan.md"), { text: "edited", asked: true }, "ask: everything the agent asks reaches the user");

  a.setPermission("allow");
  assert.deepEqual(await turn("edit /home/me/app/.env"), { text: "edited", asked: false });
  assert.deepEqual(await turn("ask"), { text: "allowed:yes", asked: false }, "allow: nothing is asked");
  assert.equal(received().filter((x) => x.permission).every((x) => x.permission.outcome.outcome === "selected"), true);

  // It's the user's setting: kept across restarts of the agent object, and out of the assistant's reach.
  assert.equal(agentFor(e).permission(), "allow");
  const inv = parseInvocation(["agents", "permission", "ask"])!;
  assert.match(agentRefusal({ cmd: inv.cmd, values: inv.values, named: inv.named, attachmentDir: tmpdir() }) ?? "", /only the user/);
  // …while the user's own CLI reads and sets it.
  let out = "";
  assert.equal(await run(["agents", "permission", "dangerous"], { stdout: (x) => (out += x), stderr: () => {}, stdin: () => "", isTTY: false, env: process.env }, { etude: e }), 0);
  assert.equal(JSON.parse(out).permission, "dangerous");
  assert.equal(a.permission(), "dangerous");
  e.close();
});

test("acp: Stop sends session/cancel, answers a waiting permission as cancelled, and the reply is saved as stopped", async () => {
  const { e, a, received } = await setup();
  const conv = chat(e, a, "fake");
  let turnId = "";
  let working = false;
  const done = a.send(conv.id, { text: "wait" }, (ev) => {
    if (ev.type === "start") turnId = ev.turnId;
    if (ev.type === "text") working = true;
  });
  assert.ok(await waitFor(() => working));
  assert.ok(a.stop(turnId));
  const c = (await done).content as AssistantContent;
  assert.equal(c.stopped, true);
  assert.ok(received().some((x) => x.method === "session/cancel"));
  assert.equal((c.items.find((i) => i.type === "tool") as any).status, "denied");

  let waiting = false;
  const asked = a.send(conv.id, { text: "ask" }, (ev) => {
    if (ev.type === "start") turnId = ev.turnId;
    if (ev.type === "confirm") waiting = true;
  });
  assert.ok(await waitFor(() => waiting));
  a.stop(turnId);
  assert.equal(((await asked).content as AssistantContent).stopped, true);
  assert.deepEqual(received().filter((x) => x.permission).at(-1).permission.outcome, { outcome: "cancelled" });
  e.close();
});

test("acp: the agent edits the open collection through etude mcp; the reply can be undone", async () => {
  const { e, a } = await setup();
  const conv = chat(e, a, "fake");
  const events: AgentEvent[] = [];
  const msg = await a.send(conv.id, { text: "mcp ACP smoke" }, (ev) => events.push(ev));
  const c = msg.content as AssistantContent;
  assert.equal(c.text, "made it", JSON.stringify(c.items));
  assert.ok(events.some((x) => x.type === "changed"));
  assert.equal(c.changed, true);
  assert.ok(msg.canUndo);
  assert.ok(e.db.get("SELECT 1 FROM decks WHERE name = 'ACP smoke'"));
  a.undo(conv.id, msg.id);
  assert.equal(e.db.get("SELECT 1 FROM decks WHERE name = 'ACP smoke'"), undefined);
  e.close();
});

test("acp: a reply that only read gets no Undo, even when etude mcp commits planner statistics", async () => {
  const { e, a } = await setup();
  for (let i = 0; i < 30; i++) e.db.run("INSERT INTO meta (key, value) VALUES (?, 'x')", `probe-${i}`);
  // Stale statistics: the next collection opened by etude mcp runs ANALYZE, a commit that changes nothing the user has.
  e.db.sql.exec("ANALYZE; DELETE FROM sqlite_stat1 WHERE tbl = 'meta'");
  const conv = chat(e, a, "fake");
  const before = Number(e.db.get("SELECT data_version AS v FROM pragma_data_version")!.v);
  const events: AgentEvent[] = [];
  const msg = await a.send(conv.id, { text: "mcpread" }, (ev) => events.push(ev));
  const c = msg.content as AssistantContent;
  assert.equal(c.text, "listed", JSON.stringify(c.items));
  assert.notEqual(Number(e.db.get("SELECT data_version AS v FROM pragma_data_version")!.v), before, "the read moved data_version (the case this guards)");
  assert.ok(e.db.get("SELECT 1 FROM sqlite_stat1 WHERE tbl = 'meta'"), "etude mcp analyzed meta");
  assert.ok(!events.some((x) => x.type === "changed"));
  assert.equal(c.changed, false);
  assert.equal(msg.canUndo, false);
  // A turn that does write in the same chat still gets Undo, and Undo brings the collection back.
  const made = await a.send(conv.id, { text: "mcp Real deck" });
  assert.equal((made.content as AssistantContent).changed, true);
  assert.ok(made.canUndo);
  assert.ok(e.db.get("SELECT 1 FROM decks WHERE name = 'Real deck'"));
  a.undo(conv.id, made.id);
  assert.equal(e.db.get("SELECT 1 FROM decks WHERE name = 'Real deck'"), undefined);
  e.close();
});

test("acp: an old chat reloads its session with session/load when the agent can, without replaying history", async () => {
  const { e, a, received } = await setup({ FAKE_ACP_LOAD: "1" });
  const conv = chat(e, a, "fake");
  await a.send(conv.id, { text: "hello" });
  const sid = a.conversation(conv.id).acpSession;
  a.closeAgents();
  const events: AgentEvent[] = [];
  const c = (await a.send(conv.id, { text: "hello" }, (ev) => events.push(ev))).content as AssistantContent;
  const load = received().find((x) => x.method === "session/load");
  assert.equal(load.params.sessionId, sid);
  assert.equal(c.text, "Hello!");
  assert.ok(!events.some((x: any) => x.type === "text" && /REPLAYED/.test(x.delta)));
  e.close();
});

test("acp: without loadSession an old chat starts fresh and says so in one line", async () => {
  const { e, a, received } = await setup();
  const conv = chat(e, a, "fake");
  await a.send(conv.id, { text: "hello" });
  const first = a.conversation(conv.id).acpSession;
  a.closeAgents();
  const c = (await a.send(conv.id, { text: "hello" })).content as AssistantContent;
  assert.equal(received().filter((x) => x.method === "session/load").length, 0);
  assert.notEqual(a.conversation(conv.id).acpSession, first);
  const note = c.items[0] as any;
  assert.equal(note.type, "text");
  assert.match(note.text, /new session/);
  assert.equal(c.text, "Hello!");
  e.close();
});

test("acp: the agent's own title wins over the configured name; a missing command fails plainly", async () => {
  const { e, a } = await setup({ FAKE_ACP_TITLE: "Tutor" });
  const conv = chat(e, a, "fake");
  const c = (await a.send(conv.id, { text: "hello" })).content as AssistantContent;
  assert.equal(c.model, "Tutor");
  assert.equal(a.profiles().profiles.find((p) => p.id === "p-fake")?.agentName, "Tutor");
  e.updateSettings({ ai: { ...e.settings().ai, agents: [{ id: "gone", name: "Gone", command: "etude-no-such-agent-xyz", args: [] }] } });
  const bad = chat(e, a, "gone");
  const r = (await a.send(bad.id, { text: "hi" })).content as AssistantContent;
  assert.match(r.error ?? "", /couldn't start "etude-no-such-agent-xyz": it isn't installed/);
  await assert.rejects(a.send(chat(e, a, "nope").id, { text: "hi" }), /runs on the computer where its agent "nope" is set up/);
  e.close();
});

test("acp: no agent processes are left once collections close", async () => {
  assert.ok(await waitFor(() => runningAgents().length === 0), `still running: ${runningAgents().map((c) => c.pid)}`);
});

test("acp settings: validation, presets and ids", () => {
  assert.deepEqual(checkAgents([{ id: "tutor", name: " Tutor ", command: "hermes", args: ["-p", "tutor", "acp"] }]), [{ id: "tutor", name: "Tutor", command: "hermes", args: ["-p", "tutor", "acp"] }]);
  assert.throws(() => checkAgents([{ id: "Bad Id", command: "x" }]), /id must be/);
  assert.throws(() => checkAgents([{ id: "a", command: "" }]), /command is empty/);
  assert.throws(() => checkAgents([{ id: "a", command: "x" }, { id: "a", command: "y" }]), /two agents/);
  assert.throws(() => checkAgents([{ id: "a", command: "x", args: "no" }]), /args must be/);
  assert.throws(() => checkAgents([{ id: "a", command: "x", env: { "1x": "y" } }]), /env must/);
  const hermes = ACP_PRESETS.find((p) => p.id === "hermes")!;
  assert.deepEqual(hermes.make({ profile: "tutor" }), { name: "Tutor", command: "hermes", args: ["-p", "tutor", "acp"], preset: "hermes" });
  assert.deepEqual(hermes.make().args, ["-p", "default", "acp"]);
  assert.equal(freeAgentId("Claude Code", ["claude-code"]), "claude-code-2");
});

test("acp guard: the assistant and etude mcp can never set ai.agents", async () => {
  for (const k of ["ai", "ai.agents", "ai.agents.0.command", "ai.agents[0]"]) assert.ok(agentsSettingRefusal(k), k);
  assert.equal(agentsSettingRefusal("ai.agent.model"), null);
  const inv = parseInvocation(["settings", "set", 'ai.agents=[{"id":"x","command":"sh"}]'])!;
  assert.match(agentRefusal({ cmd: inv.cmd, values: inv.values, named: inv.named, attachmentDir: tmpdir() }) ?? "", /ai\.agents/);

  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-acp-guard-"));
  const db = join(dir, "etude.db");
  const io = (out: string[]) => ({ stdout: (s: string) => out.push(s), stderr: (s: string) => out.push(s), stdin: () => "", isTTY: false, env: { ...process.env, ETUDE_HOME: dir } });
  const err: string[] = [];
  // In-process for the assistant, and for etude mcp:
  assert.notEqual(await run(["--db", db, "settings", "set", 'ai.agents=[{"id":"x","command":"sh"}]'], io(err), { agent: true }), 0);
  assert.notEqual(await run(["--db", db, "settings", "set", 'ai.agents=[{"id":"x","command":"sh"}]'], io(err), { mcp: true }), 0);
  assert.notEqual(await run(["--db", db, "settings", "unset", "ai"], io(err), { mcp: true }), 0);
  assert.match(err.join(""), /only be set by the user/);
  // etude mcp may still change other settings; the user's own CLI may set agents.
  assert.equal(await run(["--db", db, "settings", "set", "dayStartHour=5"], io([]), { mcp: true }), 0);
  assert.equal(await run(["--db", db, "settings", "set", 'ai.agents=[{"id":"x","name":"X","command":"sh"}]'], io([])), 0);
  const out: string[] = [];
  await run(["--db", db, "settings", "get", "ai.agents"], io(out));
  assert.deepEqual(JSON.parse(out.join("")).value, [{ id: "x", name: "X", command: "sh", args: [] }]);
});

test("acp: deleting a Hermes chat deletes its session in Hermes too; other agents and failures leave the chat deleted", async () => {
  const { dir, e, a } = await setup();
  // A stand-in `hermes`: `sessions delete` is logged (and fails for an id starting with "bad"), anything else is the ACP agent.
  const { writeFileSync } = await import("node:fs");
  const bin = join(dir, "bin");
  (await import("node:fs")).mkdirSync(bin);
  const dels = join(dir, "deletes.log");
  const hermesJs = join(bin, "hermes.mjs");
  writeFileSync(
    hermesJs,
    `import { appendFileSync } from "node:fs"; import { spawn } from "node:child_process";
const a = process.argv.slice(2);
if (a[2] === "sessions") {
  appendFileSync(${JSON.stringify(dels)}, a.join(" ") + "\\n");
  if ((a[5] || "").startsWith("bad")) { process.stderr.write("boom\\n"); process.exit(2); }
  process.stdout.write("Deleted session '" + a[5] + "'.\\n");
  process.exit(0);
}
const c = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(FAKE)}, ...a], { stdio: "inherit" });
c.on("exit", (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
`,
  );
  e.updateSettings({ ai: { ...e.settings().ai, agents: [...(e.settings().ai.agents ?? []), { id: "herm", name: "Herm", command: process.execPath, args: [hermesJs, "-p", "tutor", "acp"], preset: "hermes" }] } });

  const conv = chat(e, a, "herm");
  await a.send(conv.id, { text: "hello" }, () => {});
  const sid = a.conversation(conv.id).acpSession!;
  assert.ok(sid);
  const r = await a.deleteConversation(conv.id);
  assert.deepEqual(r, { deleted: conv.id, agentSession: { id: sid, deleted: true } });
  assert.equal(readFileSync(dels, "utf8").trim(), `-p tutor sessions delete --yes ${sid}`);
  assert.throws(() => a.conversation(conv.id));

  // The agent refuses: Etude's chat is gone all the same, and the answer says why.
  const c2 = chat(e, a, "herm");
  await a.send(c2.id, { text: "hello" }, () => {});
  (a as any).store.run("UPDATE agent_conversations SET acp_session = 'bad-1' WHERE id = ?", c2.id);
  const r2 = await a.deleteConversation(c2.id);
  assert.equal(r2.agentSession?.deleted, false);
  assert.match(r2.agentSession?.error ?? "", /boom/);
  assert.throws(() => a.conversation(c2.id));

  // An agent with no history of its own to delete: nothing is run.
  const c3 = chat(e, a, "fake");
  await a.send(c3.id, { text: "hello" }, () => {});
  assert.deepEqual(await a.deleteConversation(c3.id), { deleted: c3.id });
  assert.equal(readFileSync(dels, "utf8").trim().split("\n").length, 2);
  e.close();
});

test("acp harnesses: one profile, two harnesses; a chat picks one, switches mid-chat and the new one gets the earlier messages", async () => {
  const { dir, e, a, received } = await setup();
  const log2 = join(dir, "agent2.jsonl");
  const s = e.settings();
  e.updateSettings({ ai: { ...s.ai, agents: [...(s.ai.agents ?? []), { id: "fake2", name: "Fakey Two", command: process.execPath, args: [FAKE], env: { FAKE_ACP_LOG: log2 } }] } });
  e.addAgentProfile({ id: "pal", name: "Pal", brain: { kind: "external", agent: "fake" } });
  // Only the user's own commands set harnesses, and each must be an agent on this device.
  assert.throws(() => e.setAgentHarnesses("pal", [{ agent: "nope", name: "Nope" }]), /no agent "nope"/);
  e.setAgentHarnesses("pal", [{ agent: "fake", name: "Hermes" }, { agent: "fake2", name: "Antigravity" }]);

  // A new chat offers the harness picker first, on the profile's own agent.
  const before = await a.controls(null, "pal");
  assert.deepEqual(before.controls[0], { id: "harness", name: "Harness", category: "harness", currentValue: "fake", options: [{ value: "fake", name: "Hermes" }, { value: "fake2", name: "Antigravity" }] });
  assert.equal((await a.controls(null, "pal", false, "fake2")).controls[0].currentValue, "fake2");

  // Picked before the first message, it goes with that message.
  const conv = a.createConversation(null, "pal");
  await a.send(conv.id, { text: "hello", controls: { harness: "fake2" } });
  const received2 = () => readFileSync(log2, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(received2().filter((x) => x.method === "session/prompt").length, 1);
  assert.equal(received().filter((x) => x.method === "session/prompt").length, 0, "the first harness never got it");
  assert.equal(a.conversation(conv.id).model, "agent:fake2");

  // Switching mid-chat: the next message opens a session in the other harness, with the chat so far as text.
  const c = await a.setControl(conv.id, "harness", "fake");
  assert.equal(c.controls[0].currentValue, "fake");
  const reply = (await a.send(conv.id, { text: "still there?" })).content as AssistantContent;
  const p = received().find((x) => x.method === "session/prompt");
  const sent = p.params.prompt.map((b: any) => b.text ?? "").join("\n");
  assert.match(sent, /<earlier-in-this-chat>[\s\S]*User: hello[\s\S]*Pal: Hello!/);
  assert.match(sent, /still there\?/);
  assert.match((reply.items[0] as any).text, /new session/);
  await assert.rejects(a.setControl(conv.id, "harness", "nope"), /isn't one of Pal's harnesses/);

  // The profile's agent entries stay while a harness uses them.
  e.setAgentHarnesses("pal", []);
  assert.equal((await a.controls(null, "pal")).controls.some((x) => x.id === "harness"), false);

  // One-click harness toggle works across Hermes, Antigravity, Claude Code, Codex and Gemini CLI, adding/pruning entries.
  e.setAgentBrain("pal", { kind: "hermes", profile: "pal" });
  const toggled = e.toggleAgentHarness("pal", "antigravity", { enabled: true });
  assert.equal(toggled.brain.kind, "external");
  assert.deepEqual(
    (toggled.brain as any).harnesses.map((h: any) => h.name),
    ["Hermes", "Antigravity"],
  );
  const withClaude = e.toggleAgentHarness("pal", "claude", { enabled: true });
  const withCodex = e.toggleAgentHarness("pal", "codex", { enabled: true });
  assert.deepEqual(
    (withClaude.brain as any).harnesses.map((h: any) => h.name),
    ["Hermes", "Antigravity", "Claude Code"],
  );
  assert.deepEqual(
    (withCodex.brain as any).harnesses.map((h: any) => h.name),
    ["Hermes", "Antigravity", "Claude Code", "Codex"],
  );
  assert.ok(e.settings().ai.agents?.some((x) => x.command === "agy" && x.preset === "antigravity"));
  assert.ok(e.settings().ai.agents?.some((x) => x.command === "claude-agent-acp" && x.preset === "claude"));
  assert.ok(e.settings().ai.agents?.some((x) => x.command === "codex-acp" && x.preset === "codex"));
  e.toggleAgentHarness("pal", "antigravity", { enabled: false });
  e.toggleAgentHarness("pal", "claude", { enabled: false });
  const off = e.toggleAgentHarness("pal", "codex", { enabled: false });
  assert.equal((off.brain as any).harnesses, undefined);
  assert.equal(e.settings().ai.agents?.some((x) => x.command === "agy" || x.command === "claude-agent-acp" || x.command === "codex-acp"), false);

  // Starting from Claude Code as main brain, promoting Codex to default, and disabling the primary harness.
  e.setAgentBrain("pal", { kind: "agent", preset: "claude" });
  const ccCodex = e.toggleAgentHarness("pal", "codex", { enabled: true });
  assert.deepEqual(
    (ccCodex.brain as any).harnesses.map((h: any) => h.name),
    ["Claude Code", "Codex"],
  );
  assert.throws(() => e.toggleAgentHarness("pal", "claude", { enabled: true }), /already runs in Claude Code/);
  const promoted = e.setDefaultAgentHarness("pal", "codex");
  assert.equal((promoted.brain as any).via, "codex");
  assert.deepEqual(
    (promoted.brain as any).harnesses.map((h: any) => h.name),
    ["Codex", "Claude Code"],
  );
  const droppedDefault = e.toggleAgentHarness("pal", "codex", { enabled: false });
  assert.equal((droppedDefault.brain as any).via, "claude");
  assert.equal((droppedDefault.brain as any).harnesses, undefined);
  assert.throws(() => e.toggleAgentHarness("pal", "claude", { enabled: false }), /at least one harness/);
  e.close();
});

test("acp: trailing session/load replay updates are drained before the next prompt turn", async () => {
  const { e, a } = await setup({ FAKE_ACP_LOAD: "1", FAKE_ACP_LATE_REPLAY: "1" });
  const conv = chat(e, a, "fake");
  await a.send(conv.id, { text: "hello" });
  a.closeAgents();
  const c = (await a.send(conv.id, { text: "say fresh reply" })).content as AssistantContent;
  assert.equal(c.text, "fresh reply");
  assert.equal(c.items.some((i) => i.type === "tool" && i.label === "Old step"), false, "trailing replay tool call must not leak into next turn");
  e.close();
});

test("acp: Claude Code / Codex _session/steering injects mid-turn when advertised", async () => {
  const { e, a, received } = await setup({ FAKE_ACP_STEER: "0", FAKE_ACP_META_STEER: "1" });
  const conv = chat(e, a, "fake");
  let turnId = "";
  const events: AgentEvent[] = [];
  const done = a.send(conv.id, { text: "work" }, (ev) => {
    if (ev.type === "start") turnId = ev.turnId;
    events.push(ev);
  });
  assert.ok(await waitFor(() => events.some((x) => x.type === "text")));
  assert.equal(await a.steer(turnId, "switch to codex"), true);
  const c = (await done).content as AssistantContent;
  assert.deepEqual(c.items.map((i) => i.type), ["tool", "text", "steer", "text"]);
  assert.equal((c.items[3] as any).text, "Changed course: switch to codex");
  const req = received().find((x) => x.method === "_session/steering");
  assert.ok(req, "used _session/steering method");
  assert.equal(req.params.prompt[0].text, "switch to codex");
  assert.equal(req.params._meta?.steering?.idleBehavior, "promptRequired");
  e.close();
});

test("acp: missing Claude Code / Codex adapter surfaces the install command", async () => {
  const { e, a } = await setup();
  const s = e.settings();
  e.updateSettings({
    ai: {
      ...s.ai,
      agents: [...(s.ai.agents ?? []), { id: "missing-claude", name: "Claude Code", command: "nonexistent-claude-agent-acp-xyz", args: [], preset: "claude" }],
    },
  });
  const conv = chat(e, a, "missing-claude");
  const r = (await a.send(conv.id, { text: "hello" })).content as AssistantContent;
  assert.match(r.error ?? "", /npm install -g @agentclientprotocol\/claude-agent-acp/);
  e.close();
});

test("acp: Antigravity-style prompt-steer sends a plain concurrent session/prompt and chains the turn", async () => {
  const { e, a, received } = await setup({ FAKE_ACP_STEER: "0", FAKE_ACP_PROMPT_STEER: "1" });
  const conv = chat(e, a, "fake");
  let turnId = "";
  const events: AgentEvent[] = [];
  const done = a.send(conv.id, { text: "work" }, (ev) => {
    if (ev.type === "start") turnId = ev.turnId;
    events.push(ev);
  });
  assert.ok(await waitFor(() => events.some((x) => x.type === "text")));
  assert.equal(await a.steer(turnId, "say banana instead"), true);
  const c = (await done).content as AssistantContent;
  assert.deepEqual(c.items.map((i) => i.type), ["tool", "text", "steer", "text"]);
  assert.equal((c.items[3] as any).text, "Changed course: say banana instead");
  const prompts = received().filter((x) => x.method === "session/prompt");
  assert.equal(prompts.at(-1).params.prompt[0].text, "say banana instead", "no /steer prefix for prompt-steer agents");
  e.close();
});

test("acp: tool calls left in_progress after end_turn surface as live background tasks and clear on completion", async () => {
  const { e, a } = await setup({ FAKE_BG_MS: "250" });
  const conv = chat(e, a, "fake");
  const events: AgentEvent[] = [];
  await a.send(conv.id, { text: "background" }, (ev) => events.push(ev));

  const taskEvent = events.find((ev) => ev.type === "tasks");
  assert.ok(taskEvent && taskEvent.type === "tasks");
  assert.equal(taskEvent.tasks.length, 1);
  assert.equal(taskEvent.tasks[0].id, "bg1");
  assert.equal(taskEvent.tasks[0].title, "Building bundle");

  const active = a.backgroundTasks(conv.id);
  assert.equal(active.length, 1);
  assert.equal(active[0].title, "Building bundle");

  const updates: number[] = [];
  const stop = a.followTasks(conv.id, (tasks) => updates.push(tasks.length));
  try {
    assert.equal(updates[0], 1, "subscriber gets current background tasks immediately");
    assert.ok(await waitFor(() => a.backgroundTasks(conv.id).length === 0, 3000));
    assert.equal(updates.at(-1), 0, "subscriber is notified when the background task finishes");
  } finally {
    stop();
  }
  e.close();
});

test("hermes background tasks: reads live async_delegations subagents and processes.json, ignoring dead PIDs", async (t) => {
  const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { DatabaseSync } = await import("node:sqlite");
  const { hermesBackgroundTasks } = await import("../src/core/hermes-tasks.ts");
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-hermes-bg-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const prof = join(root, "profiles", "tutor");
  mkdirSync(prof, { recursive: true });
  const db = new DatabaseSync(join(prof, "state.db"));
  db.exec(`
    CREATE TABLE async_delegations (
      delegation_id TEXT PRIMARY KEY,
      origin_session TEXT NOT NULL,
      origin_ui_session_id TEXT NOT NULL DEFAULT '',
      parent_session_id TEXT,
      state TEXT NOT NULL,
      dispatched_at REAL NOT NULL,
      completed_at REAL,
      updated_at REAL NOT NULL,
      owner_pid INTEGER,
      task_json TEXT,
      origin_session_id TEXT
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      parent_session_id TEXT,
      started_at REAL,
      ended_at REAL
    );
  `);
  const nowSec = Date.now() / 1000;
  const sid = "local-abc123";
  // Live delegation with 2 children: 1 finished, 1 still running
  db.prepare("INSERT INTO async_delegations (delegation_id, origin_session, parent_session_id, state, dispatched_at, updated_at, owner_pid, task_json, origin_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "deleg_live1",
    `agent:tutor:local:dm:${sid}`,
    sid,
    "running",
    nowSec - 10,
    nowSec,
    process.pid,
    JSON.stringify({ goal: "2 parallel subagents", goals: ["Render cover A", "Render cover B"] }),
    sid,
  );
  // Stale delegation with an impossible dead PID: must be ignored
  db.prepare("INSERT INTO async_delegations (delegation_id, origin_session, parent_session_id, state, dispatched_at, updated_at, owner_pid, task_json, origin_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "deleg_dead1",
    `agent:tutor:local:dm:${sid}`,
    sid,
    "running",
    nowSec - 100,
    nowSec - 100,
    9999999,
    JSON.stringify({ goal: "Dead job" }),
    sid,
  );
  db.prepare("INSERT INTO sessions (id, title, parent_session_id, started_at, ended_at) VALUES (?, ?, ?, ?, ?)").run("child_done", "Subagent: Render cover A", sid, nowSec - 9, nowSec - 2);
  db.prepare("INSERT INTO sessions (id, title, parent_session_id, started_at, ended_at) VALUES (?, ?, ?, ?, ?)").run("child_run", "Subagent: Render cover B", sid, nowSec - 9, null);
  db.close();

  writeFileSync(
    join(prof, "processes.json"),
    JSON.stringify([
      { task_id: "proc_live", command: "blender -b scene.blend", pid: process.pid, started_at: nowSec - 5, parent_session_id: sid },
      { task_id: "proc_other", command: "other chat cmd", pid: process.pid, started_at: nowSec - 5, parent_session_id: "local-other" },
    ]),
  );

  const def = { id: "tutor", name: "Tutor", command: "hermes", args: ["-p", "tutor", "acp"], preset: "hermes" as const, env: { HERMES_HOME: root } };
  const tasks = hermesBackgroundTasks(def, sid);
  assert.deepEqual(
    tasks.map((x) => ({ id: x.id, kind: x.kind, title: x.title })),
    [
      { id: "child_run", kind: "subagent", title: "Render cover B" },
      { id: "proc_live", kind: "execute", title: "blender -b scene.blend" },
    ],
  );
});
