// Command Code provider: the subprocess transport that answers a chat request with
// headless `cmd -p`, plus the NDJSON `finalText` parsing. The binary is faked with a
// node one-liner (see the fake-bin pattern in agent.test.ts), so no real `cmd` runs here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandCodeTurn, buildQuery, parseFinalText, parseModelList, listCommandCodeModels, DEFAULT_CMDCODE_TIMEOUT_MS } from "../src/core/commandcode.ts";

// A fake `cmd` that prints two NDJSON frames and exits 0. The contents don't matter —
// only that the last `finalText` wins.
function fakeBin(): string {
  const dir = mkdtempSync(join(tmpdir(), "cmdcode-"));
  const bin = join(dir, "cmd");
  writeFileSync(
    bin,
    `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ type: "event" }) + "\\n");\nprocess.stdout.write(JSON.stringify({ type: "result", subtype: "success", finalText: "Hello from cmd" }));\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

test("parseFinalText: last result line wins; garbage lines are skipped", () => {
  assert.equal(parseFinalText('{"type":"event","event":{}}\n{"type":"result","finalText":"first"}\n{"type":"event"}\n{"type":"result","finalText":"second"}'), "second");
  assert.equal(parseFinalText('not json\n{"type":"result","finalText":"hi"}'), "hi");
  assert.equal(parseFinalText('{"type":"event"}'), null);
  assert.equal(parseFinalText(""), null);
});

test("buildQuery: system prompt first, turns labelled", () => {
  const q = buildQuery("Rules: be Minimi.", [
    { role: "user", content: "hi" },
    { role: "assistant", content: "meow" },
  ]);
  assert.equal(q, "Rules: be Minimi.\n\nUser: hi\n\nAssistant: meow");
});

test("commandCodeTurn: runs the fake binary and returns finalText", async () => {
  const prev = process.env.ETUDE_CMDCODE_BIN;
  process.env.ETUDE_CMDCODE_BIN = fakeBin();
  try {
    const out = await commandCodeTurn({ kind: "commandcode", model: "", timeoutMs: 30_000 }, "sys", [
      { role: "user", content: "hi" },
    ]);
    assert.equal(out.text, "Hello from cmd");
    assert.match(out.model, /cmd/);
    assert.ok(out.ms >= 0);
  } finally {
    if (prev === undefined) delete process.env.ETUDE_CMDCODE_BIN;
    else process.env.ETUDE_CMDCODE_BIN = prev;
  }
});

test("commandCodeTurn: non-zero exit surfaces stderr as AiError", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cmdcode-fail-"));
  const bin = join(dir, "cmd");
  writeFileSync(bin, `#!/usr/bin/env node\nprocess.stderr.write("not logged in");\nprocess.exit(3);\n`);
  chmodSync(bin, 0o755);
  const prev = process.env.ETUDE_CMDCODE_BIN;
  process.env.ETUDE_CMDCODE_BIN = bin;
  try {
    await assert.rejects(
      commandCodeTurn({ kind: "commandcode", model: "", timeoutMs: 30_000 }, "sys", [{ role: "user", content: "hi" }]),
      /not logged in/,
    );
  } finally {
    if (prev === undefined) delete process.env.ETUDE_CMDCODE_BIN;
    else process.env.ETUDE_CMDCODE_BIN = prev;
  }
});

test("commandCodeTurn: missing binary reports the binary name", async () => {
  const prev = process.env.ETUDE_CMDCODE_BIN;
  process.env.ETUDE_CMDCODE_BIN = join(tmpdir(), "definitely-not-a-real-binary-cmd");
  try {
    await assert.rejects(commandCodeTurn({ kind: "commandcode", model: "", timeoutMs: 30_000 }, "sys", [{ role: "user", content: "x" }]), /definitely-not-a-real-binary-cmd/);
  } finally {
    if (prev === undefined) delete process.env.ETUDE_CMDCODE_BIN;
    else process.env.ETUDE_CMDCODE_BIN = prev;
  }
});

test("DEFAULT_CMDCODE_TIMEOUT_MS is a reasonable subprocess budget", () => {
  assert.equal(DEFAULT_CMDCODE_TIMEOUT_MS, 300_000);
});

test("parseModelList: reads `cmd --list-models` shape, skips noise", () => {
  const out = [
    "Available models  ·  96 models",
    "",
    "Open Source",
    "",
    "deepseek/deepseek-v4-pro                hybrid-attention long-context reasoning",
    "deepseek/deepseek-v4.1-flash            V4.1 hybrid-attention reasoning with vision (default)",
    "",
    "Anthropic",
    "",
    "claude-sonnet-4-6                      older Sonnet, still fast & capable {" + '"json"' + "}",
    "",
    "Pass the full id, or just the short name after the last \"/\":",
    "cmd --model kimi-k2.5",
    "",
    "Docs:  https://commandcode.ai/docs/reference/cli/models",
    "",
    "Decision models (headless only)",
    "typesafe/jev  typed questions in, probabilities out, $0.042 per 1M input tokens",
  ].join("\n");
  const models = parseModelList(out);
  assert.equal(models.length, 3);
  assert.deepEqual(models[0], { id: "deepseek/deepseek-v4-pro", name: "hybrid-attention long-context reasoning", default: false });
  assert.deepEqual(models[1], { id: "deepseek/deepseek-v4.1-flash", name: "V4.1 hybrid-attention reasoning with vision (default)", default: true });
  assert.equal(models[2].id, "claude-sonnet-4-6");
});

test("listCommandCodeModels: parses the fake binary's list output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cmdcode-models-"));
  const bin = join(dir, "cmd");
  writeFileSync(
    bin,
    `#!/usr/bin/env node\nprocess.stdout.write(["Available models  ·  2 models","","Open Source","","deepseek/deepseek-v4-pro                recursive","deepseek/deepseek-v4.1-flash            default model (default)","",""].join("\\n"));\n`,
  );
  chmodSync(bin, 0o755);
  const prev = process.env.ETUDE_CMDCODE_BIN;
  process.env.ETUDE_CMDCODE_BIN = bin;
  try {
    const models = await listCommandCodeModels();
    assert.deepEqual(models, [
      { id: "deepseek/deepseek-v4-pro", name: "recursive", default: false },
      { id: "deepseek/deepseek-v4.1-flash", name: "default model (default)", default: true },
    ]);
  } finally {
    if (prev === undefined) delete process.env.ETUDE_CMDCODE_BIN;
    else process.env.ETUDE_CMDCODE_BIN = prev;
  }
});

test("listCommandCodeModels: missing binary errors the list", async () => {
  const prev = process.env.ETUDE_CMDCODE_BIN;
  process.env.ETUDE_CMDCODE_BIN = join(tmpdir(), "definitely-not-a-real-binary-cmd");
  try {
    await assert.rejects(listCommandCodeModels(), /definitely-not-a-real-binary-cmd/);
  } finally {
    if (prev === undefined) delete process.env.ETUDE_CMDCODE_BIN;
    else process.env.ETUDE_CMDCODE_BIN = prev;
  }
});
