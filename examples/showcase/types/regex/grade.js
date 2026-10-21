const a = answer && typeof answer === "object" ? answer : { pattern: answer == null ? "" : String(answer), flags: "" };
const pattern = String(a.pattern ?? "");
const flags = [...new Set(String(a.flags ?? "").replace(/[^imsu]/g, ""))].join("");
const tests = [
  ...view.match.map((s) => ({ s, want: true, hidden: false })),
  ...view.reject.map((s) => ({ s, want: false, hidden: false })),
  ...key.hidden.match.map((s) => ({ s, want: true, hidden: true })),
  ...key.hidden.reject.map((s) => ({ s, want: false, hidden: true })),
];
const fail = (feedback, error) => ({ score: 0, feedback, details: { error, tests: tests.map((t) => ({ ...t, got: null })) } });
if (!pattern) return fail("No pattern.");
let re;
try {
  re = new RegExp(view.mode === "find" ? pattern : `^(?:${pattern})$`, flags);
} catch (e) {
  const why = String(e.message).replace(/^Invalid regular expression: \/[\s\S]*\/[a-z]*: /, "");
  return fail(`The pattern doesn't compile: ${why}.`, why);
}
const out = tests.map((t) => ({ ...t, got: re.test(t.s) }));
const right = out.filter((t) => t.got === t.want).length;
const show = (t) => (t.s === "" ? "the empty string" : `\`${t.s}\``);
let feedback;
if (right < out.length) {
  const wrong = out.filter((t) => t.got !== t.want);
  const list = wrong.slice(0, 4).map((t) => `${show(t)}${t.hidden ? " (hidden)" : ""} should ${t.want ? "" : "not "}match`);
  if (wrong.length > 4) list.push(`${wrong.length - 4} more`);
  feedback = `${right} of ${out.length} tests pass. Still wrong: ${list.join("; ")}.`;
}
return { score: right / out.length, feedback, details: { tests: out, right, total: out.length } };
