// Builds a small collection for the Tempo section's Stats capture: a typing card on the drill
// scheduler with five weeks of real graded runs (the type's own grade script scores each one),
// and a Leitner deck with some ratings so the By scheduler panel has three rhythms.
// node site/tools/drill-db.ts <out.db>
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Etude } from "../../src/core/engine.ts";
import { loadTypeDir } from "../../src/core/types.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = process.argv[2];
if (!out) throw new Error("usage: drill-db.ts <out.db>");
for (const f of [out, `${out}-wal`, `${out}-shm`]) rmSync(f, { force: true });

const etude = await Etude.open(out);
const showcase = JSON.parse(readFileSync(join(root, "examples/showcase.pack.json"), "utf8"));
const typing = loadTypeDir(join(root, "examples/showcase/types/typing"), { assets: false });
const english = showcase.items.find((i: { id: string }) => i.id === "showcase.typing.english");
etude.importPack({
  etude: "pack/1",
  name: "Practice",
  types: [typing],
  decks: [
    { name: "Typing", config: { scheduler: "drill", schedulerOptions: { perDay: 3 } } },
    { name: "Spanish", config: { scheduler: "leitner" } },
    { name: "Physics" },
  ],
  items: [
    { id: "drill.typing.english", type: "typing", deck: "Typing", fields: { ...english.fields, target: 90, note: "" } },
    ...["recordar", "elegir", "lograr", "guardar", "intentar", "compartir", "olvidar", "dormirse"].map((w, i) => ({ id: `es.${i}`, type: "typed", deck: "Spanish", fields: { prompt: `Spanish for **${["to remember", "to choose", "to achieve", "to keep", "to try", "to share", "to forget", "to fall asleep"][i]}**`, answers: [w] } })),
    ...["F = ma", "P = W / t", "p = mv", "V = IR", "E = mc^2", "KE = mv^2 / 2"].map((b, i) => ({ id: `ph.${i}`, type: "basic", deck: "Physics", fields: { front: `Formula ${i + 1}`, back: b } })),
  ],
});
const db = (etude as any).db;
const card = (item: string) => db.get("SELECT id FROM cards WHERE item_id = ?", item).id as number;

let s = 11;
const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const DAY = 86400_000;
const start = Date.now() - 34 * DAY;
const typingCard = card("drill.typing.english");
let runs = 0;
for (let day = 0; day <= 34; day++) {
  if (day < 30 && rand() < 0.22) continue;
  const n = 1 + Math.floor(rand() * 3);
  const evening = new Date(start + day * DAY);
  evening.setHours(20 + Math.floor(rand() * 3), Math.floor(rand() * 50), 0, 0);
  for (let k = 0; k < n; k++) {
    const at = new Date(evening.getTime() + k * 95_000);
    const seed = Math.floor(rand() * 2 ** 31);
    const view = etude.prepare("drill.typing.english", "main", seed).view as { words: string[] };
    // A learner going from ~60 to ~95 WPM over five weeks, with a bad night now and then.
    const skill = 60 + 34 * (1 - Math.exp(-day / 14)) + (rand() - 0.5) * 9 - (rand() < 0.08 ? 12 : 0);
    const chars = view.words.join(" ").length;
    const ms = Math.round(((chars / 5) / skill) * 60000);
    const typos = Math.floor(rand() * 4);
    const secs = Math.ceil(ms / 1000);
    const history = Array.from({ length: secs }, (_, i) => { const w = Math.max(10, skill + (rand() - 0.5) * 30); return [i + 1, Math.round(w), Math.round(w + rand() * 6), rand() < typos / secs ? 1 : 0]; });
    const answer = { typed: view.words, ms, complete: true, keys: { correct: chars, incorrect: typos }, history };
    const r = await etude.submit(typingCard, seed, answer);
    etude.rate(typingCard, 0, { attemptId: r.attemptId, at, durationMs: ms });
    db.run("UPDATE attempts SET ts = ? WHERE id = ?", at.toISOString(), r.attemptId);
    runs++;
  }
}
// Leitner and FSRS decks: a few weeks of plain ratings.
for (const prefix of ["es.", "ph."]) {
  const ids = db.all("SELECT c.id FROM cards c JOIN items i ON i.id = c.item_id WHERE i.id LIKE ?", `${prefix}%`).map((r: { id: number }) => r.id);
  for (let day = 0; day <= 34; day += 1 + Math.floor(rand() * 3)) {
    const t = new Date(start + day * DAY + 19 * 3600_000);
    for (const id of ids) {
      const c = db.get("SELECT due, reps FROM cards WHERE id = ?", id);
      if (c?.reps && c.due && new Date(c.due).getTime() > t.getTime()) continue;
      const r = rand();
      etude.rate(id, (r < 0.12 ? 1 : r < 0.2 ? 2 : r < 0.92 ? 3 : 4) as 1 | 2 | 3 | 4, { at: t, durationMs: 5000 });
    }
  }
}
console.log(JSON.stringify({ runs }));
etude.close();
