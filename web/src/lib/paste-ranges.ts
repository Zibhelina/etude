export interface PasteRange { from: number; to: number; selected: string }

/** Keeps pending paste positions aligned with edits made while media is copying. */
export class PasteRanges {
  private ranges = new Set<PasteRange>();
  text: string;
  constructor(text: string) { this.text = text; }

  add(from: number, to: number) {
    const range = { from, to, selected: this.text.slice(from, to) };
    this.ranges.add(range);
    return range;
  }

  update(text: string) {
    if (text === this.text) return;
    let start = 0, oldEnd = this.text.length, newEnd = text.length;
    while (start < oldEnd && start < newEnd && this.text[start] === text[start]) start++;
    while (oldEnd > start && newEnd > start && this.text[oldEnd - 1] === text[newEnd - 1]) { oldEnd--; newEnd--; }
    const map = (pos: number, assoc: number) => pos < start || (pos === start && assoc < 0) ? pos : pos > oldEnd || (pos === oldEnd && assoc > 0) ? pos + newEnd - oldEnd : assoc < 0 ? start : newEnd;
    for (const range of this.ranges) {
      const collapsed = range.from === range.to;
      const from = map(range.from, collapsed ? -1 : 1), to = map(range.to, -1);
      range.from = Math.min(from, to);
      range.to = Math.max(from, to);
    }
    this.text = text;
  }

  finish(range: PasteRange, insert: string) {
    if (!this.ranges.delete(range)) return null;
    return { from: range.from, to: this.text.slice(range.from, range.to) === range.selected ? range.to : range.from, insert };
  }

  cancel(range?: PasteRange) {
    if (range) this.ranges.delete(range);
    else this.ranges.clear();
  }
}
