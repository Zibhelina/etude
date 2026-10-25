// The 200 most common English words, the classic typing-test list.
const COMMON = "the be of and a to in he have it that for they with as not on she at by this we you do but from or which one would all will there say who make when can more if no man out other so what time up go about than into could state only new year some take come these know see use get like then first any work now may such give over think most even find day also after way many must look before great back through long where much should well people down own just because good each those feel seem how high too place little world very still nation hand old life tell write become here show house both between need mean call develop under last right move thing general school never same another begin while number part turn real leave might want point form off child few small since against ask late home interest large person end open public follow during present without again hold govern around possible head consider word program problem however lead system set order eye plan run keep face fact group play stand increase early course change help line".split(" ");
const seconds = Number(fields.seconds) > 0 ? Math.min(120, Math.max(10, Math.round(Number(fields.seconds)))) : 0;
const target = Math.max(1, Math.round(Number(fields.target) || 60));
const note = fields.note ?? "";
const text = String(fields.text ?? "").trim();
if (text) {
  const words = text.split(/\s+/).slice(0, 500);
  return { view: { words, seconds, target, note, kind: "text" }, key: {} };
}
const own = Array.isArray(fields.wordlist) ? fields.wordlist : String(fields.wordlist ?? "").split(/[\n,]/);
const pool = own.map((w) => String(w).trim()).filter(Boolean).map((w) => w.replace(/\s+/g, "_"));
const from = pool.length ? pool : COMMON;
// A timed test needs more words than anyone can type in the time: 4 a second is 240 WPM.
const count = seconds ? Math.min(500, seconds * 4) : Math.min(200, Math.max(5, Math.round(Number(fields.count) || 25)));
const words = [];
while (words.length < count) {
  const w = rng.pick(from);
  // No word twice in a row (unless the list has only one).
  if (from.length > 1 && w === words[words.length - 1]) continue;
  words.push(w);
}
return { view: { words, seconds, target, note, kind: pool.length ? "list" : "common" }, key: {} };
