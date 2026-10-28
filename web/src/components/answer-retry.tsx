export function AnswerRetry({ hint }: { hint: string }) {
  return (
    <div role="status" className="rounded-lg border bg-muted/40 px-4 py-3 text-sm">
      <p className="font-medium">Try again</p>
      <p className="mt-1">{hint}</p>
      <p className="mt-1 text-muted-foreground">This answer wasn't graded.</p>
    </div>
  );
}
