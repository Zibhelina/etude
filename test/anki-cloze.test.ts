import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ankiClozeToBuiltin } from "../src/core/anki/cloze.ts";
import { run } from "../src/cli/run.ts";

const conv = (text: string, slashAlternatives = false) => ankiClozeToBuiltin(text, { slashAlternatives }).text;

test("a hint that repeats the answer is kept", () => {
  // In a case drill the hint is the form to decline, so dropping it leaves the blank unanswerable.
  assert.equal(conv("Ich lege das Foto zwischen {{c1::die Bücher::die Bücher}}."), "Ich lege das Foto zwischen {{die Bücher::die Bücher}}.");
  assert.equal(conv("{{c1::das::das}}"), "{{das::das}}");
  assert.equal(conv("{{c1::dem::der}}"), "{{dem::der}}");
});

test("answers without a hint, and hints that differ, convert as before", () => {
  assert.deepEqual(ankiClozeToBuiltin("{{c1::Ottawa}} is the capital of {{c2::Canada}}."), { text: "{{Ottawa}} is the capital of {{Canada}}.", blanks: 2 });
  assert.equal(conv("the {{c2::least significant::which?}} byte"), "the {{least significant::which?}} byte");
  assert.equal(conv("Das Foto liegt zwischen {{c1::den Büchern::die Bücher}}."), "Das Foto liegt zwischen {{den Büchern::die Bücher}}.");
  assert.equal(conv("{{c1::a:: }}"), "{{a}}", "an empty hint is no hint");
  assert.equal(conv("{{ c12 ::x}}"), "{{ c12 ::x}}", "only Anki's own marker spelling counts");
  assert.equal(conv("{{c12::x}}"), "{{x}}");
});

test("alternatives", () => {
  assert.equal(conv("{{c1::80|eighty}}"), "{{80|eighty}}", "built-in alternatives pass through");
  assert.equal(conv("put time {{c1::in/into}} something"), "put time {{in/into}} something", "a slash is literal unless asked");
  assert.equal(conv("put time {{c1::in/into}} something", true), "put time {{in|into|in/into}} something");
  assert.equal(conv("{{c1::für/gegen::Präp.}}", true), "{{für|gegen|für/gegen::Präp.}}");
  assert.equal(conv("{{c1::10 km/h}}", true), "{{10 km/h}}", "only bare words joined by slashes");
});

test("nested markers, built-in blanks and unclosed markers", () => {
  assert.deepEqual(ankiClozeToBuiltin("{{c1::a {{c2::b::x}} c::h}} and {{c3::d}}"), { text: "{{a b c::h}} and {{d}}", blanks: 2 });
  assert.equal(conv("already {{built::in}}"), "already {{built::in}}");
  assert.equal(conv("broken {{c1::open and {{c2::fine}}"), "broken {{c1::open and {{c2::fine}}");
  assert.deepEqual(ankiClozeToBuiltin("no clozes"), { text: "no clozes", blanks: 0 });
});

test("etude anki cloze: the built-in cloze type shows the kept hint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "etude-anki-cloze-"));
  try {
    const cli = async (args: string[], stdin = "") => {
      let out = "", err = "";
      const code = await run(args, { stdout: (s) => (out += s), stderr: (s) => (err += s), stdin: () => stdin, isTTY: false, env: { ETUDE_HOME: dir } });
      assert.equal(code, 0, err);
      return JSON.parse(out);
    };
    const { text, blanks } = await cli(["anki", "cloze", "-"], "Ich lege das Foto zwischen {{c1::die Bücher::die Bücher}}.");
    assert.equal(text, "Ich lege das Foto zwischen {{die Bücher::die Bücher}}.");
    assert.equal(blanks, 1);
    const preview = await cli(["type", "preview", "cloze", "--fields", JSON.stringify({ text })]);
    assert.deepEqual(preview.view.blanks.map((b: { hint: string }) => b.hint), ["die Bücher"]);
    assert.deepEqual(preview.key.answers, [["die Bücher"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
