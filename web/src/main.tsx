import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { startThemeSync } from "@/lib/theme";
import { startStoreKit } from "@/lib/storekit";
import { startTelemetry } from "@/lib/telemetry";
import { startScrollbars } from "@/lib/scrollbar";
import { ErrorBoundary } from "@/components/error-boundary";
import { applyDevice } from "@/lib/device";

// Phone or desktop, decided once for the session (lib/device.ts); CSS reads it from <html data-device>.
applyDevice();

// index.html already applied the cached theme; this confirms it with the server.
startThemeSync();
// The scrollbar that only shows while something scrolls.
startScrollbars();
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
