// Faces are box ids, or group names when boxes share one (the same rule as facesWhen).
const faceOf = (b) => String(b.group || b.id || "").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "");
const alts = (label) => String(label ?? "").split("|").map((s) => s.trim()).filter(Boolean);
const num = (v) => (Number.isFinite(Number(v)) ? Math.min(1, Math.max(0, Number(v))) : 0);
const raw = Array.isArray(fields.boxes) ? fields.boxes.filter((b) => b && typeof b === "object") : [];
const boxes = raw.map((b, i) => ({ id: String(b.id ?? `b${i + 1}`), face: faceOf(b), x: num(b.x), y: num(b.y), w: num(b.w), h: num(b.h), label: String(b.label ?? "").trim() }));
// A card whose box was deleted keeps its history (cards are never deleted); it says so instead of
// asking about another box. Items with no boxes at all have a single "main" card.
const removed = !boxes.some((b) => b.face === face) && !(face === "main" && boxes.length === 0);
const target = removed ? null : face;
const mode = fields.mode === "hide-one" ? "hide-one" : "hide-all";
const mine = boxes.filter((b) => b.face === target);
const answers = [...new Set(mine.flatMap((b) => alts(b.label)))];
// Every other group, with its own answers, so the grader can say which part was named instead.
const others = [];
for (const b of boxes) {
  if (b.face === target) continue;
  let o = others.find((x) => x.face === b.face);
  if (!o) others.push((o = { face: b.face, answers: [] }));
  for (const a of alts(b.label)) if (!o.answers.includes(a)) o.answers.push(a);
}
// A target with no label can't be checked: the card is shown, revealed and rated like a basic card.
const self = answers.length === 0;
return {
  view: {
    image: String(fields.image ?? ""),
    header: fields.header ?? "",
    mode,
    asked: mine.length,
    selfGraded: self,
    removed,
    boxes: boxes.map((b) => ({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h, target: b.face === target, cover: b.face === target || mode === "hide-all" })),
  },
  key: {
    answers,
    others,
    labels: Object.fromEntries(boxes.map((b) => [b.id, alts(b.label)[0] ?? ""])),
    extra: fields.extra ?? "",
  },
  ...(self ? { grader: "self" } : {}),
};
