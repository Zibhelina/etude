import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTransient, retryTransient, RETRY_BASE_MS } from "../src/core/net-retry.ts";
import { CloudTransport } from "../src/core/sync/transport.ts";
import { Etude } from "../src/core/engine.ts";
import { accountFor } from "../src/core/account.ts";

/** What Node's fetch throws when Caddy refuses a stream on a busy HTTP/2 connection. */
const calm = () => new TypeError("fetch failed", { cause: Object.assign(new Error("Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM"), { code: "ERR_HTTP2_STREAM_ERROR" }) });

/** Swaps global fetch for one that fails the first `fails` calls with `err`, then answers 200. */
function stubFetch(t: any, fails: number, err: () => unknown = calm, body: unknown = { ok: true }) {
  const real = globalThis.fetch;
  const calls: { url: string; method: string }[] = [];
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    if (calls.length <= fails) throw err();
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const base = RETRY_BASE_MS.value;
  RETRY_BASE_MS.value = 1;
  t.after(() => ((globalThis.fetch = real), (RETRY_BASE_MS.value = base)));
  return calls;
}

test("transient errors: stream and connection failures, through cause chains; HTTP answers and aborts aren't", () => {
  assert.ok(isTransient(calm()));
  assert.ok(isTransient(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } })));
  assert.ok(isTransient(new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET", message: "other side closed" } })));
  assert.ok(isTransient(Object.assign(new Error("x"), { code: "ERR_HTTP2_STREAM_ERROR" })));
  assert.ok(!isTransient(new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } })));
  assert.ok(!isTransient(new TypeError("fetch failed")));
  assert.ok(!isTransient(new DOMException("timed out", "TimeoutError")));
  assert.ok(!isTransient(new Error("Sync server returned 500")));
});

test("retryTransient: up to 3 more tries, then the error", async (t) => {
  stubFetch(t, 0);
  let n = 0;
  assert.equal(await retryTransient(async () => (++n < 4 ? Promise.reject(calm()) : "done")), "done");
  assert.equal(n, 4);
  n = 0;
  await assert.rejects(retryTransient(async () => (n++, Promise.reject(calm()))), /fetch failed/);
  assert.equal(n, 4);
  n = 0;
  await assert.rejects(retryTransient(async () => (n++, Promise.reject(new Error("bad request")))), /bad request/);
  assert.equal(n, 1);
});

test("Sync's transport retries a blob upload and an events pull that hit a refused stream", async (t) => {
  const calls = stubFetch(t, 2);
  const tr = new CloudTransport("https://sync.example", "tok");
  await tr.putBlob("a".repeat(64), new Uint8Array([1, 2, 3]));
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.method), ["PUT", "PUT", "PUT"]);
  calls.length = 0;
  // Four failures in a row is more than a hiccup: it surfaces.
  const calls2 = stubFetch(t, 4);
  await assert.rejects(tr.pull("0"), /fetch failed/);
  assert.equal(calls2.length, 4);
});

test("the account client retries what's safe to repeat (GET, PUT, events), not other POSTs", async (t) => {
  const home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "net-retry-"));
  writeFileSync(join(home, "account.json"), JSON.stringify({ server: "https://sync.example", token: "tok", email: "a@example.com", accountId: "acc_a", deviceId: "dev_a" }));
  const e = await Etude.open(":memory:", { home });
  t.after(() => (e.close(), rmSync(home, { recursive: true, force: true })));
  const a = accountFor(e);
  let calls = stubFetch(t, 2);
  await a.json("GET", "/v1/spaces");
  assert.equal(calls.length, 3);
  calls = stubFetch(t, 1);
  await a.request("PUT", "/v1/spaces/spc_1/blobs/" + "b".repeat(64), { raw: new Uint8Array([1]) });
  assert.equal(calls.length, 2);
  calls = stubFetch(t, 1);
  await a.json("POST", "/v1/spaces/spc_1/events", { events: [] });
  assert.equal(calls.length, 2);
  calls = stubFetch(t, 1);
  await assert.rejects(a.json("POST", "/v1/spaces", {}), /couldn't reach/);
  assert.equal(calls.length, 1);
});
