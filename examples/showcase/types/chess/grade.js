const mv = typeof answer === "string" ? answer.toLowerCase() : "";
if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(mv)) return { score: 0, feedback: "No move made." };
const ok = key.answers.includes(mv) || key.answers.includes(mv.slice(0, 4));
return { score: ok ? 1 : 0, feedback: ok ? undefined : `${mv.slice(0, 2)}–${mv.slice(2, 4)} doesn't mate. ${key.san ? `The mate is ${key.san}.` : ""}`.trim(), details: { move: mv } };
