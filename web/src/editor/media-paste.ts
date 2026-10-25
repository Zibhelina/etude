import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { flushSync } from "react-dom";
import { PasteRanges } from "@/lib/paste-ranges";
import type { ImportPaste } from "@/components/media-paste";

/** Authoring only: card-frame editors never receive this extension. */
export function mediaPasteExtension(copy: ImportPaste) {
  return ViewPlugin.fromClass(class {
    alive = true;
    ranges: PasteRanges;
    constructor(readonly view: EditorView) { this.ranges = new PasteRanges(view.state.doc.toString()); }
    update(update: ViewUpdate) {
      if (!update.docChanged) return;
      if (update.transactions.some((tr) => !tr.isUserEvent("input") && !tr.isUserEvent("delete"))) this.ranges.cancel();
      this.ranges.update(update.state.doc.toString());
    }
    destroy() { this.alive = false; }
    paste(data: DataTransfer | null, pos?: number) {
      if (!data || this.view.state.readOnly) return false;
      const job = copy(data, "markdown");
      if (!job) return false;
      const selection = this.view.state.selection.main;
      const range = this.ranges.add(pos ?? selection.from, pos ?? selection.to);
      job.then((insert) => {
        if (!this.alive) return;
        const changes = this.ranges.finish(range, insert);
        if (!changes) return;
        const current = this.view.state.selection.main;
        const stay = current.from === changes.from && current.to === changes.to;
        flushSync(() => this.view.dispatch({ changes, ...(stay ? { selection: { anchor: changes.from + insert.length } } : {}), userEvent: "input.paste" }));
      }).catch(() => {}).finally(() => this.ranges.cancel(range));
      return true;
    }
  }, { eventHandlers: {
    paste(event) { return this.paste(event.clipboardData); },
    drop(event) {
      const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
      return pos === null ? false : this.paste(event.dataTransfer, pos);
    },
  } });
}
