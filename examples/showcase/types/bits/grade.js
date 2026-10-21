const given = typeof answer === "string" && /^[01]+$/.test(answer) && answer.length === view.width ? answer : "";
const w = view.width;
const value = given ? (view.signed && given[0] === "1" ? parseInt(given, 2) - 2 ** w : parseInt(given, 2)) : null;
const ok = given === key.pattern;
const wrongBits = given ? [...given].map((b, i) => (b !== key.pattern[i] ? i : -1)).filter((i) => i >= 0) : [];
let feedback;
const fmt = (v) => (v < 0 ? "−" + -v : String(v));
if (!ok) feedback = value === null ? "No bit pattern." : `Your bits make ${fmt(value)}, not ${fmt(view.target)}. ${wrongBits.length} bit${wrongBits.length === 1 ? " is" : "s are"} off.`;
return { score: ok ? 1 : 0, feedback, details: { value, wrongBits } };
