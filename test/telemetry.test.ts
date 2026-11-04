import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { createApp } from "../src/server/app.ts";
import { run } from "../src/cli/run.ts";
import { EVENT_NAMES, fingerprint, osFromUserAgent, scrub, startTelemetry, telemetryAllowed, telemetryFor, usageEventFor } from "../src/core/telemetry.ts";

const home = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-telemetry-"));
const open = (dir: string) => Etude.open(join(dir, "etude.db"), { home: dir });

/** Runs fn with ETUDE_TELEMETRY set (tests are under node --test, where telemetry is off unless it says 1). */
async function withEnv<T>(value: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const before = process.env.ETUDE_TELEMETRY;
  if (value === undefined) delete process.env.ETUDE_TELEMETRY;
  else process.env.ETUDE_TELEMETRY = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.ETUDE_TELEMETRY;
    else process.env.ETUDE_TELEMETRY = before;
  }
}

/** A fake etude-cloud: records what it got, answers with `status`. */
function fakeServer(status: number | (() => number) = 200) {
  const got: { url: string; body: any }[] = [];
  const fetch = async (url: string, init: { body: string }) => {
    const s = typeof status === "function" ? status() : status;
    if (s === 0) throw new Error("offline");
    got.push({ url, body: JSON.parse(init.body) });
    return { status: s };
  };
  return { got, fetch };
}

test("telemetry: scrubs paths, emails, query strings, digits and quoted user text", () => {
  assert.equal(
    scrub('Error: no deck named "Spanish verbs" for ana.costa@gmail.com at https://sync.etude.study/v1/x?token=SECRET (card 1234567)'),
    'Error: no deck named "…" for <email> at https://sync.etude.study/v1/x?… (card <n>)',
  );
  assert.equal(scrub("at /Users/joao/.etude/x.js:1:2 / C:\\Users\\Joao\\AppData\\y / /home/ana/z"), "at ~/.etude/x.js:1:2 / ~\\AppData\\y / ~/z");
  assert.equal(scrub("can't parse 'Kanji 漢字' or ‘x’ or “y” or `z`"), "can't parse '…' or ‘…’ or “…” or `…`");
  assert.equal(scrub("/var/mobile/Containers/Data/Application/1F2E3D4C-0000-1111-2222-333344445555/Documents/a"), "~/Documents/a");
});

test("telemetry: fingerprints ignore line numbers, build hashes and numbers in the message", () => {
  const a = fingerprint("window.error", "TypeError: x[3] is undefined", "at f (http://127.0.0.1:4610/assets/index-AbC12345.js:10:20)\nat g (index.js:3:4)");
  const b = fingerprint("window.error", "TypeError: x[7] is undefined", "at f (http://127.0.0.1:4611/assets/index-ZZZ98765.js:99:1)\nat g (index.js:8:9)");
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(a, fingerprint("react", "TypeError: x[3] is undefined", "at f (index.js:1:1)"));
});

test("telemetry: off under tests, with ETUDE_TELEMETRY=0, and in an automated browser unless forced", async () => {
  assert.equal(telemetryAllowed({ NODE_TEST_CONTEXT: "child" }), false);
  assert.equal(telemetryAllowed({ NODE_TEST_CONTEXT: "child", ETUDE_TELEMETRY: "1" }), true);
  assert.equal(telemetryAllowed({ ETUDE_TELEMETRY: "0" }), false);
  assert.equal(telemetryAllowed({ ETUDE_TELEMETRY: "off" }, false), false);
  assert.equal(telemetryAllowed({}), true);
  assert.equal(telemetryAllowed({}, true), false);
  assert.equal(telemetryAllowed({ ETUDE_TELEMETRY: "1" }, true), true);
  // In this test process nothing is active, started or not.
  const e = await open(home());
  assert.equal(telemetryFor(e).report({ kind: "x", message: "boom" }), false);
  startTelemetry(e, { fetch: fakeServer().fetch });
  assert.equal(telemetryFor(e).active, false);
  assert.equal(telemetryFor(e).report({ kind: "x", message: "boom" }), false);
  telemetryFor(e).stop();
  e.close();
});

test("telemetry: the etude command and agents never start it", async () => {
  await withEnv("1", async () => {
    const dir = home();
    const out: string[] = [];
    const code = await run(["deck", "create", "Spanish"], { stdout: (s) => out.push(s), stderr: () => {}, stdin: () => "", isTTY: false, env: { ETUDE_HOME: dir } });
    assert.equal(code, 0, out.join(""));
    assert.equal(existsSync(join(dir, "telemetry-queue.json")), false);
    // Opened like the CLI does (no startTelemetry): nothing is queued even with both switches on.
    const e = await open(dir);
    e.updateSettings({ privacy: { errorReports: true, usageStats: true } });
    assert.equal(telemetryFor(e).active, false);
    assert.equal(telemetryFor(e).count("deck.create"), false);
    assert.equal(telemetryFor(e).report({ kind: "x", message: "boom" }), false);
    e.close();
  });
});

test("telemetry: error reports on by default, usage counts off by default, both sent anonymously in batches", async () => {
  await withEnv("1", async () => {
    const dir = home();
    const e = await open(dir);
    assert.deepEqual(e.settings().privacy, { errorReports: true, usageStats: false });
    const srv = fakeServer();
    let clock = Date.parse("2026-11-04T08:00:00Z");
    const t = startTelemetry(e, { platform: "mac", os: "Darwin 25.1", fetch: srv.fetch, now: () => clock, server: "https://telemetry.test" });
    assert.equal(t.report({ kind: "window.error", message: 'TypeError: card "Hola" broke', stack: "at f (/Users/joao/x.js:1:2)" }), true);
    t.report({ kind: "window.error", message: 'TypeError: card "Hola" broke', stack: "at f (/Users/joao/x.js:1:2)" });
    assert.equal(t.count("card.reviewed"), false); // usage off
    const queued = readFileSync(join(dir, "telemetry-queue.json"), "utf8");
    assert.ok(!queued.includes("Hola") && !queued.includes("joao"), queued);
    let r = await t.flush();
    assert.deepEqual(r, { sentErrors: 1, sentCounters: 0 });
    assert.equal(srv.got.length, 1);
    assert.equal(srv.got[0].url, "https://telemetry.test/v1/telemetry/errors");
    const body = srv.got[0].body;
    assert.deepEqual(Object.keys(body).sort(), ["errors", "os", "platform", "version"]);
    assert.equal(body.platform, "mac");
    assert.equal(body.errors[0].message, 'TypeError: card "…" broke');
    assert.equal(body.errors[0].stack, "at f (~/x.js:1:2)");
    assert.equal(body.errors[0].count, 2);
    assert.deepEqual(Object.keys(body.errors[0]).sort(), ["count", "fingerprint", "kind", "message", "stack"]);
    assert.deepEqual(t.pending(), { errors: 0, counters: 0 });

    // Usage turned on: daily counters, app.open once a day, unknown names refused.
    e.updateSettings({ privacy: { errorReports: true, usageStats: true } });
    for (let i = 0; i < 3; i++) t.count("card.reviewed");
    t.count("app.open");
    t.count("app.open");
    assert.equal(t.count("deck.renamed"), false);
    r = await t.flush();
    assert.equal(r.sentCounters, 2);
    const ev = srv.got[1].body;
    assert.equal(srv.got[1].url, "https://telemetry.test/v1/telemetry/events");
    assert.deepEqual(Object.keys(ev).sort(), ["counters", "platform", "version"]);
    assert.deepEqual(ev.counters.sort((a: any, b: any) => a.name.localeCompare(b.name)), [
      { day: "2026-11-04", name: "app.open", count: 1 },
      { day: "2026-11-04", name: "card.reviewed", count: 3 },
    ]);
    // The next day app.open counts again.
    clock += 86400_000;
    t.count("app.open");
    t.count("app.open");
    await t.flush();
    assert.deepEqual(srv.got[2].body.counters, [{ day: "2026-11-05", name: "app.open", count: 1 }]);
    t.stop();
    e.close();
  });
});

test("telemetry: kept on network errors, 429 and 5xx; dropped on a refusal; dropped after 7 days", async () => {
  await withEnv("1", async () => {
    const e = await open(home());
    e.updateSettings({ privacy: { errorReports: true, usageStats: true } });
    let status = 0;
    const srv = fakeServer(() => status);
    let clock = Date.parse("2026-11-04T08:00:00Z");
    const t = startTelemetry(e, { platform: "linux", os: "Linux 7.2", fetch: srv.fetch, now: () => clock });
    t.report({ kind: "core.error", message: "boom" });
    t.count("deck.create");
    for (status of [0, 429, 503]) {
      assert.deepEqual(await t.flush(), { sentErrors: 0, sentCounters: 0 });
      assert.deepEqual(t.pending(), { errors: 1, counters: 1 });
    }
    status = 422;
    await t.flush();
    assert.deepEqual(t.pending(), { errors: 0, counters: 0 });
    // A week offline: dropped unsent.
    status = 0;
    t.report({ kind: "core.error", message: "later" });
    t.count("deck.create");
    clock += 8 * 86400_000;
    status = 200;
    const before = srv.got.length;
    assert.deepEqual(await t.flush(), { sentErrors: 0, sentCounters: 0 });
    assert.equal(srv.got.length, before);
    assert.deepEqual(t.pending(), { errors: 0, counters: 0 });
    t.stop();
    e.close();
  });
});

test("telemetry: turning a switch off drops what was queued at once and stops sending", async () => {
  await withEnv("1", async () => {
    const dir = home();
    const e = await open(dir);
    e.updateSettings({ privacy: { errorReports: true, usageStats: true } });
    const srv = fakeServer();
    startTelemetry(e, { platform: "web", os: "Linux", fetch: srv.fetch });
    const app = createApp(e);
    const req = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    // The window's report and event routes, and the route-based counters.
    assert.deepEqual(await (await req("POST", "/api/telemetry/report", { kind: "window.error", message: "TypeError: boom", stack: "at x" })).json(), { queued: true });
    assert.deepEqual(await (await req("POST", "/api/telemetry/event", { name: "market.open" })).json(), { counted: true });
    assert.equal((await req("POST", "/api/telemetry/event", { name: "nope" })).status, 400);
    assert.equal((await req("POST", "/api/decks", { name: "French" })).status < 300, true);
    const status = await (await req("GET", "/api/telemetry")).json();
    assert.equal(status.active, true);
    assert.deepEqual(status.pending, { errors: 1, counters: 2 });
    // Off in Settings → Privacy: gone from the queue before anything is sent.
    await req("PATCH", "/api/settings", { privacy: { errorReports: false, usageStats: false } });
    assert.deepEqual((await (await req("GET", "/api/telemetry")).json()).pending, { errors: 0, counters: 0 });
    assert.equal(JSON.parse(readFileSync(join(dir, "telemetry-queue.json"), "utf8")).errors.length, 0);
    assert.deepEqual(await (await req("POST", "/api/telemetry/report", { message: "again" })).json(), { queued: false });
    await req("POST", "/api/decks", { name: "German" });
    await req("POST", "/api/telemetry/flush");
    assert.equal(srv.got.length, 0);
    // Only true or false.
    assert.equal((await req("PATCH", "/api/settings", { privacy: { usageStats: "yes" } })).status, 400);
    telemetryFor(e).stop();
    e.close();
  });
});

test("telemetry: route counters and the event list", () => {
  assert.equal(usageEventFor("POST", "/api/study/submit"), "card.reviewed");
  assert.equal(usageEventFor("POST", "/api/anki/import"), "import.anki");
  assert.equal(usageEventFor("PUT", "/api/types/basic"), "type.edit");
  assert.equal(usageEventFor("PUT", "/api/types/basic/prefs"), null);
  assert.equal(usageEventFor("POST", "/api/agent/conversations/c1/messages"), "ask.message");
  assert.equal(usageEventFor("GET", "/api/decks"), null);
  assert.equal(new Set(EVENT_NAMES).size, EVENT_NAMES.length);
  assert.equal(osFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X)"), "iOS 26.1");
  assert.equal(osFromUserAgent("Mozilla/5.0 (Linux; Android 16; Pixel 9)"), "Android 16");
});
