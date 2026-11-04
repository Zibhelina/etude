// Text the iOS and Android apps show where desktop and web say something else. A phone has no
// desktop app beside it and no folder to pick, and the store apps never point to the website
// (test/store-rules.test.ts scans these).

export const NATIVE_COPY = {
  syncSetup: "Etude syncs your collection through a server.",
  syncFolder: "Syncing through a folder.",
  passkeysElsewhere: "Passkeys for this account can't be added in this app. Sign in with an email code instead.",
  selling: "Selling decks isn't available in this app.",
} as const;
