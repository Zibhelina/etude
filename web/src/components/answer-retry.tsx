export function AnswerRetry({ hint }: { hint: string }) {
  return (
    <div role="status" className="st-rise rounded-2xl bg-muted px-4 py-3 text-[15px] leading-relaxed">
      <p className="text-xs font-bold tracking-[0.08em] text-warning uppercase">Try again</p>
      <p className="mt-1">{hint}</p>
      <p className="mt-1 text-sm text-muted-foreground">This answer wasn't graded.</p>
    </div>
  );
}
