import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { agentFor, helpText, type AgentEvent, type AssistantContent } from "../src/core/agent.ts";
import { saveChatGptCredentials, CHATGPT_PLAN_SCOPE } from "../src/core/chatgpt.ts";
import { createApp } from "../src/server/app.ts";
import { run } from "../src/cli/run.ts";

type Step = { text?: string; calls?: { name: string; args: unknown }[] };

/** A scripted model: each request gets the next step. Records request bodies. */
async function fakeModel(protocol: "chat" | "responses", steps: Step[], opts: { title?: string } = {}) {
  const bodies: any[] = [];
  const titleBodies: any[] = [];
  let i = 0;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || "{}");
    // Title requests run beside the turn; they get their own answer and don't use up a step.
    const isTitle = /name chat conversations/.test(body.instructions ?? body.messages?.[0]?.content ?? "");
    if (isTitle) titleBodies.push(body);
    else bodies.push(body);
    const step = isTitle ? { text: opts.title ?? "Chat" } : steps[Math.min(i++, steps.length - 1)];
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (protocol === "chat") {
      if (step.text) for (const part of step.text.match(/.{1,7}/gs) ?? []) send({ model: "fake-chat", choices: [{ delta: { content: part } }] });
      (step.calls ?? []).forEach((c, k) => {
        const args = JSON.stringify(c.args);
        send({ choices: [{ delta: { tool_calls: [{ index: k, id: `c${i}_${k}`, type: "function", function: { name: c.name, arguments: "" } }] } }] });
        send({ choices: [{ delta: { tool_calls: [{ index: k, function: { arguments: args.slice(0, 5) } }] } }] });
        send({ choices: [{ delta: { tool_calls: [{ index: k, function: { arguments: args.slice(5) } }] } }] });
      });
      send({ choices: [{ delta: {}, finish_reason: step.calls ? "tool_calls" : "stop" }], usage: { cost: 0.0001 } });
      res.write("data: [DONE]\n\n");
    } else {
      const output: any[] = [];
      if (step.text) {
        for (const part of step.text.match(/.{1,7}/gs) ?? []) send({ type: "response.output_text.delta", delta: part });
        output.push({ type: "message", content: [{ type: "output_text", text: step.text }] });
      }
      (step.calls ?? []).forEach((c, k) => {
        const item = { type: "function_call", call_id: `r${i}_${k}`, name: c.name, arguments: JSON.stringify(c.args) };
        send({ type: "response.output_item.done", item });
        output.push(item);
      });
      send({ type: "response.completed", response: { model: "fake-gpt", output } });
    }
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, bodies, titleBodies, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function collection(feedback: unknown) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-agent-"));
  const e = await Etude.open(join(dir, "etude.db"), { home: dir });
  e.updateSettings({ ai: { ...e.settings().ai, feedback: feedback as any, decision: null } });
  return { dir, e };
}

const run_ = (argv: string[], stdin?: string) => ({ name: "etude_run", args: stdin ? { argv, stdin } : { argv } });

test("chat-completions tool loop: help, create, confirm a delete, undo puts it back", async () => {
  const fake = await fakeModel("chat", [
    { calls: [{ name: "etude_help", args: { query: "deck create" } }] },
    { text: "Creating.", calls: [run_(["deck", "create", "Spanish::Verbs"]), run_(["deck", "create", "Scratch"])] },
    { calls: [run_(["deck", "delete", "Scratch"])] },
    { text: "Done: made **Spanish::Verbs**.", calls: [{ name: "ui", args: { action: "navigate", path: "/deck?name=Spanish%3A%3AVerbs" } }] },
    { text: "All set." },
  ]);
  const { e } = await collection({ kind: "openai-chat", url: `${fake.base}/v1/chat/completions`, model: "fake-chat" });
  try {
    const a = agentFor(e);
    const conv = a.createConversation("custom:fake-chat");
    const events: AgentEvent[] = [];
    let turnId = "";
    const done = a.send(conv.id, { text: "make me a Spanish verbs deck" }, (ev) => {
      events.push(ev);
      if (ev.type === "start") turnId = ev.turnId;
      if (ev.type === "confirm") {
        assert.equal(ev.item.argv?.join(" "), "deck delete Scratch");
        assert.match(ev.item.preview ?? "", /dryRun/);
        setTimeout(() => a.confirm(turnId, ev.item.id, true), 5);
      }
    });
    const msg = await done;
    const c = msg.content as AssistantContent;
    assert.equal(c.error, undefined);
    // Reply text plus a navigate in one step ends the turn: no extra model call.
    assert.equal(c.text.trim(), "Done: made **Spanish::Verbs**.");
    assert.equal(fake.bodies.length, 4);
    assert.ok(c.changed);
    assert.ok(msg.canUndo);
    const decks = e.db.all("SELECT name FROM decks ORDER BY name").map((r) => r.name);
    assert.ok(decks.includes("Spanish::Verbs"));
    assert.ok(!decks.includes("Scratch"), "Scratch was deleted after Allow");
    assert.ok(events.some((x) => x.type === "ui" && x.path?.startsWith("/deck")));
    assert.ok(events.some((x) => x.type === "text"));
    // The tools were offered in Chat Completions form, and the tool results went back with tool_call_id.
    assert.equal(fake.bodies[0].tools[0].type, "function");
    assert.ok(fake.bodies[0].tools.some((t: any) => t.function.name === "etude_run"));
    const toolMsg = fake.bodies[1].messages.find((m: any) => m.role === "tool");
    assert.ok(toolMsg.tool_call_id && /deck create/.test(toolMsg.content));
    // One snapshot for the whole turn.
    assert.equal(readdirSync(join(e.home, "agent-snapshots")).length, 1);

    const r = a.undo(conv.id);
    assert.deepEqual(r.undone, [msg.id]);
    const after = e.db.all("SELECT name FROM decks ORDER BY name").map((x) => x.name);
    assert.ok(!after.includes("Spanish::Verbs"), "undo removed the created deck");
    assert.ok(!after.includes("Scratch"));
    // The conversation itself survives the restore.
    assert.equal(a.conversation(conv.id).messages.length, 2);
    assert.equal(a.conversation(conv.id).messages[1].canUndo, false);
  } finally {
    e.close();
    await fake.close();
  }
});

test("Deny leaves the deck and tells the model", async () => {
  const fake = await fakeModel("chat", [{ calls: [run_(["deck", "delete", "Keep", "--yes"])] }, { text: "OK, I left it." }]);
  const { e } = await collection({ kind: "openai-chat", url: `${fake.base}/v1/chat/completions`, model: "m" });
  try {
    e.ensureDeck("Keep");
    const a = agentFor(e);
    const conv = a.createConversation("custom:m");
    let turnId = "";
    const msg = await a.send(conv.id, { text: "delete Keep" }, (ev) => {
      if (ev.type === "start") turnId = ev.turnId;
      if (ev.type === "confirm") setTimeout(() => a.confirm(turnId, ev.item.id, false), 5);
    });
    assert.ok(e.db.get("SELECT 1 AS x FROM decks WHERE name = 'Keep'"));
    const tool = (msg.content as AssistantContent).items.find((i) => i.type === "tool") as any;
    assert.equal(tool.status, "denied");
    assert.match(fake.bodies[1].messages.at(-1).content, /denied/);
    assert.equal((msg.content as AssistantContent).changed, false);
    assert.equal(msg.canUndo, false);
  } finally {
    e.close();
    await fake.close();
  }
});

test("Responses API tool loop with function_call / function_call_output, theme set", async () => {
  const fake = await fakeModel("responses", [{ calls: [run_(["theme", "set", "paper"])] }, { text: "Switched to Paper." }]);
  const { dir, e } = await collection({ kind: "chatgpt", model: "fake-gpt" });
  saveChatGptCredentials(dir, {
    email: "t@example.com",
    issuer: "x",
    subject: "s",
    client_id: "c",
    ext_agent_host_id: "h",
    id_token: null,
    access_token: "tok",
    refresh_token: "ref",
    token_type: "Bearer",
    expires_in: 3600,
    scopes: [CHATGPT_PLAN_SCOPE],
    saved_at: new Date().toISOString(),
  });
  e.updateSettings({ ai: { ...e.settings().ai, feedback: { kind: "chatgpt", model: "fake-gpt", baseUrl: `${fake.base}/v1/responses` } } });
  try {
    const a = agentFor(e);
    const conv = a.createConversation(null);
    const msg = await a.send(conv.id, { text: "paper theme please" });
    const c = msg.content as AssistantContent;
    assert.equal(c.error, undefined, String(c.error));
    assert.equal(e.currentTheme().id, "paper");
    assert.equal(c.text, "Switched to Paper.");
    assert.equal(fake.bodies[0].tools[0].type, "function");
    assert.equal(fake.bodies[0].tools[0].name, "etude_help");
    const out = fake.bodies[1].input.find((x: any) => x.type === "function_call_output");
    const call = fake.bodies[1].input.find((x: any) => x.type === "function_call");
    assert.equal(out.call_id, call.call_id);
    assert.match(out.output, /exit 0/);
    // A second turn replays the first turn's tool exchange.
    await a.send(conv.id, { text: "thanks" });
    assert.ok(fake.bodies.at(-1).input.filter((x: any) => x.type === "function_call").length >= 1);
  } finally {
    e.close();
    await fake.close();
  }
});

test("denylist, --db refusal, tool-call limit and attachments", async () => {
  const many = Array.from({ length: 30 }, () => ({ calls: [run_(["deck", "list"])] }));
  const fake = await fakeModel("chat", [
    { calls: [run_(["serve"]), run_(["settings", "chatgpt", "logout"]), run_(["deck", "list", "--db", "/tmp/x.db"]), { name: "read_attachment", args: { id: "PLACEHOLDER" } }] },
    ...many,
    { text: "stopping" },
  ]);
  const { e } = await collection({ kind: "openai-chat", url: `${fake.base}/v1/chat/completions`, model: "m" });
  try {
    const a = agentFor(e);
    const conv = a.createConversation("custom:m");
    const att = a.addAttachment(conv.id, "notes.md", new TextEncoder().encode("# Notes\nser = to be"));
    assert.equal(att.kind, "text");
    const msg = await a.send(conv.id, { text: "go", attachments: [att.id] });
    const tools = (msg.content as AssistantContent).items.filter((i) => i.type === "tool") as any[];
    assert.equal(tools[0].status, "denied");
    assert.equal(tools[1].status, "denied");
    assert.equal(tools[2].status, "error");
    assert.match(fake.bodies[0].messages.at(-1).content, /Attached files/);
    assert.ok(tools.filter((t) => t.tool === "etude_run").length <= 25);
    const last = fake.bodies.at(-1);
    assert.equal((last.tools ?? []).length, 0, "no tools offered once the limit is reached");
  } finally {
    e.close();
    await fake.close();
  }
});

test("read_attachment pages a PDF", async () => {
  const pdf = makePdf(["Mitochondria make ATP.", "Ribosomes make proteins."]);
  const fake = await fakeModel("chat", [{ text: "ok" }]);
  const { e } = await collection({ kind: "openai-chat", url: `${fake.base}/v1/chat/completions`, model: "m" });
  try {
    const a = agentFor(e);
    const conv = a.createConversation("custom:m");
    const meta = a.addAttachment(conv.id, "bio.pdf", pdf);
    const ready = await a.prepareAttachment(conv.id, meta.id);
    assert.equal(ready.pages, 2);
    const out = await (a as any).readAttachment(conv.id, { id: meta.id, page: "2" });
    assert.match(out, /Ribosomes/);
    assert.doesNotMatch(out, /Mitochondria/);
  } finally {
    e.close();
    await fake.close();
  }
});

test("etude_help finds commands and hides blocked ones", async () => {
  assert.match(await helpText(""), /deck:/);
  assert.match(await helpText("deck move"), /--top/);
  assert.match(await helpText("theme"), /theme set/);
  assert.doesNotMatch(await helpText(""), /\bserve\b/);
});

test("HTTP: SSE stream, confirm endpoint and undo endpoint", async () => {
  const fake = await fakeModel("chat", [{ calls: [run_(["deck", "create", "Web"])] }, { text: "made it" }]);
  const { e } = await collection({ kind: "openai-chat", url: `${fake.base}/v1/chat/completions`, model: "m" });
  try {
    const app = createApp(e);
    const conv = (await (await app.request("/api/agent/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()) as any;
    const res = await app.request(`/api/agent/conversations/${conv.id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "make Web" }) });
    const text = await res.text();
    assert.match(text, /event: start/);
    assert.match(text, /event: tool_end/);
    assert.match(text, /event: done/);
    assert.ok(e.db.get("SELECT 1 AS x FROM decks WHERE name = 'Web'"));
    const undo = await app.request(`/api/agent/conversations/${conv.id}/undo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(undo.status, 200);
    assert.equal(e.db.get("SELECT 1 AS x FROM decks WHERE name = 'Web'"), undefined);
    const list = (await (await app.request("/api/agent/conversations")).json()) as any;
    assert.equal(list.conversations[0].title, "make Web");
  } finally {
    e.close();
    await fake.close();
  }
});

test("CLI: agent ask, list, show; --yes allows confirmations", async () => {
  const fake = await fakeModel("chat", [{ calls: [run_(["deck", "create", "Tmp"])] }, { calls: [run_(["deck", "delete", "Tmp"])] }, { text: "gone" }]);
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-agent-cli-"));
  const io = (sink: { out: string; err: string }) => ({ stdout: (s: string) => (sink.out += s), stderr: (s: string) => (sink.err += s), stdin: () => "", isTTY: false, env: { ETUDE_HOME: dir } });
  try {
    let s = { out: "", err: "" };
    assert.equal(await run(["settings", "set", `ai.feedback={"kind":"openai-chat","url":"${fake.base}/v1/chat/completions","model":"m"}`, "ai.decision=null"], io(s)), 0, s.err);
    s = { out: "", err: "" };
    assert.equal(await run(["agent", "ask", "make", "and", "delete", "Tmp", "--yes", "--model", "custom:m"], io(s)), 0, s.err);
    const r = JSON.parse(s.out);
    assert.equal(r.reply, "gone");
    assert.deepEqual(r.commands.map((c: any) => c.status), ["done", "done"]);
    assert.match(s.err, /deck create Tmp/);
    s = { out: "", err: "" };
    await run(["agent", "list"], io(s));
    assert.equal(JSON.parse(s.out)[0].id, r.conversation);
    s = { out: "", err: "" };
    await run(["agent", "show", r.conversation], io(s));
    assert.equal(JSON.parse(s.out).messages.length, 2);
  } finally {
    await fake.close();
  }
});

/** A minimal valid PDF with one line of text per page. */
function makePdf(pages: string[]): Uint8Array {
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  pages.forEach((t, i) => {
    const stream = `BT /F1 18 Tf 72 720 Td (${t}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}


test("round 2: cheat-sheet, effort, parallel reads, consequence, change labels, titles", async () => {
  const fake = await fakeModel("responses", [
    // Turn 1: two read-only calls in one step, then a create, then text.
    { calls: [run_(["deck", "list"]), run_(["theme", "list"])] },
    { calls: [run_(["deck", "create", "Agent Scratch::Sub"]), run_(["theme", "set", "paper"])] },
    { text: "Made it." },
    // Turn 2: delete asks; then text. Then the retitle request (no tools).
    { calls: [run_(["deck", "delete", "Agent Scratch"])] },
    { text: "Deleted." },
  ], { title: "\"Scratch deck cleanup.\"" });
  const { e } = await collection({ kind: "chatgpt", model: "gpt-x", baseUrl: `${fake.base}/v1/responses` });
  saveChatGptCredentials(e.home, {
    email: "t@example.com",
    issuer: "x",
    subject: "s",
    client_id: "c",
    ext_agent_host_id: "h",
    id_token: null,
    access_token: "tok",
    refresh_token: "ref",
    token_type: "Bearer",
    expires_in: 3600,
    scopes: [CHATGPT_PLAN_SCOPE],
    saved_at: new Date().toISOString(),
  });
  try {
    const a = agentFor(e);
    const conv = a.createConversation("chatgpt:gpt-x");
    const m1 = await a.send(conv.id, { text: "make a scratch deck and use paper" });
    const c1 = m1.content as AssistantContent;
    assert.equal(c1.error, undefined);
    // The prompt carries the generated cheat-sheet and a valid pack example.
    assert.match(fake.bodies[0].instructions, /Command cheat-sheet/);
    assert.match(fake.bodies[0].instructions, /- deck move <deck> \[parent\]  --top/);
    assert.match(fake.bodies[0].instructions, /"etude":"pack\/1"/);
    // Low effort and parallel calls by default.
    assert.deepEqual(fake.bodies[0].reasoning, { effort: "low" });
    assert.equal(fake.bodies[0].parallel_tool_calls, true);
    // Both reads ran; their outputs went back paired with their call ids.
    const outs = fake.bodies[1].input.filter((x: any) => x.type === "function_call_output");
    assert.equal(outs.length, 2);
    assert.deepEqual(c1.changes, ["created deck Sub", "theme change"]);

    // Turn 2 (2nd user message): the delete card says what goes, in plain words.
    let confirmItem: any = null;
    let titleEvent: any = null;
    const m2 = await a.send(conv.id, { text: "now delete it" }, (ev) => {
      if (ev.type === "confirm") {
        confirmItem = ev.item;
        setTimeout(() => a.confirm(a.runningTurn(conv.id)!, ev.item.id, true), 5);
      }
      if (ev.type === "title") titleEvent = ev;
    });
    assert.equal(confirmItem.action, "Delete deck");
    assert.equal(confirmItem.summary, "Deletes deck Agent Scratch: 0 cards, 1 subdeck, 0 reviews.");
    assert.deepEqual((m2.content as AssistantContent).changes, ["deleted deck Agent Scratch"]);
    // Retitled from the conversation: quotes and the period stripped, no tools offered.
    assert.equal(fake.titleBodies.length, 1, "one title request, after the 2nd message");
    const titleReq = fake.titleBodies[0];
    assert.equal((titleReq.tools ?? []).length, 0);
    assert.match(titleReq.input[0].content[0].text, /make a scratch deck/);
    assert.equal(a.conversation(conv.id).title, "Scratch deck cleanup");
    assert.equal(titleEvent?.conversation.title, "Scratch deck cleanup");

    // A manual rename sticks: automatic titles stop.
    const renamed = a.renameConversation(conv.id, "  My   chat ");
    assert.equal(renamed.title, "My chat");
    assert.equal(renamed.autoTitle, false);
  } finally {
    e.close();
    await fake.close();
  }
});

test("round 2: pack import via the json argument opens its deck and ends in one more step", async () => {
  const pack = { etude: "pack/1", name: "Cells", items: [{ id: "cells.1", type: "basic", deck: "Bio::Cells", fields: { front: "ATP?", back: "Energy." } }] };
  const fake = await fakeModel("chat", [{ calls: [{ name: "etude_run", args: { argv: ["pack", "import", "-"], json: pack } }] }, { text: "Made **Cells**." }]);
  const { e } = await collection({ kind: "openai-chat", url: `${fake.base}/v1/chat/completions`, model: "m" });
  try {
    const a = agentFor(e);
    const conv = a.createConversation("custom:m");
    const events: AgentEvent[] = [];
    const msg = await a.send(conv.id, { text: "make cards" }, (ev) => events.push(ev));
    const c = msg.content as AssistantContent;
    assert.equal(c.error, undefined);
    assert.ok(e.db.get("SELECT 1 FROM items WHERE id = 'cells.1'"));
    assert.ok(events.some((x) => x.type === "ui" && x.path === "/deck?name=Bio%3A%3ACells"), "the app opened the new deck itself");
    assert.match(fake.bodies[1].messages.find((m: any) => m.role === "tool").content, /don't navigate to it again/);
    assert.deepEqual(c.changes, ["created deck Cells"]);
    assert.equal(fake.bodies.length, 2);
  } finally {
    e.close();
    await fake.close();
  }
});
