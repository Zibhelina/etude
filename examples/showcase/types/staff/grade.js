if (!Number.isInteger(answer)) return { score: 0, feedback: "No note picked." };
const NAMES = ["C", "C♯/D♭", "D", "D♯/E♭", "E", "F", "F♯/G♭", "G", "G♯/A♭", "A", "A♯/B♭", "B"];
const pc = ((answer % 12) + 12) % 12;
const ok = pc === key.pc;
return { score: ok ? 1 : 0, feedback: ok ? undefined : `That's ${NAMES[pc]}; the note is ${key.full}.`, details: { pc } };
