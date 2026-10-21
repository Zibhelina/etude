import { navigate } from "@/lib/router";

export function TypesPage(_props: { id: string | null }) {
  return (
    <div className="mx-auto w-full max-w-4xl px-5 py-10 sm:px-8">
      <h1 className="text-2xl font-semibold tracking-tight">Card types</h1>
      <p className="mt-2 text-sm text-muted-foreground">Coming next.</p>
      <button className="mt-6 text-sm underline" onClick={() => navigate("/")}>Back to decks</button>
    </div>
  );
}
