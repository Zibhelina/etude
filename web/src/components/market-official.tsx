// The Etude seal: entries made by the Etude team (João and Victor) carry it on their tiles, cards and pages.
// The catalog is reviewed by the two of them before anything merges, so an author line can't claim it unseen.

const TEAM = /^(joao|joão|zibhelina|victor ?bonato|victorbonato)\b/i;

export function isOfficial(author?: string, soldBy?: string) {
  return soldBy === "etude" || TEAM.test((author ?? "").trim());
}

/** A small scalloped rosette with ε in it. `size` is in px; it sits on the text's baseline. */
export function OfficialSeal({ size = 18, className }: { size?: number; className?: string }) {
  const n = 10, R = 11.6, r = 10.2;
  const pts: string[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = (Math.PI * i) / n - Math.PI / 2, rr = i % 2 ? r : R;
    pts.push(`${(12 + rr * Math.cos(a)).toFixed(2)},${(12 + rr * Math.sin(a)).toFixed(2)}`);
  }
  return (
    <svg className={`mk-seal${className ? ` ${className}` : ""}`} width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="Official Etude deck" data-official>
      <title>Official: made by the Etude team</title>
      <polygon points={pts.join(" ")} fill="var(--mk-seal, #22c55e)" stroke="var(--mk-seal, #22c55e)" strokeWidth="1" strokeLinejoin="round" />
      <text x="12" y="17.2" textAnchor="middle" fontSize="16" fontWeight="700" fill="#fff" style={{ fontFamily: "Inter, system-ui, sans-serif" }}>ε</text>
    </svg>
  );
}
