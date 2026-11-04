// When a screen throws while rendering: a calm page with a way back instead of a blank window, and an anonymous
// error report (when they're on; lib/telemetry.ts).
import { Component, type ReactNode } from "react";
import { reportError } from "@/lib/telemetry";
import { BASE } from "@/lib/router";

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown, info: { componentStack?: string | null }) {
    const e = error as { name?: string; message?: string; stack?: string };
    reportError("react", { name: e?.name, message: e?.message ?? String(error), stack: `${e?.stack ?? ""}\n${info?.componentStack ?? ""}`.trim() });
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="flex min-h-dvh items-center justify-center bg-background p-6 text-foreground">
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-semibold tracking-tight">This screen ran into a problem</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Your cards and reviews are safe. Going back to Decks usually fixes it; if it keeps happening, reload Etude.</p>
          <div className="mt-5 flex justify-center gap-2">
            <button type="button" className="h-9 rounded-md border px-4 text-sm hover:bg-accent" onClick={() => location.assign(`${BASE}/`)}>
              Back to Decks
            </button>
            <button type="button" className="h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground" onClick={() => location.reload()}>
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
