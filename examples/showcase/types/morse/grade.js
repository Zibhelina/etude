// answer is the tapped sequence, e.g. "-.-."
const sent = String(answer ?? "").replace(/[^.-]/g, "");
const ok = sent === key.code;
return {
  score: ok ? 1 : 0,
  details: { sent },
  feedback: ok ? undefined : `You sent ${sent || "nothing"}, but ${view.letter} is ${key.code}`,
};
