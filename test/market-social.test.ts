import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Etude } from "../src/core/engine.ts";
import { accountFor, AccountError, marketKey, pingFreeInstall } from "../src/core/account.ts";
import { DEFAULT_MARKET, entryJson, entryPath, type MarketFile } from "../src/core/market.ts";
import { createApp } from "../src/server/app.ts";
import { agentRefusal } from "../src/core/agent-guard.ts";
import { COMMANDS } from "../src/cli/registry.ts";
import "../src/cli/commands/index.ts";

const tmp = (p: string) => mkdtempSync(join(process.env.TMPDIR || tmpdir(), p));

/** Just the social routes of etude-cloud, recording what each request carried. */
function fakeCloud() {
  const seen: { method: string; path: string; auth: string; body: any }[] = [];
  let votes = new Map<string, number>();
  const comments: any[] = [];
  const srv = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url ?? "/", "http://x");
    const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    seen.push({ method: req.method!, path: url.pathname + url.search, auth, body });
    const send = (status: number, data: unknown) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(data)));
    const signedIn = auth === "etd_tok";
    const counts = (key: string) => ({ likes: [...votes.values()].filter((v) => v === 1).length, dislikes: [...votes.values()].filter((v) => v === -1).length, downloads: 0, comments: comments.filter((c) => c.key === key).length });
    if (url.pathname === "/v1/auth/email/verify") return send(200, { token: "etd_tok", account: { id: "acc_1", email: "a@example.test" } });
    if (url.pathname === "/v1/auth/email/start") return send(200, { ok: true });
    if (url.pathname === "/v1/market/stats") return send(200, { entries: { "deck/x1": counts("deck/x1") } });
    if (url.pathname === "/v1/market/entry-stats") return send(200, { key: url.searchParams.get("key"), ...counts(url.searchParams.get("key")!), ...(signedIn ? { myVote: votes.get("acc_1") ?? 0 } : {}) });
    if (url.pathname === "/v1/market/downloads") return send(200, { counted: true });
    if (url.pathname === "/v1/market/comments" && req.method === "GET") return send(200, { key: url.searchParams.get("key"), comments: comments.map((c) => ({ ...c, mine: signedIn })), next: null });
    if (!signedIn) return send(401, { error: { code: "unauthorized", message: "Sign in first" } });
    if (url.pathname === "/v1/market/votes") {
      votes = new Map(votes);
      if (body.value === 0) votes.delete("acc_1");
      else votes.set("acc_1", body.value);
      return send(200, { key: body.key, ...counts(body.key), myVote: body.value });
    }
    if (url.pathname === "/v1/market/comments" && req.method === "POST") {
      const c = { id: `cmt_${comments.length + 1}`, key: body.key, body: body.body, author: { id: "au_aaaaaaaaaaaaaaaa", name: "Ana" }, created: new Date(0).toISOString(), edited: null };
      comments.unshift(c);
      return send(201, { comment: { ...c, mine: true } });
    }
    if (/^\/v1\/market\/comments\/[^/]+\/report$/.test(url.pathname)) return send(200, { ok: true, counted: true, hidden: false });
    if (/^\/v1\/market\/comments\/[^/]+$/.test(url.pathname) && req.method === "PATCH") return send(200, { comment: { ...comments[0], body: body.body, edited: new Date(1).toISOString(), mine: true } });
    if (/^\/v1\/market\/comments\/[^/]+$/.test(url.pathname) && req.method === "DELETE") return send(200, { ok: true, deleted: url.pathname.split("/").pop() });
    if (url.pathname === "/v1/market/blocks") return send(200, { blocks: [] });
    if (url.pathname.startsWith("/v1/market/blocks/")) return send(200, req.method === "POST" ? { ok: true, blocked: url.pathname.split("/").pop() } : { ok: true, unblocked: url.pathname.split("/").pop() });
    return send(404, { error: { code: "not_found", message: url.pathname } });
  });
  return {
    seen,
    async start() {
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    },
    stop: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

/** A port nothing listens on: a server that is down. */
async function deadUrl() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  await new Promise<void>((r) => s.close(() => r()));
  return url;
}

async function signedIn(url: string) {
  const dir = tmp("market-social-");
  const e = await Etude.open(join(dir, "etude.db"), { home: join(dir, "home") });
  const a = accountFor(e);
  a.setServer(url);
  await a.signin("a@example.test");
  await a.verify("482913");
  return { e, a, dir };
}

test("market social: client calls send the token only where it adds something, and keys are checked first", async () => {
  const cloud = fakeCloud();
  const url = await cloud.start();
  const dir = tmp("market-social-");
  const e = await Etude.open(join(dir, "etude.db"), { home: join(dir, "home") });
  try {
    const a = accountFor(e);
    a.setServer(url);
    // Signed out: reading works, writing asks to sign in without a request.
    assert.deepEqual((await a.entryStats("deck/x1")).myVote, undefined);
    assert.equal(cloud.seen.at(-1)!.auth, "");
    await assert.rejects(a.vote("deck/x1", 1), (err: AccountError) => err.code === "signed_out");
    assert.throws(() => marketKey("deck/../x"), /isn't a Market entry/);
    assert.throws(() => marketKey("x1"), /isn't a Market entry/);
    assert.equal(marketKey(" theme/nord "), "theme/nord");
    assert.equal(marketKey("paid/lst_" + "A".repeat(22)), "paid/lst_" + "A".repeat(22));
    await assert.rejects(a.comments("bogus"), /isn't a Market entry/);

    await a.signin("a@example.test");
    await a.verify("482913");
    const v = await a.vote("deck/x1", 1);
    assert.equal(v.myVote, 1);
    assert.deepEqual(cloud.seen.at(-1), { method: "PUT", path: "/v1/market/votes", auth: "etd_tok", body: { key: "deck/x1", value: 1 } });
    assert.equal((await a.entryStats("deck/x1")).myVote, 1);
    assert.equal(cloud.seen.at(-1)!.auth, "etd_tok", "entry-stats sends the token when signed in");
    await a.marketStats();
    assert.equal(cloud.seen.at(-1)!.auth, "", "the all-entries stats are public and cacheable");

    const posted = await a.postComment("deck/x1", "Great deck");
    assert.equal(posted.comment.body, "Great deck");
    const page = await a.comments("deck/x1", "cmt_9");
    assert.equal(cloud.seen.at(-1)!.path, "/v1/market/comments?key=deck%2Fx1&before=cmt_9");
    assert.equal(cloud.seen.at(-1)!.auth, "etd_tok", "comments send the token so blocked authors are left out");
    assert.equal(page.comments[0].mine, true);
    assert.equal((await a.editComment("cmt_1", "Edited")).comment.body, "Edited");
    assert.deepEqual(await a.reportComment("cmt_1", "spam"), { ok: true, counted: true, hidden: false });
    assert.deepEqual(cloud.seen.at(-1)!.body, { reason: "spam" });
    assert.deepEqual(await a.block("au_aaaaaaaaaaaaaaaa"), { ok: true, blocked: "au_aaaaaaaaaaaaaaaa" });
    assert.deepEqual(await a.unblock("au_aaaaaaaaaaaaaaaa"), { ok: true, unblocked: "au_aaaaaaaaaaaaaaaa" });
    assert.deepEqual(await a.deleteComment("cmt_1"), { ok: true, deleted: "cmt_1" });

    // The same calls through the app's own API (what the web UI and the browser/native worker use).
    const app = createApp(e);
    const r = await app.request("/api/account/market/votes", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "deck/x1", value: -1 }) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).myVote, -1);
    assert.equal((await app.request("/api/account/market/votes", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "deck/x1", value: 5 }) })).status, 400);
    const st = await (await app.request("/api/account/market/stats")).json();
    assert.ok(st.entries["deck/x1"]);
    const cm = await app.request("/api/account/market/comments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "deck/x1", body: "hello" }) });
    assert.equal((await cm.json()).comment.body, "hello");
    assert.equal((await app.request("/api/account/market/comments?key=deck%2Fx1")).status, 200);
    assert.equal((await app.request("/api/account/market/comments/cmt_2/report", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 200);
    assert.equal((await app.request("/api/account/market/blocks/au_aaaaaaaaaaaaaaaa", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 200);
    assert.equal((await app.request("/api/account/market/entry-stats?key=bad")).status, 400);
  } finally {
    e.close();
    await cloud.stop();
  }
});

test("market social: the download ping is anonymous, official catalog only, and never fails an install", async () => {
  const cloud = fakeCloud();
  const url = await cloud.start();
  const { e, a } = await signedIn(url);
  // A one-theme market, served as if it were the official catalog.
  const root = tmp("market-official-");
  const theme: MarketFile = { etudeMarket: 1, kind: "theme", id: "sea-glass", name: "Sea glass", author: "ana", description: "", tags: [], version: "1", content: { id: "sea-glass", name: "Sea glass", scheme: "dark", vars: { "--highlight": "oklch(0.7 0.13 200)" } } } as any;
  mkdirSync(join(root, "entries", "themes"), { recursive: true });
  writeFileSync(join(root, entryPath("theme", "sea-glass")), entryJson(theme));
  writeFileSync(join(root, "index.json"), JSON.stringify({ etude: "market/1", repo: DEFAULT_MARKET.repo, entries: [{ kind: "theme", id: "sea-glass", name: "Sea glass", author: "ana", description: "", tags: [], version: "1", updated: "1", bytes: 1, path: entryPath("theme", "sea-glass") }] }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const u = String(input?.url ?? input);
    if (u.startsWith(DEFAULT_MARKET.url + "/")) return new Response(readFileSync(join(root, u.slice(DEFAULT_MARKET.url.length + 1))));
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    // Custom catalogs and dry runs send nothing; unchanged reinstalls neither.
    const n0 = cloud.seen.length;
    assert.equal(await pingFreeInstall(e, { entry: { kind: "theme", id: "sea-glass" }, result: "created", dryRun: false }, "/some/folder"), null);
    assert.equal(await pingFreeInstall(e, { entry: { kind: "theme", id: "sea-glass" }, result: "created", dryRun: true }, DEFAULT_MARKET.url), null);
    assert.equal(await pingFreeInstall(e, { entry: { kind: "theme", id: "sea-glass" }, result: "unchanged", dryRun: false }, DEFAULT_MARKET.url), null);
    assert.equal(cloud.seen.length, n0);

    // A real install through the app's route: the ping goes out without the token.
    const app = createApp(e);
    const r = await app.request("/api/market/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "sea-glass" }) });
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal((await r.json()).result, "created");
    for (let i = 0; i < 50 && !cloud.seen.some((s) => s.path === "/v1/market/downloads"); i++) await new Promise((res) => setTimeout(res, 20));
    const ping = cloud.seen.find((s) => s.path === "/v1/market/downloads")!;
    assert.ok(ping, "the install sent a download ping");
    assert.deepEqual(ping.body, { key: "theme/sea-glass" });
    assert.equal(ping.auth, "", "no token, so the count can't be tied to the account");

    // The cloud goes down: installing (here, a changed version) still works, and the ping just gives up.
    await cloud.stop();
    const dead = await deadUrl();
    await a.signout().catch(() => {});
    a.setServer(dead);
    writeFileSync(join(root, entryPath("theme", "sea-glass")), entryJson({ ...theme, version: "2", content: { ...(theme as any).content, vars: { "--highlight": "oklch(0.6 0.1 150)" } } } as any));
    const r2 = await app.request("/api/market/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "sea-glass" }) });
    assert.equal(r2.status, 200);
    assert.equal((await r2.json()).result, "updated");
    assert.equal(await a.marketDownload("theme/sea-glass", 500), null, "an unreachable server answers null, never throws");
  } finally {
    globalThis.fetch = realFetch;
    e.close();
    await cloud.stop().catch(() => {});
  }
});

test("market social: the CLI has every action, and Ask Etude may read but not vote, comment, report or block", () => {
  const names = new Set(COMMANDS.map((c) => c.name));
  for (const n of ["market stats", "market vote", "market comments", "market comment", "market comment-edit", "market comment-delete", "market report", "market block", "market unblock", "market blocks"]) assert.ok(names.has(n), n);
  const cmd = (name: string) => COMMANDS.find((c) => c.name === name)!;
  const g = (name: string) => agentRefusal({ cmd: cmd(name), values: {}, named: {}, attachmentDir: process.env.TMPDIR || tmpdir() });
  for (const ok of ["market stats", "market comments", "market blocks"]) assert.equal(g(ok), null, ok);
  for (const no of ["market vote", "market comment", "market comment-edit", "market comment-delete", "market report", "market block", "market unblock"]) assert.match(g(no) ?? "", /can't vote, comment, report or block/, no);
});
