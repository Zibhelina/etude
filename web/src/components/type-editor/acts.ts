// What you do on a type's cards, for grouping the Types gallery. Read from the type's summary (its
// description, scheduler and result screen), so a new type lands somewhere sensible without asking.
// No imports and no DOM, so the server's tests can check it too.

export type Act = "remember" | "pick" | "place" | "write" | "play" | "games";

export const ACTS: { id: Act; title: string; sub: string }[] = [
  { id: "remember", title: "Remember and answer", sub: "Recall it, then type, reveal or work it out" },
  { id: "pick", title: "Pick and listen", sub: "Choose from options, by eye or by ear" },
  { id: "place", title: "Place and build", sub: "Drag it, set it, put it on a map, a board or a diagram" },
  { id: "write", title: "Write and draw", sub: "Free-form answers: code, drawings, commands" },
  { id: "play", title: "Play", sub: "On a keyboard, a chessboard or a Morse key" },
  { id: "games", title: "Games and drills", sub: "Timed and scored, with their own result screen" },
];

// The types that ship with Etude, placed by hand.
const SHIPPED: Record<string, Act> = {
  basic: "remember", typed: "remember", cloze: "remember", numeric: "remember", math: "remember", free: "remember",
  mcq: "pick", match: "pick",
  order: "place", occlusion: "place",
  draw: "write", code: "write",
};

const RULES: [Act, RegExp][] = [
  ["games", /\b(arcade|game|against the clock|sprint|boss fight|monkeytype|lives)\b/],
  ["play", /\bplay (a|an|the)\b|two-octave piano|real board|\bmorse\b|dots and dashes/],
  ["write", /\bdraw the answer\b|\bwrite (code|a regular expression|a program|the (code|function|query))\b|\bresource records\b|\btype commands\b/],
  ["place", /\b(drag|map|slider|sliders|steppers|timeline|coordinate grid|place (an|each|it|the)|tap the nodes|tapping servers|build the (packet|timing)|cover parts|circle of fifths|switches)\b/],
  ["games", /\bpuzzles? you solve\b|\blogic puzzle/],
  ["pick", /\bpick (the|its quality|every|one)\b|\bpicking\b|\bchoose\b|\bby ear\b|\bear training\b|\bconnect each\b|\bstaff\b|\btap the (buggy|protocol|right)\b|\bmultiple choice\b/],
];

export function actOf(t: { id: string; name: string; description: string; shipped?: boolean; edited?: boolean; scheduler?: string | null; showVerdict?: boolean }): Act {
  if (t.shipped && SHIPPED[t.id]) return SHIPPED[t.id];
  if (t.scheduler === "drill" || t.showVerdict === false) return "games";
  const text = `${t.name}. ${t.description}`.toLowerCase();
  for (const [act, re] of RULES) if (re.test(text)) return act;
  return "remember";
}
