const keys = Array.isArray(answer) ? answer.filter((m) => Number.isInteger(m)) : [];
if (!keys.length) return { score: 0, feedback: "No keys pressed." };
const pcs = [...new Set(keys.map((m) => ((m % 12) + 12) % 12))];
const want = new Set(key.pcs);
const hit = pcs.filter((p) => want.has(p));
const extra = pcs.filter((p) => !want.has(p));
const missing = key.pcs.filter((p) => !pcs.includes(p));
// Each chord tone found earns its share; each wrong pitch class takes one share away.
const score = Math.max(0, (hit.length - extra.length) / key.pcs.length);
const name = (p) => key.tones.find((t) => t.pc === p)?.name;
let feedback;
if (score < 1) {
  const parts = [];
  if (missing.length) parts.push(`missing ${missing.map(name).join(", ")}`);
  const SP = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
  if (extra.length) parts.push(`${extra.map((p) => SP[p]).join(", ")} ${extra.length === 1 ? "isn't" : "aren't"} in the chord (each extra note costs one tone's credit)`);
  feedback = `${hit.length} of ${key.pcs.length} chord tones; ${parts.join("; ")}.`;
}
return { score, feedback, details: { missing, extra } };
