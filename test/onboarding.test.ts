import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseEnv } from "node:util";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { createApp } from "../src/server/app.ts";
import { setEnvKey } from "../src/core/env-file.ts";
import { run } from "../src/cli/run.ts";
import { AGENT_DENY } from "../src/core/agent.ts";

const home = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-onboard-"));
const open = (dir: string) => Etude.open(join(dir, "etude.db"), { home: dir });
const SECRET = "sk-or-v1-test-0123456789abcdef";

function cli(dir: string, env: Record<string, string | undefined> = { ETUDE_HOME: dir }) {
  return async (args: string[], stdin = "") => {
    let out = "", err = "";
    const code = await run(args, { stdout: (s) => (out += s), stderr: (s) => (err += s), stdin: () => stdin, isTTY: false, env });
    let json: any = null;
    try {
      json = JSON.parse(out);
    } catch {}
    return { code, out, err, json };
  };
}

test("setEnvKey writes one key with mode 0600, keeps other lines, replaces and removes", () => {
  const dir = home();
  writeFileSync(join(dir, ".env"), "# my keys\nOTHER_KEY=keep-me\nOPENROUTER_API_KEY=old\n");
  const env: Record<string, string | undefined> = {};
  const r = setEnvKey(dir, "OPENROUTER_API_KEY", `  ${SECRET}  `, env);
  assert.deepEqual({ name: r.name, set: r.set }, { name: "OPENROUTER_API_KEY", set: true });
  const text = readFileSync(join(dir, ".env"), "utf8");
  assert.equal(text, `# my keys\nOTHER_KEY=keep-me\nOPENROUTER_API_KEY=${SECRET}\n`);
  assert.equal(statSync(join(dir, ".env")).mode & 0o777, 0o600);
  assert.equal(env.OPENROUTER_API_KEY, SECRET);

  setEnvKey(dir, "SPACED_KEY", "a b#c", env);
  assert.match(readFileSync(join(dir, ".env"), "utf8"), /^SPACED_KEY="a b#c"$/m);
  // What Node's own .env parser (used by process.loadEnvFile) reads back is the value that was saved.
  const loaded = parseEnv(readFileSync(join(dir, ".env"), "utf8")) as Record<string, string>;
  assert.equal(loaded.SPACED_KEY, "a b#c");
  assert.equal(loaded.OPENROUTER_API_KEY, SECRET);

  setEnvKey(dir, "OPENROUTER_API_KEY", "", env);
  assert.ok(!readFileSync(join(dir, ".env"), "utf8").includes("OPENROUTER_API_KEY"));
  assert.ok(readFileSync(join(dir, ".env"), "utf8").includes("OTHER_KEY=keep-me"));
  assert.equal(env.OPENROUTER_API_KEY, undefined);
});

test("setEnvKey refuses bad names and values with line breaks", () => {
  const dir = home();
  for (const bad of ["lower", "1ABC", "A-B", "A B", "", "X".repeat(65), "A\nB"]) assert.throws(() => setEnvKey(dir, bad, "v", {}), /variable name/, bad);
  assert.throws(() => setEnvKey(dir, "GOOD_KEY", "line1\nINJECTED=1", {}), /line breaks/);
  assert.throws(() => setEnvKey(dir, "GOOD_KEY", "a\rb", {}), /line breaks/);
  assert.ok(setEnvKey(dir, "A".repeat(60) + "_KEY", "ok", {}).set);
  for (const reserved of ["PATH", "ETUDE_HOME", "NODE_OPTIONS", "ETUDE_CLOUD_URL", "SOMETHING"]) assert.throws(() => setEnvKey(dir, reserved, "v", {}), /API key name/, reserved);
});

test("onboarding: shown on an empty collection, settable, and silently done once decks exist", async () => {
  const e = await open(home());
  try {
    assert.deepEqual(e.settings().onboarding, { done: false, level: "standard" });
    assert.equal(e.onboardingStatus().show, true);
    e.updateSettings({ onboarding: { done: false, level: "tinker" } } as any);
    assert.equal(e.settings().onboarding.level, "tinker");
    assert.throws(() => e.updateSettings({ onboarding: { done: false, level: "expert" } } as any), /onboarding.level/);
    assert.throws(() => e.updateSettings({ onboarding: { done: "yes", level: "simple" } } as any), /onboarding.done/);
    e.updateSettings({ onboarding: { done: true } } as any);
    assert.deepEqual(e.settings().onboarding, { done: true, level: "tinker" }, "a partial patch keeps the level");
    assert.equal(e.onboardingStatus().show, false);
  } finally {
    e.close();
  }

  // An existing user: decks, and no onboarding flag stored. Marked done without being asked.
  const e2 = await open(home());
  try {
    e2.ensureDeck("Spanish");
    const s = e2.onboardingStatus();
    assert.equal(s.show, false);
    assert.equal(s.done, true);
    assert.equal(e2.settings().onboarding.done, true, "persisted");
  } finally {
    e2.close();
  }
});

test("server: /api/onboarding and /api/settings/key never echo the key, and keep the host and origin guards", async () => {
  const dir = home();
  const e = await open(dir);
  const before = process.env.TEST_ONBOARD_API_KEY;
  try {
    const app = createApp(e);
    const h = { host: "127.0.0.1:4610", "content-type": "application/json" };
    const ob = await (await app.request("/api/onboarding", { headers: h })).json();
    assert.equal(ob.show, true);

    const res = await app.request("/api/settings/key", { method: "POST", headers: h, body: JSON.stringify({ name: "TEST_ONBOARD_API_KEY", value: SECRET }) });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes(SECRET), "the reply has no key");
    assert.deepEqual(JSON.parse(text), { name: "TEST_ONBOARD_API_KEY", set: true });
    assert.equal(process.env.TEST_ONBOARD_API_KEY, SECRET, "takes effect without a restart");
    assert.ok(readFileSync(join(dir, ".env"), "utf8").includes(`TEST_ONBOARD_API_KEY=${SECRET}`));
    assert.equal(statSync(join(dir, ".env")).mode & 0o777, 0o600);

    // Settings show the key as set, never its value.
    e.updateSettings({ ai: { ...e.settings().ai, decision: null, feedback: { kind: "openai-chat", url: "http://127.0.0.1:9/v1/chat/completions", model: "m", apiKeyEnv: "TEST_ONBOARD_API_KEY" } } } as any);
    const st = await (await app.request("/api/settings", { headers: h })).text();
    assert.ok(!st.includes(SECRET));
    assert.equal(JSON.parse(st).keyStatus.TEST_ONBOARD_API_KEY, true);

    const bad = await app.request("/api/settings/key", { method: "POST", headers: h, body: JSON.stringify({ name: "bad name", value: "x" }) });
    assert.equal(bad.status, 400);
    const nl = await app.request("/api/settings/key", { method: "POST", headers: h, body: JSON.stringify({ name: "OK_API_KEY", value: "a\nEVIL=1" }) });
    assert.equal(nl.status, 400);
    assert.ok(!readFileSync(join(dir, ".env"), "utf8").includes("EVIL"));

    // Guards: a foreign Host, a cross-site Origin and a form post are all refused.
    const evilHost = await app.request("/api/settings/key", { method: "POST", headers: { ...h, host: "evil.example" }, body: JSON.stringify({ name: "X_KEY", value: "v" }) });
    assert.equal(evilHost.status, 421);
    const evilOrigin = await app.request("/api/settings/key", { method: "POST", headers: { ...h, origin: "https://evil.example" }, body: JSON.stringify({ name: "X_KEY", value: "v" }) });
    assert.equal(evilOrigin.status, 403);
    const form = await app.request("/api/settings/key", { method: "POST", headers: { host: h.host, "content-type": "application/x-www-form-urlencoded" }, body: "name=X_KEY&value=v" });
    assert.equal(form.status, 415);
    assert.ok(!readFileSync(join(dir, ".env"), "utf8").includes("X_KEY"));

    const rm = await (await app.request("/api/settings/key", { method: "POST", headers: h, body: JSON.stringify({ name: "TEST_ONBOARD_API_KEY", value: "" }) })).json();
    assert.deepEqual(rm, { name: "TEST_ONBOARD_API_KEY", set: false });
    assert.equal(process.env.TEST_ONBOARD_API_KEY, undefined);

    const done = await (await app.request("/api/settings", { method: "PATCH", headers: h, body: JSON.stringify({ onboarding: { done: true, level: "simple" } }) })).json();
    assert.deepEqual(done.onboarding, { done: true, level: "simple" });
  } finally {
    if (before === undefined) delete process.env.TEST_ONBOARD_API_KEY;
    else process.env.TEST_ONBOARD_API_KEY = before;
    e.close();
  }
});

test("CLI: settings key set reads stdin only, never prints the key; onboarding is a setting", async () => {
  const dir = home();
  const env: Record<string, string | undefined> = { ETUDE_HOME: dir };
  const e = cli(dir, env);
  const set = await e(["settings", "key", "set", "OPENAI_API_KEY"], `${SECRET}\n`);
  assert.equal(set.code, 0, set.err);
  assert.equal(set.json.name, "OPENAI_API_KEY");
  assert.equal(set.json.set, true);
  assert.ok(!set.out.includes(SECRET) && !set.err.includes(SECRET));
  assert.ok(readFileSync(join(dir, ".env"), "utf8").includes(`OPENAI_API_KEY=${SECRET}`));
  assert.equal(statSync(join(dir, ".env")).mode & 0o777, 0o600);

  const empty = await e(["settings", "key", "set", "OPENAI_API_KEY"], "");
  assert.equal(empty.code, 2, "no stdin is a usage error");
  const extra = await e(["settings", "key", "set", "OPENAI_API_KEY", SECRET], "");
  assert.notEqual(extra.code, 0, "the key is never taken as an argument");
  const bad = await e(["settings", "key", "set", "lower_case"], "v");
  assert.equal(bad.code, 4);

  const unset = await e(["settings", "key", "unset", "OPENAI_API_KEY"]);
  assert.equal(unset.json.set, false);
  assert.ok(!readFileSync(join(dir, ".env"), "utf8").includes("OPENAI_API_KEY"));

  assert.equal((await e(["settings", "set", "onboarding.level=tinker"])).code, 0);
  assert.equal((await e(["settings", "get", "onboarding.level"])).json.value, "tinker");
  assert.equal((await e(["settings", "set", "onboarding.level=wizard"])).code, 4);
  const st = await e(["settings", "onboarding"]);
  assert.deepEqual(st.json, { done: false, level: "tinker", show: true, decks: 0 });
  assert.equal((await e(["settings", "set", "onboarding.done=true"])).code, 0);
  assert.equal((await e(["settings", "onboarding"])).json.show, false);

  assert.ok(AGENT_DENY.includes("settings key set") && AGENT_DENY.includes("settings key unset"), "the assistant can't write keys");
});
