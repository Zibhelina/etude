// Saves the JSON the app's Stats page fetches, for the live Stats panels on the website.
// Builds the two demo collections (demo-db.ts: three months of reviews; drill-db.ts: a typing drill,
// Leitner and FSRS), serves each one and writes /api/stats exactly as the app asks for it.
//   node site/tools/stats-snapshot.mjs
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = join(root, "site/src/assets/stats-data");
const tmp = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "etude-stats-"));
mkdirSync(outDir, { recursive: true });
// The Stats page asks for 26 weeks (WEEKS * 7 in web/src/pages/stats.tsx).
const DAYS = 26 * 7;

const freePort = () =>
  new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

async function snapshot(builder, name, scopes) {
  const db = join(tmp, `${name}.db`);
  execFileSync(process.execPath, [join(root, "site/tools", builder), db], { cwd: root, stdio: "inherit" });
  const port = await freePort();
  const env = { ...process.env, ETUDE_HOME: join(tmp, `${name}-home`) };
  const srv = spawn(process.execPath, [join(root, "src/cli/main.ts"), "--db", db, "serve", "--port", String(port)], { cwd: root, env, stdio: "ignore" });
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${base}/api/decks`)).ok) break;
      } catch {}
      if (i > 100) throw new Error(`${name}: server didn't start on ${port}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    for (const [file, deck] of scopes) {
      const q = new URLSearchParams({ days: String(DAYS) });
      if (deck) q.set("deck", deck);
      const res = await fetch(`${base}/api/stats?${q}`);
      if (!res.ok) throw new Error(`${name}: /api/stats ${res.status}`);
      const stats = await res.json();
      writeFileSync(join(outDir, file), JSON.stringify({ taken: new Date().toISOString(), deck: deck ?? null, stats }));
      console.log(`${file}: ${stats.cards.total} FSRS cards, today ${stats.today.day}`);
    }
  } finally {
    srv.kill();
  }
}

await snapshot("demo-db.ts", "demo", [["demo.json"], ["demo-networks.json", "Networks"]]);
await snapshot("drill-db.ts", "drill", [["drill.json"]]);
rmSync(tmp, { recursive: true, force: true });
