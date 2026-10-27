// The Android and iOS apps: the serverless browser build (npm run build:browser → dist-browser/)
// inside a native shell. `npm run app:sync` rebuilds it and copies it into android/ and ios/.
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "study.etude.app",
  appName: "Etude",
  webDir: "dist-browser",
  // The web app is served from https://localhost (Android) and capacitor://localhost (iOS): a
  // secure context, so OPFS, Web Workers and crypto.subtle work.
  server: { androidScheme: "https" },
  backgroundColor: "#0f0f0f",
  // webContentsDebuggingEnabled is left to Capacitor: on for debug builds, off for release builds.
  android: {
    allowMixedContent: false,
  },
  ios: {
    contentInset: "never",
    // Keeps WKWebView's own scroll out of the way; the app scrolls its own panes.
    scrollEnabled: true,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 600,
      launchAutoHide: true,
      backgroundColor: "#0f0f0f",
      showSpinner: false,
      androidScaleType: "CENTER_INSIDE",
    },
    StatusBar: {
      overlaysWebView: true,
      style: "DARK",
      backgroundColor: "#00000000",
    },
    // The WebView shrinks above the keyboard; native-shell.ts scrolls the focused field into view.
    Keyboard: {
      resize: "native",
    },
  },
};

export default config;
