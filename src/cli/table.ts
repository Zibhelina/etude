// `--format table`: a plain text table for lists, for people reading a terminal.

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(cell).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  if (typeof v === "number" && !Number.isInteger(v)) return String(Math.round(v * 1000) / 1000);
  return String(v).replace(/\s+/g, " ");
};

/** Renders an array of flat objects (or `{ rows: [...] }`). Returns null for anything else. */
export function renderTable(v: unknown): string | null {
  const rows = Array.isArray(v) ? v : v && typeof v === "object" && Array.isArray((v as any).rows) ? (v as any).rows : null;
  if (!rows) return null;
  if (!rows.length) return "(none)\n";
  if (!rows.every((r: unknown) => r && typeof r === "object" && !Array.isArray(r))) return rows.map(cell).join("\n") + "\n";
  const cols: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  const keep = cols.filter((c) => rows.some((r: any) => typeof r[c] !== "object" || r[c] === null || Array.isArray(r[c])));
  const text = rows.map((r: any) => keep.map((c) => cell(r[c]).slice(0, 60)));
  const width = keep.map((c, i) => Math.max(c.length, ...text.map((t: string[]) => t[i].length)));
  const line = (cells: string[]) => cells.map((s, i) => s.padEnd(width[i])).join("  ").trimEnd();
  const total = !Array.isArray(v) && typeof (v as any).total === "number" ? `\n${rows.length} of ${(v as any).total}\n` : "\n";
  return [line(keep), line(width.map((w) => "-".repeat(w))), ...text.map(line)].join("\n") + total;
}
