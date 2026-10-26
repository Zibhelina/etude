// Builds a demo collection for website screenshots: the showcase pack plus a few study decks,
// with three months of simulated review history so Stats, Decks and Browse look lived in.
// node site/tools/demo-db.ts <out.db>
import { rmSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Etude } from "../../src/core/engine.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = process.argv[2];
if (!out) throw new Error("usage: demo-db.ts <out.db>");
for (const f of [out, `${out}-wal`, `${out}-shm`]) rmSync(f, { force: true });

const etude = await Etude.open(out);
etude.importPack(JSON.parse(readFileSync(join(root, "examples/showcase.pack.json"), "utf8")));

// A few ordinary decks, so the collection reads like someone's real studies.
const items: any[] = [];
const add = (deck: string, id: string, type: string, fields: Record<string, unknown>) => items.push({ id, type, deck, fields });
const physics = [
  ["Newton's second law in one line?", "$F = ma$: net force equals mass times acceleration."],
  ["What is the SI unit of power?", "The watt, one joule per second."],
  ["Kinetic energy of a mass $m$ at speed $v$?", "$\\tfrac12 mv^2$"],
  ["What does a capacitor store?", "Energy in the electric field between its plates."],
  ["Speed of light in vacuum, to 3 s.f.?", "$3.00 \\times 10^8$ m/s"],
  ["Ohm's law?", "$V = IR$"],
  ["Momentum of a body?", "$p = mv$"],
  ["Period of a pendulum of length $L$ (small angles)?", "$T = 2\\pi\\sqrt{L/g}$"],
];
physics.forEach(([q, a], i) => add("Physics::Mechanics", `demo.phys.${i}`, "basic", { front: q, back: a }));
const spanish = [["to remember", "recordar"], ["to choose", "elegir"], ["to fall asleep", "dormirse"], ["to achieve", "lograr"], ["to wonder", "preguntarse"], ["to borrow", "pedir prestado"], ["to keep", "guardar"], ["to try", "intentar"], ["to share", "compartir"], ["to forget", "olvidar"]];
spanish.forEach(([en, es], i) => add("Spanish::Verbs", `demo.es.${i}`, "typed", { prompt: `Spanish for **${en}**`, answers: [es] }));
const nets = [
  ["A 1,500-byte packet on a 10 Mbps link. Transmission delay?", 1.2, "ms"],
  ["2,000 km of fibre at $2\\times10^8$ m/s. Propagation delay?", 10, "ms"],
  ["A 1 MB file over a 100 Mbps link, ignoring propagation. Time to send?", 80, "ms"],
  ["4,000-bit packets on a 2 Mbps link. Packets per second?", 500, ""],
] as const;
nets.forEach(([q, a, u], i) => add("Networks::Delay", `demo.net.${i}`, "numeric", { prompt: q, answer: a, unit: u }));
const algo = [
  ["Worst-case time of quicksort?", "$O(n^2)$, with bad pivots."],
  ["Why is Dijkstra wrong with negative edges?", "A settled node can later get a shorter path through a negative edge."],
  ["Height of a balanced BST with $n$ nodes?", "$O(\\log n)$"],
  ["What does a heap guarantee?", "Each parent is ordered before its children, so the root is the min (or max)."],
  ["Master theorem case for $T(n) = 2T(n/2) + n$?", "$\\Theta(n \\log n)$"],
  ["Amortized cost of a dynamic array append?", "$O(1)$"],
];
algo.forEach(([q, a], i) => add("Algorithms", `demo.alg.${i}`, "basic", { front: q, back: a }));
const kana = "a:あ i:い u:う e:え o:お ka:か ki:き ku:く ke:け ko:こ sa:さ shi:し su:す se:せ so:そ ta:た chi:ち tsu:つ te:て to:と na:な ni:に nu:ぬ ne:ね no:の ha:は hi:ひ fu:ふ he:へ ho:ほ ma:ま mi:み mu:む me:め mo:も ya:や yu:ゆ yo:よ ra:ら ri:り ru:る re:れ ro:ろ wa:わ wo:を n:ん".split(" ");
kana.forEach((p, i) => { const [r, k] = p.split(":"); add("Japanese::Hiragana", `demo.kana.${i}`, "typed", { prompt: `Romaji for **${k}**`, answers: [r] }); });
const hist = [["The fall of Constantinople", "1453"], ["The printing press in Mainz", "c. 1450"], ["The French Revolution begins", "1789"], ["The Treaty of Westphalia", "1648"], ["The first Moon landing", "1969"], ["The Berlin Wall falls", "1989"], ["The Magna Carta", "1215"], ["The Battle of Hastings", "1066"], ["Columbus reaches the Americas", "1492"], ["The start of the First World War", "1914"], ["The Meiji Restoration", "1868"], ["Brazilian independence", "1822"]];
hist.forEach(([e, y], i) => add("History::Dates", `demo.hist.${i}`, "basic", { front: `When: ${e}?`, back: y }));
etude.importPack({ etude: "pack/1", name: "Demo", items });

// Three months of history: each card is introduced on some day, then reviewed whenever it came
// due, with ratings drawn so retention lands near 90%.
let s = 7;
const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const DAY = 86400_000;
const start = Date.now() - 92 * DAY;
const cards = (etude.search("-deck:\"Etude Showcase\"", { limit: 1000 }) as any).rows as { cardId: number }[];
const showcase = (etude.search("deck:\"Etude Showcase\"", { limit: 1000 }) as any).rows as { cardId: number }[];
const pool = [...cards, ...showcase];
const intro = new Map(pool.map((c) => [c.cardId, start + Math.floor(rand() * 80) * DAY + Math.floor(rand() * 10) * 3600_000]));
// Study happens at a few different times of day (mostly evenings), so the study clock has a shape.
const HOURS = [8, 9, 12, 17, 19, 20, 20, 21, 21, 22, 22, 23];
for (let day = 0; day <= 92; day++) {
  if (day < 86 && rand() < 0.1) continue; // a few days off, but the last week is a streak
  const midnight = new Date(start + day * DAY);
  midnight.setHours(0, 0, 0, 0);
  const t0 = midnight.getTime() + HOURS[Math.floor(rand() * HOURS.length)] * 3600_000 + Math.floor(rand() * 40) * 60_000;
  let k = 0;
  for (const c of pool) {
    const row = etude.cardSchedule(c.cardId) as any;
    const due = row?.due ? new Date(row.due).getTime() : 0;
    const introduced = intro.get(c.cardId)!;
    const isNew = !row || row.state === 0;
    if ((isNew && introduced <= t0 && introduced > t0 - DAY) || (!isNew && due <= t0 + 3600_000)) {
      const r = rand();
      const rating = (r < 0.09 ? 1 : r < 0.2 ? 2 : r < 0.93 ? 3 : 4) as 1 | 2 | 3 | 4;
      etude.rate(c.cardId, rating, { at: new Date(t0 + k++ * 47_000), durationMs: 4000 + Math.floor(rand() * 20000) });
    }
  }
}
// An exam coming up, so the deadline forecast has something to show.
etude.updateDeck("Networks", { config: { deadline: new Date(Date.now() + 16 * DAY).toISOString() } });
console.log(JSON.stringify({ cards: pool.length, reviews: (etude as any).db.get("SELECT COUNT(*) AS n FROM reviews").n }));
etude.close();
