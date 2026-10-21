import { useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const STEP = /^\d+(\.\d+)?[mhd]$/;

/** Learning steps as removable chips: type "10m", "1h" or "1d" and press Enter or space. */
export function StepsInput({ value, onChange, id, ariaLabel }: { value: string[]; onChange(v: string[]): void; id?: string; ariaLabel?: string }) {
  const [text, setText] = useState("");
  const [error, setError] = useState(false);
  const commit = (raw = text) => {
    const parts = raw.trim().toLowerCase().split(/[\s,]+/).filter(Boolean);
    if (!parts.length) return true;
    if (!parts.every((p) => STEP.test(p))) {
      setError(true);
      return false;
    }
    onChange([...value, ...parts]);
    setText("");
    setError(false);
    return true;
  };
  return (
    <div>
      <div
        onClick={(e) => (e.currentTarget.querySelector("input") as HTMLInputElement | null)?.focus()}
        className={cn(
          "flex min-h-11 cursor-text flex-wrap items-center gap-1.5 rounded-md border border-input bg-input/30 px-1.5 py-1.5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
          error && "border-destructive",
        )}
      >
        {value.map((s, i) => (
          <span key={`${s}-${i}`} className="tabular inline-flex h-8 items-center gap-0.5 rounded-md bg-secondary pr-0.5 pl-2.5 font-mono text-[13px]">
            {s}
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
              aria-label={`Remove step ${s}`}
            >
              <X className="size-3.5" />
            </button>
          </span>
        ))}
        <input
          id={id}
          aria-label={ariaLabel}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " " || e.key === ",") {
              e.preventDefault();
              commit();
            } else if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1));
          }}
          onBlur={() => commit()}
          placeholder={value.length ? "+ step" : "none · type 1m, 10m, 1d"}
          className="h-8 min-w-20 flex-1 bg-transparent font-mono text-[13px] outline-none placeholder:font-sans placeholder:text-muted-foreground"
        />
      </div>
      {error && <p className="mt-1 text-xs text-destructive">Steps look like 1m, 10m, 2h or 1d.</p>}
    </div>
  );
}
