const pick = view.options.find((o) => o.id === answer);
if (!pick) return { score: 0, feedback: "No interval picked." };
const ok = answer === key.answer;
const size = (id) => id.slice(1);
let feedback;
if (!ok) {
  feedback = size(answer) === size(key.answer) && key.answer !== "TT"
    ? `Right size, wrong quality: it was a ${key.name}, not a ${pick.name}.`
    : `It was a ${key.name} (${key.semis} semitone${key.semis === 1 ? "" : "s"}), not a ${pick.name}.`;
}
return { score: ok ? 1 : 0, feedback, details: { picked: answer } };
