import { useEffect, useRef, type ClipboardEvent, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { Input } from "@/components/ui/input";
import { useMediaPaste } from "@/components/media-paste";
import { PasteRanges } from "@/lib/paste-ranges";
import type { MediaFormat } from "@/lib/media-paste";

export function useMediaInput(value: string, onChange: (value: string) => void, format?: MediaFormat) {
  const copy = useMediaPaste();
  const ranges = useRef(new PasteRanges(value));
  const alive = useRef(true);
  const change = useRef(onChange);
  change.current = onChange;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (ranges.current.text !== value) {
      ranges.current.cancel();
      ranges.current.update(value);
    }
  }, [value]);
  return {
    change(value: string) { ranges.current.update(value); change.current(value); },
    paste(event: ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
      if (!copy || !format) return;
      const job = copy(event.clipboardData, format);
      if (!job) return;
      event.preventDefault();
      const el = event.currentTarget;
      const range = ranges.current.add(el.selectionStart ?? value.length, el.selectionEnd ?? value.length);
      job.then((insert) => {
        if (!alive.current) return;
        const changes = ranges.current.finish(range, insert);
        if (!changes) return;
        const start = el.selectionStart ?? 0, end = el.selectionEnd ?? start;
        const text = ranges.current.text.slice(0, changes.from) + insert + ranges.current.text.slice(changes.to);
        const map = (pos: number) => pos < changes.from ? pos : pos <= changes.to ? changes.from + insert.length : pos + insert.length - (changes.to - changes.from);
        ranges.current.update(text);
        flushSync(() => change.current(text));
        if (el.isConnected && document.activeElement === el) el.setSelectionRange(map(start), map(end));
      }).catch(() => {}).finally(() => ranges.current.cancel(range));
    },
  };
}

export function MediaTextInput({ value, onChange, ...props }: Omit<ComponentProps<typeof Input>, "value" | "onChange"> & { value: string; onChange(value: string): void }) {
  const media = useMediaInput(value, onChange, "url");
  return <Input {...props} value={value} onChange={(e) => media.change(e.target.value)} onPaste={media.paste} />;
}
