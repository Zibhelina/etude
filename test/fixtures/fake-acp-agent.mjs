#!/usr/bin/env node
// A scripted ACP agent for tests: it answers initialize, session/new, session/load and session/prompt over
// stdio, and logs every message it receives to $FAKE_ACP_LOG (one JSON line each). What a prompt does depends
// on its last text block: "hello", "tool", "ask", "wait", "plan", "mcpread", "mcp <deck name>", "work" (waits for a "/steer <words>")
// or "edit <path>".
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const log = (m) => process.env.FAKE_ACP_LOG && appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify(m) + "\n");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const update = (sessionId, u) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const chunk = (sessionId, text) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

let nextId = 1000;
const waiting = new Map();
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
let sessions = 0;
// Each session's pickers, the way Hermes offers them: a model, a reasoning effort, an edit mode.
const picks = new Map();
const configOptions = (sessionId) => {
  const p = picks.get(sessionId) ?? picks.set(sessionId, { model: "fake:small", reasoning_effort: "medium", edit_approval_policy: "ask" }).get(sessionId);
  const select = (id, name, category, values) => ({ id, name, category, type: "select", currentValue: p[id], options: values.map(([value, n]) => ({ value, name: n })) });
  return [
    select("edit_approval_policy", "Edits", "mode", [["ask", "Ask"], ["session", "Allow"]]),
    select("model", "Model", "model", [["fake:small", "Fake · small"], ["fake:big", "Fake · big"], ["other:huge", "Other · huge"]]),
    select("reasoning_effort", "Reasoning effort", "thought_level", [["low", "low"], ["medium", "medium"], ["high", "high"]]),
  ];
};
const mcpBySession = new Map();
const cancels = new Map();
// Turns that take words while they run (the "work" prompt), by session: what a /steer hands them.
const steers = new Map();
/** Like Hermes: the agent's slash commands, sent once a session exists. FAKE_ACP_STEER=0 leaves /steer out. */
const commands = (sessionId) =>
  update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "help", description: "Help" }, ...(process.env.FAKE_ACP_STEER === "0" ? [] : [{ name: "steer", description: "Steer the running turn" }])] });
const editRequest = async (sessionId, path) => {
  const toolCall = { toolCallId: "t6", title: `Edit ${path}`, kind: "edit", locations: [{ path }], rawInput: { path } };
  update(sessionId, { sessionUpdate: "tool_call", ...toolCall, status: "pending" });
  const r = await ask("session/request_permission", { sessionId, toolCall, options: [{ optionId: "yes", name: "Allow once", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] });
  log({ permission: r });
  const allowed = r.outcome.outcome === "selected" && r.outcome.optionId === "yes";
  update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t6", status: allowed ? "completed" : "failed" });
  chunk(sessionId, allowed ? "edited" : "not edited");
};

/** Talks to the MCP server Etude handed over, like a real agent would. */
function callMcp(server, tool, args) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const { name, value } of server.env) env[name] = value;
    const child = spawn(server.command, server.args, { env, stdio: ["pipe", "pipe", "inherit"] });
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      for (const line of buf.split("\n").slice(0, -1)) {
        const m = JSON.parse(line);
        if (m.id === 2) {
          child.stdin.end();
          resolve(m.result);
        }
      }
      buf = buf.slice(buf.lastIndexOf("\n") + 1);
    });
    child.on("error", reject);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } }) + "\n");
  });
}

async function prompt(id, { sessionId, prompt }) {
  const text = [...prompt].reverse().find((b) => b.type === "text")?.text ?? "";
  const done = (stopReason = "end_turn") => send({ jsonrpc: "2.0", id, result: { stopReason } });
  // Antigravity-style prompt-steer: a second concurrent session/prompt (without /steer) closes the
  // running prompt and continues streaming under the new prompt id.
  if (process.env.FAKE_ACP_PROMPT_STEER === "1" && steers.has(sessionId) && !text.startsWith("/steer ")) {
    const finishFirst = steers.get(sessionId);
    steers.delete(sessionId);
    finishFirst(text);
    chunk(sessionId, `Changed course: ${text}`);
    return done();
  }
  // "/steer <words>", the way Hermes takes it: answered at once in a message of its own, the running turn goes on.
  if (text.startsWith("/steer ")) {
    const take = steers.get(sessionId);
    if (!take) {
      chunk(sessionId, "No active turn — queued for the next turn. (1 queued)");
      return done();
    }
    chunk(sessionId, `⏩ Steer queued for the active turn: ${text.slice(7)}\n`);
    done();
    return take(text.slice(7));
  }
  // "background": starts a tool call, ends the turn while it's still in_progress, then completes it out-of-turn.
  if (text === "background") {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "bg1", name: "run_command", title: "sleep 10", args: { toolSummary: "Building bundle" }, kind: "execute", status: "in_progress" });
    chunk(sessionId, "Running it in the background.");
    done();
    setTimeout(() => {
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "bg1", name: "run_command", status: "completed" });
    }, Number(process.env.FAKE_BG_MS ?? 250));
    return;
  }
  // "work": a step, some words, then it waits for a steer and says what it was told.
  if (text === "work") {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t7", title: "Working on it", kind: "read", status: "in_progress" });
    update(sessionId, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Starting. " } });
    const told = await new Promise((r) => steers.set(sessionId, r));
    steers.delete(sessionId);
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t7", status: "completed" });
    if (process.env.FAKE_ACP_PROMPT_STEER !== "1") {
      update(sessionId, { sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: `Changed course: ${told}` } });
    }
    return done();
  }
  // "late": like Hermes' gateway when a steer comes after the turn's last step. The answer streams, the steer runs
  // as a follow-up after a thought, and the turn closes by sending the follow-up's answer once more, whole.
  if (text === "late") {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t9", title: "Looking it up", kind: "fetch", status: "completed" });
    chunk(sessionId, "\n\nFirst answer.");
    const told = await new Promise((r) => steers.set(sessionId, r));
    steers.delete(sessionId);
    update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "They added something." } });
    const again = `Second answer, about ${told}.`;
    for (const part of again.match(/[\s\S]{1,9}/g) ?? []) chunk(sessionId, part);
    chunk(sessionId, `\n\n${again}`);
    return done();
  }
  // "edit <path>": asks before editing a file, the way an agent asks about edits.
  if (text.startsWith("edit ")) {
    await editRequest(sessionId, text.slice(5));
    return done();
  }
  // "say <anything>" answers with exactly that, in pieces, the way a reply streams.
  if (text.startsWith("say ")) {
    for (const part of text.slice(4).match(/[\s\S]{1,23}/g) ?? []) chunk(sessionId, part);
    return done();
  }
  // "think": thoughts first, then the answer, then how full the context is. The answer names the session's picks.
  if (text === "think") {
    const p = picks.get(sessionId) ?? {};
    update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Let me think " } });
    await new Promise((r) => setTimeout(r, 60));
    update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "about this." } });
    chunk(sessionId, `Thought it through on ${p.model} at ${p.reasoning_effort}.`);
    update(sessionId, { sessionUpdate: "usage_update", used: 52000, size: 200000 });
    return done();
  }
  // "slow": a thought, a tool and some words, a pause long enough to reload the window, then the rest.
  if (text === "slow") {
    update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Weighing the slow way." } });
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t8", title: "Reading the deck", kind: "read", status: "in_progress" });
    chunk(sessionId, "Halfway there.");
    const cut = await new Promise((r) => {
      const t = setTimeout(() => r(false), Number(process.env.FAKE_SLOW_MS ?? 4000));
      cancels.set(sessionId, () => (clearTimeout(t), r(true)));
    });
    cancels.delete(sessionId);
    if (cut) return done("cancelled");
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t8", status: "completed", content: [{ type: "content", content: { type: "text", text: "12 cards" } }] });
    update(sessionId, { sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: "All the way there." } });
    return done();
  }
  if (text === "picture") {
    chunk(sessionId, "Here:");
    // A 1×1 PNG sent as data, the way an agent hands over a picture it made.
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" } });
    return done();
  }
  if (text === "hello") {
    chunk(sessionId, "Hel");
    chunk(sessionId, "lo!");
    return done();
  }
  if (text === "tool") {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Listing decks", kind: "read", status: "pending" });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: "3 decks" } }] });
    chunk(sessionId, "You have 3 decks.");
    return done();
  }
  if (text === "plan") {
    update(sessionId, { sessionUpdate: "plan", entries: [{ content: "Look", priority: "high", status: "completed" }, { content: "Make", priority: "high", status: "pending" }] });
    chunk(sessionId, "Planned.");
    return done();
  }
  if (text === "ask") {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t2", title: "Delete deck Old", kind: "delete", status: "pending", rawInput: { deck: "Old" } });
    const r = await ask("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "t2", title: "Delete deck Old", kind: "delete", rawInput: { deck: "Old" } },
      options: [
        { optionId: "yes", name: "Allow once", kind: "allow_once" },
        { optionId: "always", name: "Always allow", kind: "allow_always" },
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ],
    });
    log({ permission: r });
    if (r.outcome.outcome === "cancelled") return done("cancelled");
    const allowed = r.outcome.optionId !== "no";
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t2", status: allowed ? "completed" : "failed" });
    chunk(sessionId, allowed ? `allowed:${r.outcome.optionId}` : "denied");
    return done();
  }
  if (text === "wait") {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t3", title: "Thinking hard", kind: "think", status: "in_progress" });
    chunk(sessionId, "Working");
    await new Promise((r) => cancels.set(sessionId, r));
    return done("cancelled");
  }
  if (text === "mcpread") {
    // Like Hermes: an MCP call reported as kind "other", which may write, that only reads.
    const server = mcpBySession.get(sessionId)?.find((s) => s.name === "etude_app");
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t5", title: "mcp etude_run deck list", kind: "other", status: "in_progress" });
    const r = await callMcp(server, "etude_run", { argv: ["deck", "list"] });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t5", status: r.isError ? "failed" : "completed", content: [{ type: "content", content: r.content[0] }] });
    chunk(sessionId, r.isError ? "failed" : "listed");
    return done();
  }
  if (text.startsWith("mcp ")) {
    const server = mcpBySession.get(sessionId)?.find((s) => s.name === "etude_app");
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t4", title: "etude_run deck create", kind: "edit", status: "in_progress" });
    const r = await callMcp(server, "etude_run", { argv: ["deck", "create", text.slice(4)] });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t4", status: r.isError ? "failed" : "completed", content: [{ type: "content", content: r.content[0] }] });
    chunk(sessionId, r.isError ? "failed" : "made it");
    return done();
  }
  chunk(sessionId, `echo: ${text}`);
  done();
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    log(m);
    if (m.method === undefined) {
      waiting.get(m.id)?.(m.result);
      waiting.delete(m.id);
      continue;
    }
    const p = m.params ?? {};
    if (m.method === "initialize")
      send({
        jsonrpc: "2.0",
        id: m.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "fake-agent", ...(process.env.FAKE_ACP_TITLE ? { title: process.env.FAKE_ACP_TITLE } : {}), version: "0.0.1" },
          agentCapabilities: {
            loadSession: process.env.FAKE_ACP_LOAD === "1",
            promptCapabilities: { image: true, embeddedContext: true },
            ...(process.env.FAKE_ACP_PROMPT_STEER === "1" ? { _meta: { antigravity: { tier: true } } } : {}),
          },
          ...(process.env.FAKE_ACP_META_STEER === "1" ? { _meta: { steering: { supported: true } } } : {}),
          authMethods: [],
        },
      });
    else if (m.method === "session/new") {
      const sessionId = `s${++sessions}-${process.pid}`;
      mcpBySession.set(sessionId, p.mcpServers);
      send({ jsonrpc: "2.0", id: m.id, result: { sessionId, configOptions: configOptions(sessionId) } });
      commands(sessionId);
    } else if (m.method === "session/load") {
      mcpBySession.set(p.sessionId, p.mcpServers);
      // A real agent replays the history first; the client must not show it as a new reply.
      chunk(p.sessionId, "REPLAYED HISTORY");
      send({ jsonrpc: "2.0", id: m.id, result: { configOptions: configOptions(p.sessionId) } });
      if (process.env.FAKE_ACP_LATE_REPLAY === "1") {
        // Like Antigravity `agy acp`: trailing historical updates keep flushing briefly after session/load responds.
        setTimeout(() => {
          update(p.sessionId, { sessionUpdate: "tool_call", toolCallId: "old-t1", title: "Old step", kind: "read", status: "completed" });
          chunk(p.sessionId, "STALE PREVIOUS ANSWER");
        }, 25);
      }
      commands(p.sessionId);
    } else if (m.method === "session/set_config_option" && p.configId === "model" && p.value === "other:huge") {
      // Like Hermes' large-context switch guard: it asks first, and a no fails the pick.
      void (async () => {
        const toolCall = { toolCallId: "model-confirm-1", title: "Large Context Switch Warning: other:huge", kind: "other", status: "pending",
          content: [{ type: "content", content: { type: "text", text: "This session holds 150,000 tokens; other:huge reads them again uncached." } }] };
        const r = await ask("session/request_permission", { sessionId: p.sessionId, toolCall, options: [{ optionId: "allow_once", name: "Switch anyway", kind: "allow_once" }, { optionId: "deny", name: "Cancel", kind: "reject_once" }] });
        log({ permission: r });
        if (r.outcome.outcome !== "selected" || r.outcome.optionId !== "allow_once") return send({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "Internal error: model_switch_cancelled" } });
        configOptions(p.sessionId);
        picks.get(p.sessionId).model = p.value;
        send({ jsonrpc: "2.0", id: m.id, result: { configOptions: configOptions(p.sessionId) } });
      })();
    } else if (m.method === "session/set_config_option") {
      configOptions(p.sessionId);
      picks.get(p.sessionId)[p.configId] = p.value;
      send({ jsonrpc: "2.0", id: m.id, result: { configOptions: configOptions(p.sessionId) } });
    } else if (m.method === "session/prompt") prompt(m.id, p);
    else if (m.method === "_session/steering") {
      const text = [...(p.prompt ?? [])].reverse().find((b) => b.type === "text")?.text ?? "";
      const take = steers.get(p.sessionId);
      if (!take) {
        send({ jsonrpc: "2.0", id: m.id, result: { outcome: "promptRequired", reason: "noRunningTurn" } });
      } else {
        send({ jsonrpc: "2.0", id: m.id, result: { outcome: "injected" } });
        take(text);
      }
    } else if (m.method === "session/cancel") cancels.get(p.sessionId)?.();
    else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });
  }
});
process.stdin.on("end", () => process.exit(0));
