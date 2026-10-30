import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudTransport, FolderTransport } from "../src/core/sync/transport.ts";

test("folder sync: event files avoid colons (Windows can't name files with them) and older files with colons still read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "etude-folder-"));
  try {
    await new FolderTransport(dir, "aaaa").push([{ id: "aaaa:1793379461315:0", ciphertext: "x" }]);
    assert.deepEqual(readdirSync(join(dir, "events", "aaaa")), ["aaaa~1793379461315~0.json"]);
    if (process.platform !== "win32") {
      mkdirSync(join(dir, "events", "bbbb"));
      writeFileSync(join(dir, "events", "bbbb", "bbbb:5:0.json"), JSON.stringify({ id: "bbbb:5:0", ciphertext: "y" }));
    }
    const ids = (await new FolderTransport(dir, "cccc").pull("")).events.map((e) => e.id).sort();
    assert.deepEqual(ids, process.platform === "win32" ? ["aaaa:1793379461315:0"] : ["aaaa:1793379461315:0", "bbbb:5:0"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the cloud transport waits out 429 Too Many Requests and retries", async () => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    if (hits <= 2) {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" });
      res.end(JSON.stringify({ error: { code: "rate_limited", message: "Too many requests. Try again in 1 s." } }));
      return;
    }
    assert.equal(req.headers.authorization, "Bearer etd_test");
    res.end("blob bytes");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const t = new CloudTransport(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, "etd_test");
    const started = Date.now();
    assert.equal(new TextDecoder().decode(await t.getBlob("a".repeat(64))), "blob bytes");
    assert.equal(hits, 3);
    assert.ok(Date.now() - started >= 2000, "waited Retry-After each time");
  } finally {
    server.close();
  }
});

test("other errors still fail at once with the server's message", async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.writeHead(402, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "no_entitlement", message: "Sync isn't active on this account." } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const t = new CloudTransport(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, "etd_test");
    await assert.rejects(t.getBlob("a".repeat(64)), /Sync isn't active/);
    assert.equal(hits, 1);
  } finally {
    server.close();
  }
});
