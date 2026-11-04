import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { startThemeSync } from "@/lib/theme";
import { startStoreKit } from "@/lib/storekit";
import { startTelemetry } from "@/lib/telemetry";
import { ErrorBoundary } from "@/components/error-boundary";

// index.html already applied the cached theme; this confirms it with the server.
startThemeSync();
// iOS app: App Store transactions still waiting for the Sync server, and new ones as they come.
startStoreKit();
// Anonymous error reports and usage counts, as Settings → Privacy allows.
startTelemetry();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
