// Sharing end to end, by hand (not part of `npm test`): a fake etude-cloud with no vault secret and nobody on Sync,
// three devices with their own ETUDE_HOME and collection (Ann's, Bob's laptop, then Bob's phone), signed in through the
// fake email outbox, everything driven through each app's /api/share.
//
//   node test/e2e/share-two-devices.ts [path to an etude-cloud checkout with sharing]
//
// Starts the server on a free port with a throwaway data dir and stops it at the end.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { Etude } from "../../src/core/engine.ts";
import { createApp } from "../../src/server/app.ts";
import { accountFor } from "../../src/core/account.ts";
import { docFromText } from "../../src/core/notes.ts";

const CLOUD = process.argv[2] ?? join(process.env.HOME ?? "", "dev/etude-cloud-wt/shared-spaces");
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "share-e2e-"));
const port = await new Promise<number>((r) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const p = (s.address() as any).port;
    s.close(() => r(p));
  });
});
const url = `http://127.0.0.1:${port}`;
const data = join(scratch, "cloud");
const cloud = spawn(process.execPath, ["src/main.ts"], {
  cwd: CLOUD,
  env: { ...process.env, ETUDE_CLOUD_PORT: String(port), ETUDE_CLOUD_PUBLIC_URL: url, ETUDE_CLOUD_PROVIDERS: "fake", ETUDE_CLOUD_BILLING: "off", ETUDE_CLOUD_RATE_LIMIT: "off", ETUDE_CLOUD_DATA_DIR: data, ETUDE_CLOUD_VAULT_SECRET: "", NODE_ENV: "development" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
cloud.stdout.on("data", (b) => (log += b));
cloud.stderr.on("data", (b) => (log += b));
const steps: string[] = [];
const step = (s: string) => {
  steps.push(s);
  console.log("ok  " + s);
};
const devices: Etude[] = [];

async function main() {
  for (let i = 0; i < 100; i++) {
    if (await fetch(url + "/v1/health").then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
    if (i === 99) throw new Error("the fake cloud didn't start:\n" + log);
  }
  step(`fake cloud on ${url}`);

  async function device(name: string, email: string) {
    const home = join(scratch, name);
    const e = await Etude.open(join(scratch, `${name}.db`), { home });
    devices.push(e);
    const app = createApp(e);
    const api = async (method: string, path: string, body?: unknown) => {
      const r = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw Object.assign(new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`), { status: r.status, body: j });
      return j;
    };
    await api("PUT", "/api/account/server", { server: url });
    await api("POST", "/api/account/signin", { email });
    // The code is in the newest mail to this address.
    let code: string | null = null;
    for (let i = 0; i < 50 && !code; i++) {
      const dir = join(data, "outbox");
      const mails = existsSync(dir) ? readdirSync(dir).sort().reverse().map((f) => JSON.parse(readFileSync(join(dir, f), "utf8"))) : [];
      const m = mails.find((x) => x.to === email && /\b\d{3} ?\d{3}\b/.test(x.text));
      code = m ? /\b(\d{3}) ?(\d{3})\b/.exec(m.text)!.slice(1).join("") : null;
      if (!code) await new Promise((r) => setTimeout(r, 100));
    }
    if (!code) throw new Error(`no sign-in code for ${email}`);
    await api("POST", "/api/account/verify", { code, email });
    assert.equal(accountFor(e).email(), email);
    return { e, api };
  }
  const A = await device("ann", "ann@example.com");
  const B = await device("bob", "bob@example.com");
  step("two accounts signed in through the outbox");

  const course = A.e.notes.create({ title: "CMPT 307", kind: "folder" });
  const page = A.e.notes.create({ title: "Week 1", parentId: course.id, doc: docFromText("intro\n\nmiddle\n\nend") });
  const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  const pic = A.e.storeMedia("dot.png", png).file;
  const pics = A.e.notes.create({ title: "Pictures", parentId: course.id, doc: { type: "doc", content: [{ type: "image", attrs: { src: `/media/${pic}` } }] } });

  // No Sync set up anywhere and no vault secret on the server: each device makes its own keypair, and only the
  // public half goes up.
  const { space } = await A.api("POST", "/api/share", { noteId: course.id });
  assert.equal(space.role, "owner");
  const annKey = await accountFor(A.e).json("GET", "/v1/identity");
  assert.equal(annKey.deviceId, await accountFor(A.e).deviceId());
  assert.equal(annKey.publicKey, secretsOf(A.e).device.publicKey);
  assert.equal(JSON.stringify(annKey).includes(secretsOf(A.e).device.privateKey), false);
  assert.equal((await accountFor(B.e).request("GET", "/v1/identity").catch((e) => e)).code, "no_identity");
  step(`Ann shares "CMPT 307" (${space.id})`);
  const inv = await A.api("POST", `/api/share/${space.id}/invite`, { email: "bob@example.com", role: "edit" });
  assert.equal(inv.member.hasKey, false);
  // Bob's laptop had no keypair yet: its next pass makes one, Ann's next pass wraps the key for it.
  assert.equal((await B.api("POST", "/api/share/sync")).invites[0].name, null);
  await A.api("POST", "/api/share/sync");
  const list = await B.api("POST", "/api/share/sync");
  assert.equal(list.invites.length, 1);
  assert.equal(list.invites[0].name, "CMPT 307");
  step("Bob sees the invite with the folder's name (decrypted on his device)");
  const acc = await B.api("POST", `/api/share/${space.id}/accept`, {});
  assert.equal(acc.rootId, course.id);
  assert.equal(B.e.notes.get(page.id).text, "intro\nmiddle\nend");
  assert.deepEqual(new Uint8Array(readFileSync(join(B.e.mediaDir, pic))), png);
  step("Bob accepts: pages and the picture arrive");

  A.e.notes.update(page.id, { title: "Week 1 · Greedy" });
  await A.api("POST", "/api/share/sync");
  await B.api("POST", "/api/share/sync");
  assert.equal(B.e.notes.get(page.id).title, "Week 1 · Greedy");
  const bobs = B.e.notes.create({ title: "Bob's page", parentId: course.id, doc: docFromText("from bob") });
  await B.api("POST", "/api/share/sync");
  await A.api("POST", "/api/share/sync");
  assert.equal(A.e.notes.get(bobs.id).text, "from bob");
  step("edits go both ways");

  // A self-contained web file bigger than one event (fonts and pictures inlined) travels as an encrypted blob.
  const bigHtml = "<div>" + "x".repeat(2_500_000) + "</div>";
  const big = A.e.notes.create({ title: "Design round", parentId: course.id, kind: "web", content: bigHtml });
  await A.api("POST", "/api/share/sync");
  await B.api("POST", "/api/share/sync");
  assert.equal(B.e.notes.get(big.id).content, bigHtml);
  assert.equal((await A.api("GET", "/api/share")).spaces[0].error, null);
  step("a 2.5 MB web file arrives whole (state sent as a blob)");

  // Bob signs in on his phone: a third collection, same account, no action of his. Its first pass makes its keypair
  // and adds the shared folder, waiting for a key; Bob's laptop (or Ann's device) wraps it on its next pass.
  const P = await device("bob-phone", "bob@example.com");
  const first = await P.api("POST", "/api/share/auto");
  assert.deepEqual(first.invites, []);
  assert.equal(first.spaces.length, 1);
  assert.equal(first.spaces[0].waitingKey, true);
  assert.equal(first.spaces[0].error, null);
  await B.api("POST", "/api/share/sync");
  const phone = await P.api("POST", "/api/share/sync");
  assert.equal(phone.spaces[0].waitingKey, false);
  assert.equal(phone.spaces[0].rootId, course.id);
  assert.equal(P.e.notes.get(page.id).title, "Week 1 · Greedy");
  assert.equal(P.e.notes.get(bobs.id).text, "from bob");
  assert.deepEqual(new Uint8Array(readFileSync(join(P.e.mediaDir, pic))), png);
  const wraps = (await accountFor(A.e).json("GET", `/v1/spaces/${space.id}`)).space.members.find((m: any) => m.email === "bob@example.com");
  assert.equal(wraps.devices.length, 2);
  assert.equal(wraps.hasKey, true);
  P.e.notes.update(bobs.id, { title: "Bob's page (phone)" });
  await P.api("POST", "/api/share/sync");
  await A.api("POST", "/api/share/sync");
  await B.api("POST", "/api/share/sync");
  assert.equal(A.e.notes.get(bobs.id).title, "Bob's page (phone)");
  assert.equal(B.e.notes.get(bobs.id).title, "Bob's page (phone)");
  step("Bob's phone gets the shared folder by itself, its key handed over by his laptop, and edits from it");

  A.e.notes.update(page.id, { doc: docFromText("INTRO\n\nmiddle\n\nend") });
  B.e.notes.update(page.id, { doc: docFromText("intro\n\nmiddle\n\nEND") });
  for (let i = 0; i < 2; i++) {
    await A.api("POST", "/api/share/sync");
    await B.api("POST", "/api/share/sync");
  }
  assert.equal(A.e.notes.get(page.id).text, "INTRO\nmiddle\nEND");
  assert.equal(B.e.notes.get(page.id).text, "INTRO\nmiddle\nEND");
  step("concurrent edits to different blocks merge on both devices");

  const detail = await A.api("GET", `/api/share/note/${page.id}`);
  assert.deepEqual(detail.space.members.map((m: any) => [m.email, m.role]), [["ann@example.com", "owner"], ["bob@example.com", "edit"]]);
  await A.api("PATCH", `/api/share/${space.id}/members/bob@example.com`, { role: "view" });
  await B.api("POST", "/api/share/sync");
  await P.api("POST", "/api/share/sync");
  assert.equal(B.e.notes.get(page.id).share?.readonly, true);
  assert.equal(P.e.notes.get(page.id).share?.readonly, true);
  const refused = await app403(B, `/api/notes/${page.id}`, { title: "nope" });
  assert.equal(refused, 403);
  step("Bob as viewer: his write is refused with 403");

  await A.api("DELETE", `/api/share/${space.id}/members/bob@example.com`);
  A.e.notes.update(page.id, { title: "After removal" });
  await A.api("POST", "/api/share/sync");
  const after = await B.api("POST", "/api/share/sync");
  assert.equal(after.spaces[0].status, "removed");
  assert.equal((await P.api("POST", "/api/share/sync")).spaces[0].status, "removed");
  assert.equal(P.e.notes.get(page.id).title, "Week 1 · Greedy");
  assert.equal((await accountFor(A.e).json("GET", `/v1/spaces/${space.id}`)).space.epoch, 3);
  assert.equal(B.e.notes.get(page.id).title, "Week 1 · Greedy");
  assert.equal(B.e.notes.get(pics.id).share?.readonly, true);
  step("removal: the key rotates, Bob keeps a read-only copy and gets nothing new");

  await A.api("DELETE", `/api/share/${space.id}`);
  assert.equal(A.e.notes.get(page.id).title, "After removal");
  assert.equal(A.e.notes.get(page.id).share, undefined);
  assert.deepEqual((await A.api("GET", "/api/share")).spaces, []);
  step("stop sharing: Ann's notes stay, unshared");
}

/** A device's share secrets file: its own keypair and the space keys it holds. */
function secretsOf(e: Etude) {
  const dir = join(e.home, "share");
  return JSON.parse(readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith(".json"))!), "utf8"));
}

/** The status of a PATCH to the notes API, which should be refused. */
async function app403(d: { api: (m: string, p: string, b?: unknown) => Promise<any> }, path: string, body: unknown) {
  try {
    await d.api("PATCH", path, body);
    return 200;
  } catch (e) {
    return (e as { status: number }).status;
  }
}

let failed = false;
try {
  await main();
  console.log(`\nPASS: ${steps.length} steps`);
} catch (e) {
  failed = true;
  console.error(`\nFAIL after ${steps.length} steps: ${(e as Error).stack}`);
  if (log) console.error("\ncloud log tail:\n" + log.split("\n").slice(-20).join("\n"));
} finally {
  for (const e of devices) e.close();
  cloud.kill("SIGTERM");
  await new Promise((r) => cloud.once("exit", r));
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
