import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { startThemeSync } from "@/lib/theme";
import { startStoreKit } from "@/lib/storekit";

// index.html already applied the cached theme; this confirms it with the server.
startThemeSync();
// iOS app: App Store transactions still waiting for the Sync server, and new ones as they come.
startStoreKit();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
