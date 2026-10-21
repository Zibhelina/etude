const [placement, turn] = String(fields.fen ?? "").trim().split(/\s+/);
const board = {};
placement.split("/").forEach((row, r) => {
  let f = 0;
  for (const ch of row) {
    if (/\d/.test(ch)) f += Number(ch);
    else { board["abcdefgh"[f] + (8 - r)] = ch; f++; }
  }
});
const side = turn === "b" ? "b" : "w";
const theirKing = Object.keys(board).find((sq) => board[sq] === (side === "w" ? "k" : "K"));
return {
  view: { prompt: fields.prompt ?? "", board, side },
  key: { answers: (fields.answers ?? []).map((m) => String(m).toLowerCase()), san: fields.san ?? "", king: theirKing, explanation: fields.explanation ?? "" },
};
