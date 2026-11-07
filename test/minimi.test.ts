// Minimi's persona in Ask Etude's system prompt: the usual one in Fun mode, the user's own text when set, the plain assistant when Fun is off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { MINIMI_DEFAULT, MINIMI_FACES, MINIMI_MAX, personaPrompt } from "../src/core/minimi.ts";

test("persona: usual Minimi, custom personality, plain assistant", () => {
  const usual = personaPrompt({ fun: true, personality: "", model: "x/y" });
  assert.ok(usual.startsWith(MINIMI_DEFAULT));
  assert.match(usual, /Never call yourself ChatGPT/);
  assert.match(usual, /right now: x\/y/);
  const custom = personaPrompt({ fun: true, personality: "  A grumpy pirate cat.  " });
  assert.ok(!custom.includes(MINIMI_DEFAULT), "custom text replaces the usual personality");
  assert.match(custom, /<personality>\nA grumpy pirate cat\.\n<\/personality>/);
  assert.match(custom, /tone and style only/);
  const plain = personaPrompt({ fun: false, personality: "A grumpy pirate cat." });
  assert.ok(!plain.includes("Minimi") && !plain.includes("pirate"));
  assert.match(plain, /Ask Etude/);
});

test("settings.minimi: default empty, saved, validated", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-minimi-"));
  const e = await Etude.open(join(dir, "etude.db"), { home: dir });
  try {
    assert.equal(e.settings().minimi, "");
    assert.equal(e.updateSettings({ minimi: "Speaks only in haiku." }).minimi, "Speaks only in haiku.");
    assert.equal(e.settings().minimi, "Speaks only in haiku.");
    assert.throws(() => e.updateSettings({ minimi: "x".repeat(MINIMI_MAX + 1) }), /too long/);
    assert.throws(() => e.updateSettings({ minimi: 3 as any }), /must be text/);
  } finally {
    e.close();
  }
});

test("settings.minimiFace: deadpan by default, one of the faces, synced key", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-minimi-face-"));
  const e = await Etude.open(join(dir, "etude.db"), { home: dir });
  try {
    assert.equal(e.settings().minimiFace, "deadpan");
    assert.equal(MINIMI_FACES.length, 12);
    assert.equal(e.updateSettings({ minimiFace: "wink" }).minimiFace, "wink");
    assert.equal(e.settings().minimiFace, "wink");
    assert.throws(() => e.updateSettings({ minimiFace: "grumpy" as any }), /minimiFace must be one of/);
    assert.equal(e.settings().minimiFace, "wink");
  } finally {
    e.close();
  }
});
