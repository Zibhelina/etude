// A test page for the browser core: `?step=fresh` imports the Showcase and studies a card,
// `?step=again` (after a reload) checks that it all came back from OPFS.
import { startCore } from "./client.ts";
import showcase from "../../examples/showcase.pack.json?raw";
import apkgUrl from "../../test/fixtures/anki/sample.apkg?url";

const out: Record<string, unknown> = {};
const log = (k: string, v: unknown) => {
  out[k] = v;
  document.getElementById("log")!.textContent = JSON.stringify(out, null, 1);
};
const step = new URLSearchParams(location.search).get("step") ?? "fresh";
const core = startCore();

try {
  log("boot", await core.call("_boot"));
  log("persisted", await navigator.storage.persisted?.());
  if (step === "fresh") {
    const t0 = performance.now();
    const r = await core.call("importPack", JSON.parse(showcase));
    log("import", { ms: Math.round(performance.now() - t0), created: r.items?.created ?? r.created ?? r });
    const bytes = new Uint8Array(await (await fetch(apkgUrl)).arrayBuffer());
    const a = await core.call("importAnki", bytes, { deckPrefix: "Anki" });
    log("anki", { notes: a.notes ?? a.items, cards: a.cards });
    const deck = (await core.call("_sql", "SELECT name FROM decks WHERE name LIKE 'Anki%' ORDER BY length(name) LIMIT 1"))[0].name;
    const nx = await core.call("next", { deck });
    log("next", { deck, item: nx.card?.itemId, type: nx.card?.type, counts: nx.counts });
    const card = nx.card;
    const g = await core.call("submit", card.cardId, card.seed, card.grader === "self" ? null : "definitely not the answer");
    log("graded", { verdict: g.grade?.verdict, score: g.grade?.score, grader: g.grade?.grader?.kind });
    const rated = await core.call("rate", card.cardId, 1, { attemptId: g.attemptId });
    log("rated", { state: rated?.state ?? rated?.card?.state, due: rated?.due ?? rated?.card?.due });
    // Script graders run in QuickJS: grade a right and a wrong answer on a Showcase card, in watch mode.
    const list = await core.call("watchList", { deck: "Etude Showcase" });
    const typed = list.find((c: any) => c.type === "typed") ?? list.find((c: any) => c.type === "numeric") ?? list[0];
    const w = await core.call("watchCard", typed.cardId);
    const right = await core.call("watchGrade", typed.cardId, w.card.seed, w.demo.answer);
    const wrong = await core.call("watchGrade", typed.cardId, w.card.seed, typed.type === "numeric" ? { value: -987654 } : "zzz-not-it");
    log("sandbox", { cards: list.length, type: typed.type, right: right.grade?.verdict ?? right.verdict, wrong: wrong.grade?.verdict ?? wrong.verdict });
    const pasted = await core.call("storeMedia", "dot.png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]));
    log("media", { file: pasted.file, created: pasted.created });
    localStorage.setItem("harness.media", pasted.file);
  }
  const counts = await core.call("_sql", "SELECT (SELECT count(*) FROM items) items, (SELECT count(*) FROM cards) cards, (SELECT count(*) FROM attempts) attempts, (SELECT count(*) FROM reviews) reviews, (SELECT count(*) FROM decks) decks");
  log("counts", counts[0]);
  const mediaFile = localStorage.getItem("harness.media");
  if (mediaFile) log("mediaOnDisk", await core.call("_media", mediaFile));
  const hits = await core.call("searchItems", "chess", { limit: 5 });
  log("search", { total: hits.total, first: hits.items?.[0]?.id });
  log("done", true);
} catch (e) {
  log("error", String(e));
}
