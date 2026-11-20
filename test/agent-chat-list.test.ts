import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { agentFor } from "../src/core/agent.ts";

test("chat list: pin keeps a chat's time, search finds titles and words said", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-chatlist-"));
  const e = await Etude.open(join(dir, "etude.db"), { home: dir });
  try {
    const a = agentFor(e);
    const one = a.createConversation(null);
    const two = a.createConversation(null);
    a.renameConversation(one.id, "Triangle rasterization");
    const store = (a as any).store;
    const say = (conv: string, role: string, content: unknown) => store.run("INSERT INTO agent_messages (conversation_id, role, content, created) VALUES (?, ?, ?, ?)", conv, role, JSON.stringify(content), new Date().toISOString());
    say(two.id, "user", { text: "how does the barycentric interpolation work?", attachments: [] });
    say(two.id, "assistant", { text: "Each pixel gets weights from the three vertices, 100% literal_underscore here.", items: [], model: "x", ms: 1, changed: false });

    const before = a.conversation(one.id).updated;
    const pinned = a.pinConversation(one.id, true);
    assert.equal(pinned.pinned, true);
    assert.equal(pinned.updated, before);
    assert.equal(a.listConversations().find((c) => c.id === one.id)?.pinned, true);
    assert.equal(a.pinConversation(one.id, false).pinned, undefined);

    assert.deepEqual(a.searchConversations("triangle").map((h) => [h.id, h.role]), [[one.id, "title"]]);
    const hit = a.searchConversations("BARYCENTRIC");
    assert.equal(hit.length, 1);
    assert.equal(hit[0].id, two.id);
    assert.equal(hit[0].role, "user");
    assert.match(hit[0].snippet, /barycentric interpolation/);
    // LIKE's own characters are plain text here.
    assert.equal(a.searchConversations("100%")[0]?.role, "assistant");
    assert.equal(a.searchConversations("h_p").length, 0);
    assert.equal(a.searchConversations("literal_underscore").length, 1);
    // Words that only appear in the JSON around the text don't count.
    assert.equal(a.searchConversations("attachments").length, 0);
    assert.deepEqual(a.searchConversations("   "), []);
  } finally {
    e.close?.();
  }
});
