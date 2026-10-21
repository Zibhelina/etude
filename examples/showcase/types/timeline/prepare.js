const all = (Array.isArray(fields.events) ? fields.events : []).filter((e) => e && typeof e.label === "string" && Number.isFinite(e.year));
const n = Math.max(3, Math.min(6, Math.round(Number(fields.count) || 5), all.length));
// Pick n events whose years differ, so the order is always well defined.
const picked = [];
for (const e of rng.shuffle(all)) {
  if (picked.length >= n) break;
  if (!picked.some((p) => p.year === e.year)) picked.push(e);
}
const ys = all.map((e) => e.year);
let [from, to] = Array.isArray(fields.range) && fields.range.length === 2 ? fields.range.map(Number) : [Math.min(...ys), Math.max(...ys)];
if (!(Array.isArray(fields.range) && fields.range.length === 2)) {
  const pad = Math.max(3, Math.round((to - from) * 0.06));
  from -= pad; to += pad;
}
const chips = picked.map((e, i) => ({ id: "e" + i, label: e.label }));
return {
  view: { prompt: fields.prompt ?? "", from, to, chips, anchors: Array.isArray(fields.anchors) ? fields.anchors : [] },
  key: { years: Object.fromEntries(picked.map((e, i) => ["e" + i, e.year])), notes: Object.fromEntries(picked.map((e, i) => ["e" + i, e.note ?? ""])), tolerance: Number(fields.tolerance ?? 3), explanation: fields.explanation ?? "" },
};
