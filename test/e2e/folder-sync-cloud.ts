// A folder on a computer synced through a real etude-cloud server, by hand (not part of `npm test`): a fake cloud
// with a throwaway data dir, two devices with their own ETUDE_HOME and collection signed in through the fake email
// outbox, and a folder that travels between them over HTTP: first sync, edits both ways, a file of a few megabytes,
// a conflict, a removal, old versions leaving the vault, and sync ended for every device. At the end the server's
// data dir is searched for the files' text: it holds ciphertext only.
//
//   node test/e2e/folder-sync-cloud.ts [path to an etude-cloud checkout]
//
// Starts the server on a free port and stops it at the end. Never point it at a real server or a real collection.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { Etude } from "../../src/core/engine.ts";
import { syncFor } from "../../src/core/sync/client.ts";

const CLOUD = process.argv[2] ?? join(process.env.HOME ?? "", "dev/etude-cloud");
const scratch = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "folder-cloud-e2e-")));
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
  env: { ...process.env, ETUDE_CLOUD_PORT: String(port), ETUDE_CLOUD_PUBLIC_URL: url, ETUDE_CLOUD_PROVIDERS: "fake", ETUDE_CLOUD_BILLING: "off", ETUDE_CLOUD_RATE_LIMIT: "off", ETUDE_CLOUD_DATA_DIR: data, NODE_ENV: "development" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
cloud.stdout.on("data", (b) => (log += b));
cloud.stderr.on("data", (b) => (log += b));
const step = (s: string) => console.log("ok  " + s);
const devices: Etude[] = [];
const password = "a test Sync password";
const email = "ann@example.com";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let clock = 0;
/** Writes a file with a time of its own, so a rewrite of the same length in the same millisecond still counts as changed. */
const write = (path: string, content: string | Uint8Array) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  clock += 5000;
  utimesSync(path, new Date(), new Date(Date.now() + clock));
};
const read = (path: string) => readFileSync(path, "utf8");
/** Every file under a directory, with its size. */
const files = (dir: string): { path: string; size: number }[] =>
  !existsSync(dir) ? [] : readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : [{ path: join(dir, d.name), size: statSync(join(dir, d.name)).size }]));

async function main() {
  for (let i = 0; i < 100; i++) {
    if (await fetch(url + "/v1/health").then((r) => r.ok, () => false)) break;
    await sleep(100);
    if (i === 99) throw new Error("the fake cloud didn't start:\n" + log);
  }
  step(`fake cloud on ${url}, from ${CLOUD}`);

  async function device(name: string) {
    const e = await Etude.open(join(scratch, `${name}.db`), { home: join(scratch, name) });
    devices.push(e);
    const s = syncFor(e);
    s.setup({ server: url });
    await s.signin(email);
    // The code is in the newest mail to this address that this device hasn't used.
    let code: string | null = null;
    for (let i = 0; i < 50 && !code; i++) {
      const dir = join(data, "outbox");
      const mails = existsSync(dir) ? readdirSync(dir).sort().reverse().map((f) => JSON.parse(readFileSync(join(dir, f), "utf8"))) : [];
      const m = mails.find((x) => x.to === email && /\b\d{3} ?\d{3}\b/.test(x.text) && !used.has(x.text));
      if (m) used.add(m.text);
      code = m ? /\b(\d{3}) ?(\d{3})\b/.exec(m.text)!.slice(1).join("") : null;
      if (!code) await sleep(100);
    }
    if (!code) throw new Error(`no sign-in code for ${email}`);
    await s.verify(code);
    await s.unlock({ password });
    assert.equal(s.status().unlocked, true, `${name} has the vault open`);
    return e;
  }
  const used = new Set<string>();
  const a = await device("desk");
  const b = await device("laptop");
  assert.equal(syncFor(a).status().kind, "cloud");
  step("two devices signed in to one account, the vault open on both");

  const one = (e: Etude) => syncFor(e).now({ waitMedia: true });
  const sync = async (order: Etude[] = [a, b]) => {
    for (let round = 0; round < 2; round++) for (const e of order) await one(e);
  };
  /** What the server holds for this account: its blobs, and what it counts against the plan. */
  const vault = async () => {
    const blobs = files(join(data, "blobs")).length;
    const st = syncFor(a).status() as any;
    return { blobs, bytes: files(join(data, "blobs")).reduce((n, f) => n + f.size, 0), st };
  };
  const last = (e: Etude) => e.folderSync.links()[0].last!;

  // ---- The folder goes up from one device and comes down as real files on the other.
  const dirA = join(scratch, "A", "Vault"), dirB = join(scratch, "B", "Vault");
  const SECRET = "the heron stood very still by the lake";
  write(join(dirA, "Welcome.md"), `# Welcome\n\n${SECRET}\n`);
  write(join(dirA, "Journal", "Monday.md"), "Walked to the lake.\n");
  write(join(dirA, "Empty.md"), "");
  const big = randomBytes(3 * 1024 * 1024 + 17);
  write(join(dirA, "Assets", "big.bin"), big);
  a.folders.open(dirA, { name: "Vault" });
  const id = a.folderSync.mark("Vault").syncId;
  await one(a);
  assert.deepEqual([last(a).sent, last(a).skipped], [4, []]);
  const up = await vault();
  assert.equal(up.blobs, 4, "a blob for each file");
  assert.ok(up.bytes > big.length, "the big file's bytes are on the server");
  step(`first sync: 4 files up over HTTP (${Math.round(up.bytes / 1024)} KB on the server)`);

  await one(b);
  assert.deepEqual(b.folderSync.status().elsewhere.map((x) => [x.name, x.files]), [["Vault", 4]]);
  b.folderSync.link(id, dirB);
  await one(b);
  assert.equal(last(b).received, 4);
  assert.equal(read(join(dirB, "Welcome.md")), `# Welcome\n\n${SECRET}\n`);
  assert.equal(read(join(dirB, "Empty.md")), "");
  assert.ok(Buffer.from(readFileSync(join(dirB, "Assets", "big.bin"))).equals(big), "the big file came down byte for byte");
  step("the other device has the real files, the 3 MB one byte for byte");

  // ---- Edits both ways, and the old versions leave the server.
  const big2 = randomBytes(3 * 1024 * 1024 + 99);
  write(join(dirB, "Journal", "Monday.md"), "Walked to the lake. Saw a heron.\n");
  write(join(dirA, "Assets", "big.bin"), big2);
  await sync();
  assert.equal(read(join(dirA, "Journal", "Monday.md")), "Walked to the lake. Saw a heron.\n");
  assert.ok(Buffer.from(readFileSync(join(dirB, "Assets", "big.bin"))).equals(big2));
  const edited = await vault();
  assert.equal(edited.blobs, 4, "still one blob per file: the two old versions are gone from the server");
  assert.ok(Math.abs(edited.bytes - up.bytes) < 4096, `the server holds about what it did (${up.bytes} → ${edited.bytes}), not both versions of the big file`);
  step("edits both ways; old versions deleted from the server (4 blobs before and after)");

  // ---- The same file changed on both before a sync: both versions are kept, the home device's under the name.
  write(join(dirA, "Welcome.md"), "from the desk\n");
  write(join(dirB, "Welcome.md"), "from the laptop\n");
  await one(b);
  await sync();
  for (const dir of [dirA, dirB]) {
    assert.equal(read(join(dir, "Welcome.md")), "from the desk\n", dir);
    const copy = readdirSync(dir).filter((n) => n.startsWith("Welcome (conflict "));
    assert.equal(copy.length, 1, dir);
    assert.equal(read(join(dir, copy[0])), "from the laptop\n", dir);
  }
  step("a conflict keeps both versions on both devices");

  // ---- Removed on one: in the other's trash, and gone from the server.
  const before = (await vault()).blobs;
  unlinkSync(join(dirB, "Assets", "big.bin"));
  await sync([b, a]);
  assert.equal(existsSync(join(dirA, "Assets", "big.bin")), false);
  assert.ok(Buffer.from(readFileSync(join(dirA, ".trash", "big.bin"))).equals(big2), "on the other device it's in the folder's trash");
  const removed = await vault();
  assert.equal(removed.blobs, before - 1);
  assert.ok(removed.bytes < 64 * 1024, `the big file's bytes left the server (${removed.bytes} bytes left)`);
  step("a removal: the other device's trash has the file, the server has let go of its bytes");

  // ---- In step: another round changes nothing.
  await sync();
  const idle = (e: Etude) => last(e).sent + last(e).received + last(e).removedHere + last(e).removedThere + last(e).conflicts.length === 0;
  assert.ok(idle(a) && idle(b), JSON.stringify([last(a), last(b)]));

  // ---- Ended for every device: the files stay, the server keeps nothing of them.
  a.folderSync.unlink(id, { everywhere: true });
  await sync();
  assert.deepEqual([a.folderSync.status().here.length, b.folderSync.status().here.length, b.folderSync.status().elsewhere.length], [0, 0, 0]);
  assert.equal(read(join(dirB, "Journal", "Monday.md")), "Walked to the lake. Saw a heron.\n");
  assert.equal((await vault()).blobs, 0, "nothing of the folder is left on the server");
  step("sync ended for every device: files kept on both, 0 blobs on the server");

  // ---- The server never saw the files: neither their text nor their names are anywhere in its data.
  for (const f of files(data)) {
    const bytes = readFileSync(f.path);
    for (const needle of [SECRET, "Saw a heron", "from the laptop", "Monday.md", "Welcome.md"]) assert.equal(bytes.includes(needle), false, `${needle} is readable in ${f.path}`);
  }
  step(`the server's data (${files(data).length} files) holds none of the files' text or names`);
}

let failed = false;
try {
  await main();
  console.log("ok: folder sync over etude-cloud");
} catch (e) {
  failed = true;
  console.error(e);
  console.error("cloud log (end):\n" + log.split("\n").slice(-25).join("\n"));
} finally {
  for (const e of devices) {
    try {
      e.close();
    } catch {}
  }
  cloud.kill();
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
