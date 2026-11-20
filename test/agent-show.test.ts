import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Etude } from "../src/core/engine.ts";
import { agentFor, type AgentEvent, type AssistantContent } from "../src/core/agent.ts";
import { runningAgents } from "../src/core/acp.ts";
import { createApp } from "../src/server/app.ts";
import { keepShown, localPath, shownRefs } from "../src/core/agent-show.ts";
import { chartSpec, isLocalPath, richSegments } from "../web/src/lib/agent-rich.ts";

afterEach(() => {
  for (const c of runningAgents()) c.close();
});

const FAKE = join(import.meta.dirname, "fixtures", "fake-acp-agent.mjs");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

async function setup() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-show-"));
  const e = await Etude.open(join(dir, "etude.db"), { home: dir });
  e.updateSettings({ ai: { ...e.settings().ai, agents: [{ id: "fake", name: "Fakey", command: process.execPath, args: [FAKE] }] } });
  e.addAgentProfile({ id: "p-fake", name: "Fakey", brain: { kind: "external", agent: "fake" } });
  const a = agentFor(e);
  return { dir, e, a };
}

test("a reply's text splits into Markdown and the things it shows", () => {
  const segs = richSegments(["Look:", "", "MEDIA:/tmp/a.png", "", "```chart", '{"type":"bar","x":["a"],"series":[{"name":"n","data":[1]}]}', "```", "::sticker{file=\"/tmp/s.webp\"}", "::cards{deck=\"A::B\" n=3}", "```js", "MEDIA:/not/this", "```", "![cat](https://x.test/c.jpg)", "the end"].join("\n"));
  assert.deepEqual(segs.map((s) => s.kind), ["md", "media", "chart", "sticker", "cards", "md", "media", "md"]);
  assert.equal((segs[1] as any).src, "/tmp/a.png");
  assert.deepEqual((segs[4] as any).attrs, { deck: "A::B", n: "3" });
  // A code block keeps what's in it as code.
  assert.match((segs[5] as any).text, /MEDIA:\/not\/this/);
  assert.equal((segs[6] as any).alt, "cat");
});

test("a widget or a path that's still being written waits instead of showing half", () => {
  assert.deepEqual(richSegments("Here\n```widget\n<b>hi", true).map((s) => s.kind), ["md", "pending"]);
  assert.deepEqual(richSegments("Here\n```widget\n<b>hi", false).map((s) => s.kind), ["md", "widget"]);
  assert.deepEqual(richSegments("Here\nMEDIA:/tmp/a.p", true).map((s) => s.kind), ["md", "pending"]);
  assert.deepEqual(richSegments("Here\nMEDIA:/tmp/a.png\n", true).map((s) => s.kind), ["md", "media"]);
});

test("a row puts columns side by side, and a fence inside can't close it", () => {
  const segs = richSegments(["intro", ':::row{widths="2 3"}', "![a](https://x.test/a.png)", "*caption*", ":::col", "## Title", "```widget", ":::", "<b>x</b>", "```", ":::", "end"].join("\n"));
  assert.deepEqual(segs.map((s) => s.kind), ["md", "row", "md"]);
  const row = segs[1] as Extract<(typeof segs)[number], { kind: "row" }>;
  assert.deepEqual(row.widths, [2, 3]);
  assert.deepEqual(row.cols.map((c) => c.map((s) => s.kind)), [["media", "md"], ["md", "widget"]]);
  assert.deepEqual(richSegments(":::row\nleft\n:::col\nright").map((s) => s.kind), ["row"]);
});

test("an aside floats a box and the text after it wraps around, until :::clear", () => {
  const segs = richSegments(["lead", ':::aside{width="35%"}', "![a](https://x.test/a.png)", "| k | v |", "|---|---|", "| a | b |", ":::", "## Section", "text", ":::clear", "after"].join("\n"));
  assert.deepEqual(segs.map((s) => s.kind), ["md", "aside", "md"]);
  const a = segs[1] as Extract<(typeof segs)[number], { kind: "aside" }>;
  assert.equal(a.width, "35%");
  assert.equal(a.side, "right");
  assert.deepEqual(a.aside.map((s) => s.kind), ["media", "md"]);
  assert.deepEqual(a.body.map((s) => s.kind), ["md"]);
  assert.equal((richSegments(':::aside{width="calc(100vw)"}\nx\n:::\ny')[0] as { width: string }).width, "40%");
});

test("rows and asides nest: an inner ::: closes only the inner block", () => {
  const text = [":::aside", "box", ":::row", "a", ":::col", "b", ":::", "under the row, still in the box", ":::", "wraps", ":::row", "left", ":::aside", "inner", ":::", "beside inner", ":::col", "right", ":::"].join("\n");
  const segs = richSegments(text);
  assert.deepEqual(segs.map((s) => s.kind), ["aside"]);
  const a = segs[0] as Extract<(typeof segs)[number], { kind: "aside" }>;
  assert.deepEqual(a.aside.map((s) => s.kind), ["md", "row", "md"]);
  assert.deepEqual(a.body.map((s) => s.kind), ["md", "row"]);
  const row = a.body[1] as Extract<(typeof segs)[number], { kind: "row" }>;
  assert.deepEqual(row.cols.map((c) => c.map((s) => s.kind)), [["md", "aside"], ["md"]]);
});

test("a widget sits on the chat unless its fence asks for a card", () => {
  const segs = richSegments("```widget\n<b>x</b>\n```\n```widget card\n<b>y</b>\n```");
  assert.deepEqual(segs.map((s) => [s.kind, (s as { bare?: boolean }).bare]), [["widget", true], ["widget", false]]);
});

test("::open asks for a note beside the chat", () => {
  assert.deepEqual(richSegments('::open{note="abc" side="below"}\n::open{note="d"}'), [{ kind: "open", note: "abc", side: "bottom" }, { kind: "open", note: "d", side: "right" }]);
});

test("Lotus directives read the same way", () => {
  const segs = richSegments('::preview{file="/tmp/w.html"}\n::audio{src="/tmp/v.mp3"}');
  assert.deepEqual(segs.map((s) => s.kind), ["widget", "media"]);
  assert.deepEqual(JSON.parse((segs[0] as any).body), { file: "/tmp/w.html" });
});

test("charts come in several shapes and end up as one", () => {
  assert.deepEqual(chartSpec('{"type":"line","x":["a","b"],"series":[{"name":"s","data":[1,2]}]}')!.series, [{ name: "s", data: [1, 2] }]);
  const pie = chartSpec('{"type":"pie","data":{"Yes":3,"No":1}}')!;
  assert.deepEqual([pie.x, pie.series[0].data], [["Yes", "No"], [3, 1]]);
  const pairs = chartSpec('{"type":"bar","data":[{"label":"a","value":2},{"label":"b","value":5}]}')!;
  assert.deepEqual([pairs.x, pairs.series[0].data], [["a", "b"], [2, 5]]);
  assert.equal(chartSpec('{"type":"scatter","series":[{"name":"p","data":[[1,2],[3,4]]}]}')!.points![0].data.length, 2);
  assert.equal(chartSpec("not json"), null);
  assert.equal(chartSpec('{"type":"bar","series":[]}'), null);
});

test("what counts as a file on this computer", () => {
  const fileUrl = pathToFileURL(join(tmpdir(), "a.png")).href;
  for (const p of ["/tmp/a.png", "~/a.png", fileUrl]) assert.ok(isLocalPath(p) && localPath(p), p);
  for (const p of ["https://x.test/a.png", "/media/files/ab.png", "/api/agent/conversations/x", "//x.test/a.png", "a.png"]) assert.ok(!isLocalPath(p) && !localPath(p), p);
  assert.deepEqual(shownRefs('MEDIA:/tmp/a.png\n![x](/tmp/b.jpg) ::sticker{file="/tmp/c.webp"} {"file": "/tmp/d.html"} MEDIA:/etc/passwd\n![y](https://x.test/e.png)'), ["/tmp/a.png", "/tmp/b.jpg", "/tmp/c.webp", "/tmp/d.html"]);
});

test("an agent on this computer shows a file; the chat keeps its own copy", async () => {
  const { dir, e, a } = await setup();
  const pic = join(dir, "made.png");
  writeFileSync(pic, PNG);
  const conv = a.createConversation(null, "p-fake");
  const msg = await a.send(conv.id, { text: `say Here you go\n\nMEDIA:${pic}\n` });
  const shown = (msg.content as AssistantContent).shown!;
  assert.ok(shown[pic], "the reply remembers the file");
  const app = createApp(e);
  const url = `/api/agent/conversations/${conv.id}/shown?path=${encodeURIComponent(pic)}&m=${msg.id}`;
  let res = await app.request(url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.match(res.headers.get("content-security-policy") ?? "", /sandbox/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  // The original goes away: the chat still has it.
  rmSync(pic);
  res = await app.request(url);
  assert.equal(res.status, 200);
  // Seeking in audio and video asks for a range.
  res = await app.request(url, { headers: { Range: "bytes=0-3" } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), `bytes 0-3/${PNG.length}`);
  assert.equal((await res.arrayBuffer()).byteLength, 4);
  // Nothing the agent didn't write in this chat, and nothing that isn't a picture, sound, video, PDF or page.
  const secret = join(dir, "other.png");
  writeFileSync(secret, PNG);
  assert.equal((await app.request(`/api/agent/conversations/${conv.id}/shown?path=${encodeURIComponent(secret)}`)).status, 404);
  assert.equal((await app.request(`/api/agent/conversations/${conv.id}/shown?path=${encodeURIComponent(join(dir, "etude.db"))}`)).status, 404);
  assert.equal((await app.request(`/api/agent/conversations/${conv.id}/shown?path=${encodeURIComponent("/etc/passwd")}`)).status, 404);
  const other = a.createConversation(null, "p-fake");
  assert.equal((await app.request(`/api/agent/conversations/${other.id}/shown?path=${encodeURIComponent(pic)}`)).status, 404);
  a.closeAgents();
  e.close();
});

test("a picture an agent sends as data shows like a file", async () => {
  const { e, a } = await setup();
  const conv = a.createConversation(null, "p-fake");
  const msg = await a.send(conv.id, { text: "picture" });
  const c = msg.content as AssistantContent;
  const path = /MEDIA:(\S+\.png)/.exec(c.text)?.[1];
  assert.ok(path && existsSync(path), "saved with the chat");
  assert.deepEqual(readFileSync(path!), PNG);
  const res = await createApp(e).request(`/api/agent/conversations/${conv.id}/shown?path=${encodeURIComponent(path!)}&m=${msg.id}`);
  assert.equal(res.status, 200);
  a.closeAgents();
  e.close();
});

test("a model's reply can't open a file on this computer", async () => {
  const { dir, e, a } = await setup();
  const pic = join(dir, "x.png");
  writeFileSync(pic, PNG);
  assert.deepEqual(keepShown(`MEDIA:${pic}`, join(dir, "kept")), { [pic]: Object.values(keepShown(`MEDIA:${pic}`, join(dir, "kept")))[0] });
  // A chat with Minimi (a model, not an agent on this computer): a reply naming the path gets nothing.
  const conv = a.createConversation(null);
  a.store.run(`INSERT INTO agent_messages (conversation_id, role, content, created) VALUES (?, 'assistant', ?, ?)`, conv.id, JSON.stringify({ text: `MEDIA:${pic}`, items: [{ type: "text", text: `MEDIA:${pic}` }], model: "m", ms: 1, changed: false }), new Date().toISOString());
  assert.equal((await createApp(e).request(`/api/agent/conversations/${conv.id}/shown?path=${encodeURIComponent(pic)}`)).status, 404);
  e.close();
});

test("two chats work at the same time", async () => {
  const { e, a } = await setup();
  const one = a.createConversation(null, "p-fake");
  const two = a.createConversation(null, "p-fake");
  const first = a.send(one.id, { text: "wait" });
  // The first is still going when the second starts and finishes.
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(a.runningTurn(one.id));
  const b = await a.send(two.id, { text: "hello" });
  assert.equal((b.content as AssistantContent).text, "Hello!");
  assert.ok(a.runningTurn(one.id), "the first chat is still working");
  a.stop(a.runningTurn(one.id)!);
  await first;
  a.closeAgents();
  e.close();
});

test("an agent's pickers: read, picked before the first message, changed after, and refused mid-reply", async () => {
  const { e, a } = await setup();
  // Nothing known yet: asking warm starts the agent and reads what it offers. The edit mode isn't a picker here.
  assert.deepEqual((await a.controls(null, "p-fake")).controls, []);
  const offered = await a.controls(null, "p-fake", true);
  assert.deepEqual(offered.controls.map((c) => [c.id, c.currentValue]), [["model", "fake:small"], ["reasoning_effort", "medium"]]);
  assert.equal(offered.live, false);
  // A new chat takes the session that was opened to ask, and the picks made before it existed.
  const conv = a.createConversation(null, "p-fake");
  const events: AgentEvent[] = [];
  const msg = await a.send(conv.id, { text: "think", controls: { model: "fake:big", reasoning_effort: "high", edit_approval_policy: "session", nope: "x" } }, (ev) => events.push(ev));
  const c = msg.content as AssistantContent;
  assert.equal(c.text, "Thought it through on fake:big at high.");
  // The thought comes before the answer, with how long it took; the context use is saved with the reply.
  assert.deepEqual(c.items.map((i) => i.type), ["thought", "text"]);
  assert.equal((c.items[0] as any).text, "Let me think about this.");
  assert.ok((c.items[0] as any).ms >= 50);
  assert.deepEqual(c.usage, { used: 52000, size: 200000 });
  assert.ok(events.some((ev) => ev.type === "usage") && events.some((ev) => ev.type === "thought") && events.some((ev) => ev.type === "controls"));
  let now = await a.controls(conv.id);
  assert.equal(now.live, true);
  assert.deepEqual(now.usage, { used: 52000, size: 200000 });
  assert.deepEqual(now.controls.map((x) => x.currentValue), ["fake:big", "high"]);
  // Changing one mid-chat.
  now = await a.setControl(conv.id, "reasoning_effort", "low");
  assert.equal(now.controls.find((x) => x.id === "reasoning_effort")!.currentValue, "low");
  assert.equal(((await a.send(conv.id, { text: "think" })).content as AssistantContent).text, "Thought it through on fake:big at low.");
  await assert.rejects(a.setControl(conv.id, "reasoning_effort", "ultra"), /isn't one of/);
  await assert.rejects(a.setControl(conv.id, "edit_approval_policy", "session"), /no "edit_approval_policy"/);
  const going = a.send(conv.id, { text: "wait" });
  await new Promise((r) => setTimeout(r, 200));
  await assert.rejects(a.setControl(conv.id, "model", "fake:small"), /wait for the reply/);
  a.stop(a.runningTurn(conv.id)!);
  await going;
  // Over HTTP, and a chat with a model offers its effort.
  const app = createApp(e);
  // A switch the agent asks about first (Hermes' large-context guard): refused with its words, then sent again with a yes.
  const ask = await app.request(`/api/agent/conversations/${conv.id}/controls/model`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "other:huge" }) });
  assert.equal(ask.status, 409);
  const asked = await ask.json();
  assert.equal(asked.code, "confirm_pick");
  assert.match(asked.error, /150,000 tokens/);
  assert.equal((await a.controls(conv.id)).controls[0].currentValue, "fake:big");
  const put = await app.request(`/api/agent/conversations/${conv.id}/controls/model`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "other:huge", confirmed: true }) });
  assert.equal(put.status, 200);
  assert.equal((await put.json()).controls[0].currentValue, "other:huge");
  const minimi = await (await app.request(`/api/agent/controls?profile=minimi`)).json();
  assert.deepEqual(minimi.controls.map((x: any) => x.id), ["effort"]);
  a.closeAgents();
  e.close();
});
