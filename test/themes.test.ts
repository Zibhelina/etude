import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { BUILTIN_THEMES, DEFAULT_THEME, MAX_THEME_CSS, THEME_VARS, normalizeTheme, sanitizeCss, themeCss } from "../src/core/themes.ts";
import { run } from "../src/cli/run.ts";

test("built-in themes set every variable and have distinct ids", () => {
  assert.equal(new Set(BUILTIN_THEMES.map((t) => t.id)).size, BUILTIN_THEMES.length);
  assert.ok(BUILTIN_THEMES.some((t) => t.id === DEFAULT_THEME));
  assert.ok(BUILTIN_THEMES.some((t) => t.scheme === "light") && BUILTIN_THEMES.some((t) => t.scheme === "dark"));
  for (const t of BUILTIN_THEMES) {
    for (const v of THEME_VARS) assert.ok(t.vars[v], `${t.id} is missing ${v}`);
    assert.deepEqual(normalizeTheme(t).theme.vars, t.vars, `${t.id} doesn't survive normalization`);
  }
});

test("Midnight matches the stylesheet defaults", () => {
  const css = readFileSync(new URL("../web/src/index.css", import.meta.url), "utf8");
  const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
  const midnight = BUILTIN_THEMES.find((t) => t.id === "midnight")!;
  for (const m of root.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) assert.equal(midnight.vars[m[1]], m[2].trim(), `${m[1]} differs from index.css`);
});

test("sanitizeCss strips remote imports and urls, keeps data: and local ones", () => {
  const { css, removed } = sanitizeCss(
    [
      "@import url(https://x.example/a.css);",
      '@import "//cdn.example/b.css";',
      "a { background: url('https://x.example/i.png') }",
      'b { background: url("data:image/png;base64,AAAA") }',
      "c { background: url(/media/local.png) }",
      "@font-face { font-family: X; src: url(http://x.example/f.woff2) }",
      'd { background: image-set("https://x.example/1.png" 1x) }',
      "/* @import url(https://hidden.example) */ e { color: red }",
    ].join("\n"),
  );
  assert.equal(removed.length, 5);
  assert.doesNotMatch(css, /x\.example|cdn\.example|hidden\.example|@import/);
  assert.match(css, /data:image\/png/);
  assert.match(css, /\/media\/local\.png/);
  assert.match(css, /e \{ color: red \}/);
  assert.throws(() => sanitizeCss("a { background: \\75 rl(https://x.example/i.png) }"), /escapes/);
  assert.throws(() => sanitizeCss("@\\69mport 'https://x.example/a.css';"), /escapes/);
});

test("normalizeTheme validates and fills in", () => {
  const { theme } = normalizeTheme({ id: "sea", name: "Sea", scheme: "light", vars: { highlight: "teal" } });
  assert.equal(theme.vars["--highlight"], "teal");
  assert.equal(theme.vars["--background"], BUILTIN_THEMES.find((t) => t.id === "daylight")!.vars["--background"]);
  assert.throws(() => normalizeTheme({ id: "Bad Id" }), /slug/);
  assert.throws(() => normalizeTheme({ id: "x", vars: { "--a": "red; } body { display: none" } }), /can't contain/);
  assert.throws(() => normalizeTheme({ id: "x", vars: { "--a": "url(https://x)" } }), /images/);
  assert.throws(() => normalizeTheme({ id: "x", css: "a{}".repeat(MAX_THEME_CSS) }), /limit/);
  assert.match(themeCss(theme), /^html:root \{[\s\S]*color-scheme: light;/);
});

test("engine stores the selected theme and custom themes in settings", async () => {
  const e = await Etude.open(":memory:");
  assert.equal(e.settings().theme, DEFAULT_THEME);
  assert.deepEqual(e.settings().themes, []);
  assert.equal(e.currentTheme().id, "midnight");

  e.selectTheme("paper");
  assert.equal(e.settings().theme, "paper");
  assert.throws(() => e.selectTheme("nope"), /unknown theme/);

  const saved = e.saveTheme({ id: "sea", name: "Sea", base: "midnight", vars: { "--highlight": "oklch(0.7 0.1 200)" }, css: "@import 'https://x.example/a.css';\n.x { color: red }" });
  assert.equal(saved.created, true);
  assert.equal(saved.removed.length, 1);
  assert.equal(e.theme("sea").css, ".x { color: red }");
  assert.throws(() => e.saveTheme({ id: "sea" }, { create: true }), /already exists/);
  assert.throws(() => e.saveTheme({ id: "midnight" }), /built-in/);
  assert.throws(() => e.updateSettings({ themes: [{ id: "a" }, { id: "a" }] as any }), /share the id/);

  e.selectTheme("sea");
  assert.equal(e.listThemes().filter((t) => t.selected).map((t) => t.id).join(), "sea");
  // Saving unrelated settings leaves themes alone.
  e.updateSettings({ dayStartHour: 5 });
  assert.equal(e.settings().theme, "sea");
  assert.equal(e.settings().themes.length, 1);

  assert.deepEqual(e.deleteTheme("sea"), { deleted: "sea", selected: "midnight" });
  assert.equal(e.settings().theme, "midnight");
  assert.throws(() => e.deleteTheme("paper"), /built in/);
  assert.throws(() => e.updateSettings({ theme: "gone" }), /unknown theme/);
  e.close();
});

test("CLI: theme list, set, create, edit, export, import, delete", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-theme-"));
  const cli = async (args: string[], stdin = "") => {
    let out = "", err = "";
    const code = await run(args, { stdout: (s) => (out += s), stderr: (s) => (err += s), stdin: () => stdin, isTTY: false, env: { ETUDE_HOME: dir } });
    let json: any = null;
    try {
      json = JSON.parse(out);
    } catch {}
    return { code, out, err, json };
  };
  const ok = (r: { code: number; err: string }) => assert.equal(r.code, 0, r.err);

  const list = await cli(["theme", "list"]);
  ok(list);
  assert.deepEqual(list.json.map((t: any) => t.id), BUILTIN_THEMES.map((t) => t.id));
  assert.equal(list.json.find((t: any) => t.selected).id, "midnight");

  ok(await cli(["theme", "set", "paper"]));
  assert.equal((await cli(["settings", "get", "theme"])).json.value, "paper");
  assert.equal((await cli(["theme", "set", "nope"])).code, 3);

  const created = await cli(["theme", "create", "sea", "--name", "Sea", "--from", "midnight", "--var", "highlight=oklch(0.7 0.12 210)", "--css", "@import url(https://x.example/a.css); .x{color:red}", "--use"]);
  ok(created);
  assert.equal(created.json.theme.vars["--highlight"], "oklch(0.7 0.12 210)");
  assert.equal(created.json.theme.scheme, "dark");
  assert.equal(created.json.removed.length, 1);
  assert.equal(created.json.selected, "sea");
  assert.equal((await cli(["theme", "create", "sea"])).code, 5);
  assert.equal((await cli(["theme", "create", "daylight"])).code, 5);

  const dry = await cli(["theme", "edit", "sea", "--var", "radius=0.25rem", "--dry-run"]);
  ok(dry);
  assert.equal((await cli(["theme", "show", "sea"])).json.vars["--radius"], "0.75rem");

  const edited = await cli(["theme", "edit", "sea", "--var", "--radius=0.25rem", "--scheme", "light", "--unset-var", "highlight"]);
  ok(edited);
  assert.equal(edited.json.theme.vars["--radius"], "0.25rem");
  assert.equal(edited.json.theme.vars["--highlight"], BUILTIN_THEMES[0].vars["--highlight"]);
  assert.equal(edited.json.theme.scheme, "light");
  assert.equal((await cli(["theme", "edit", "midnight", "--var", "radius=0"])).code, 5);
  assert.equal((await cli(["theme", "edit", "sea", "--var", "highlight=red;}"])).code, 4);

  const css = await cli(["theme", "show", "sea", "--css"]);
  ok(css);
  assert.match(css.out, /^html:root \{/);
  assert.match(css.out, /\.x\{color:red\}/);

  const file = join(dir, "sea.theme.json");
  ok(await cli(["theme", "export", "sea", "-o", file]));
  const exported = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(exported.etudeTheme, 1);
  assert.equal(exported.id, "sea");

  // Same id: imported under a new one unless --replace.
  const imp = await cli(["theme", "import", file]);
  ok(imp);
  assert.equal(imp.json.theme.id, "sea-2");
  assert.equal(imp.json.created, true);
  const rep = await cli(["theme", "import", file, "--replace"]);
  ok(rep);
  assert.equal(rep.json.created, false);
  writeFileSync(join(dir, "bad.json"), JSON.stringify({ id: "bad", vars: { "--a": "url(https://x)" } }));
  assert.equal((await cli(["theme", "import", join(dir, "bad.json")])).code, 4);
  const piped = await cli(["theme", "import", "-", "--id", "piped", "--use"], JSON.stringify({ name: "Piped", scheme: "light", vars: { highlight: "teal" } }));
  ok(piped);
  assert.equal(piped.json.selected, "piped");

  ok(await cli(["theme", "edit", "piped", "--rename", "piped-2"]));
  assert.equal((await cli(["settings", "get", "theme"])).json.value, "piped-2");

  assert.equal((await cli(["theme", "delete", "piped-2"])).code, 2);
  const del = await cli(["theme", "delete", "piped-2", "--yes"]);
  ok(del);
  assert.equal(del.json.selected, "midnight");
  assert.equal((await cli(["theme", "delete", "midnight", "--yes"])).code, 5);
  assert.deepEqual((await cli(["theme", "list"])).json.filter((t: any) => !t.builtin).map((t: any) => t.id), ["sea", "sea-2"]);
});
