// Text the iOS and Android apps show where desktop and web say something else. A phone has no
// desktop app beside it and no folder to pick, and the store apps never point to the website
// (the mobile app's store-rules test scans these).

export const NATIVE_COPY = {
  syncSetup: "Etude syncs your collection through a server.",
  syncFolder: "Syncing through a folder.",
  passkeysElsewhere: "Passkeys for this account can't be added in this app. Sign in with an email code instead.",
  selling: "Selling decks isn't available in this app.",
  // The ChatGPT sign-in needs the Keychain; if reading it failed when the app started, there's no way in.
  chatGptUnavailable: "ChatGPT sign-in can't start: Etude couldn't read this device's secure storage when it opened. Close Etude completely and open it again.",
  // Settings → Privacy and the last setup step. The same words on every platform, so they pass the scan too.
  privacyErrors: "When something breaks, Etude sends the error, where in its code it happened, the app version and your system to Etude's server in Toronto. Never your cards, answers, file names or account, and nothing that links it to you.",
  privacyUsage: "Daily counts of the features you use (cards reviewed, decks made, Market installs…), with the app version and system. Never what's in them, and not linked to your account.",
  privacyOnboarding: "Help improve Etude: share anonymous usage counts",
  privacyOnboardingHint: "Daily counts of which features you use, never your cards. Change it any time in Settings → Privacy.",
} as const;
