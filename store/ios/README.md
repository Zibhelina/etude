# Etude for iPhone and iPad

The app is the serverless browser build (`dist-browser/`) inside a Capacitor shell in `ios/`. Bundle id `study.etude.app`, display name Etude, version and build come from `package.json` (2.5.0 → Version 2.5.0, Build 20500: major × 10000 + minor × 100 + patch, the same scheme as Android's versionCode), iOS 15 or later, iPhone and iPad. Capacitor 8 uses Swift Package Manager, so there is no CocoaPods step.

What's already in the project:

- `ios/App/App/Info.plist`: `ITSAppUsesNonExemptEncryption` = NO, the `etude://` URL scheme, `arm64`. No usage strings: the app doesn't use the camera, microphone, location, contacts, Face ID or tracking. The image picker for occlusion cards is the system picker, which needs no permission.
- `ios/App/App/PrivacyInfo.xcprivacy`: no tracking, no tracking domains, one collected data type (email address, linked to the person, for app functionality: the optional Etude account), and no required-reason APIs (see below).
- `ios/App/App/App.entitlements`: Associated Domains `applinks:etude.study`, for `https://etude.study/app/*`.
- Icons and splash: `Assets.xcassets` (1024 icon without alpha; splash light and dark), generated from `assets/` by `npm run app:icons`.

## Export compliance: why `ITSAppUsesNonExemptEncryption` is NO

Apple's guidance: set it to NO when the app, with every library it links, uses no encryption or only encryption that is exempt from export documentation; using the encryption built into the operating system, such as HTTPS through the system's networking, is the typical exempt case. Etude's encryption is all standard and all provided by the system or by published algorithms:

- network traffic is HTTPS through WKWebView (the OS's TLS);
- Etude Sync encrypts the collection end to end with AES-256-GCM and HKDF-SHA256 from WebKit's Web Crypto (the OS's implementation), and derives the key from a passphrase with Argon2id (hash-wasm), a published standard algorithm used for authentication and key derivation;
- nothing proprietary or non-standard, and the encryption isn't the app's primary function (it protects the person's own study data).

That is the case Apple describes as exempt (in US export terms, mass-market software using standard encryption; I checked Apple's pages, not the export regulations themselves). Apple's page also says an app using exempt encryption "might" have to file a year-end self-classification report with the US government. Whether that applies to a Canadian developer distributing through the App Store is a question for the accountant or lawyer you already plan to see. If App Store Connect asks the encryption questions anyway, answer that the app uses encryption and that it qualifies for the exemption (only standard, published algorithms, mostly the OS's own).

Sources: developer.apple.com/documentation/security/complying-with-encryption-export-regulations and the `ITSAppUsesNonExemptEncryption` reference (checked 27 Oct 2026).

## Required-reason APIs: why the list is empty

Apple requires a declared reason for: file timestamp APIs, system boot time, disk space, active keyboards, and UserDefaults. The app's own code is JavaScript in WKWebView and calls none of them natively. Capacitor 8 and its App, Keyboard, StatusBar and SplashScreen plugins were searched for those APIs (`UserDefaults`, `systemUptime`, `mach_absolute_time`, file creation/modification dates, `volumeAvailableCapacity`, `activeInputModes`, `stat`) and contain none; Capacitor's own `PrivacyInfo.xcprivacy` declares an empty list too. If a plugin is added later, check its manifest and merge any reasons it declares.

## From GitHub Actions: every push to main goes to TestFlight

`.github/workflows/ios.yml` builds the app on a GitHub Mac runner, signs it and uploads it to App Store Connect on every push to `main`, and when run by hand (Actions → iOS app to TestFlight → Run workflow). Pull requests never run it, since they get no secrets. The internal TestFlight group has access to all builds, so its testers get each one once Apple has processed it (the last step waits for that, up to 25 minutes). Nobody's Mac or Apple ID is involved.

How it signs: Xcode's automatic signing with the team's App Store Connect API key (`xcodebuild -allowProvisioningUpdates -authenticationKeyPath …`). The archive is signed with a development certificate Xcode makes through the key, which the run revokes afterwards so the team's few development slots don't fill up (`scripts/ios-ci.mjs`); the upload is re-signed with Apple's cloud-managed distribution certificate. No certificate, profile or Team ID change is committed.

It uses the same three secrets as the desktop workflow (`docs/signing.md`): `APPLE_API_KEY` (the `.p8` text, or its base64), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. The key must be allowed to use cloud-managed distribution signing: an **Admin** team key, or one whose role has "Access to Cloud Managed Distribution Certificate". With a Developer key the export fails with "Cloud signing permission error"; then make an Admin team key in App Store Connect → Users and Access → Integrations and replace `APPLE_API_KEY` and `APPLE_API_KEY_ID` (the issuer stays). The desktop workflow notarizes with the same key.

Build numbers: the version's own number, then the run number and attempt (`3.0.3` → `30003.57.1`), so every upload is new to App Store Connect and sorts after the hand-made `30003`, `30003.1`, … The marketing version still comes from `package.json`; the workflow fails if the Xcode project doesn't match it (`node scripts/native-version.mjs --check`).

## On the Mac: Xcode, signing, Archive, upload

Prerequisites: a paid Apple Developer Program membership (US$99/year) on your Apple Account, Xcode current (16 or later), and the repo on the Mac.

1. Get the code and the web build into the project:
   ```sh
   cd ~/dev/etude2 && git fetch && git checkout <the branch with the app>
   npm ci
   npm run app:sync          # builds dist-browser/ and copies it into ios/App/App/public
   open ios/App/App.xcodeproj
   ```
   (If you only pulled and didn't change web code, `npx cap sync ios` is enough.)
2. Xcode resolves the Swift packages on first open (Capacitor and the four plugins). Wait for "Package resolution" to finish in the status bar.
3. Select the **App** target → **Signing & Capabilities**:
   - Team: your team (this writes your Team ID into the project; commit that change or keep it local).
   - Automatically manage signing: on. Bundle Identifier stays `study.etude.app`. Xcode registers the App ID with the Associated Domains capability.
   - Check that **Associated Domains** shows `applinks:etude.study`. If Xcode shows a red error for it, click "Try Again" after the App ID registers.
4. Note your **Team ID** (Signing & Capabilities, or developer.apple.com → Membership). Put it in `store/well-known/apple-app-site-association` in place of `TEAMID` (so `"ABCDE12345.study.etude.app"`), and publish the site so `https://etude.study/.well-known/apple-app-site-association` serves it as JSON over HTTPS with no redirect.
5. Run it once: pick an iPhone simulator, Product → Run. Check Decks, study a card, kill and relaunch (data stays).
6. In App Store Connect (appstoreconnect.apple.com) → Apps → **+** → New App: platform iOS, name Etude, primary language English, bundle id `study.etude.app`, SKU `etude-ios`, full access.
7. Back in Xcode: set the run destination to **Any iOS Device (arm64)**, then Product → **Archive**. When the Organizer opens: **Distribute App** → **App Store Connect** → **Upload** → keep automatic signing → Upload.
8. The build appears in App Store Connect → TestFlight after processing (10 to 30 minutes). Because `ITSAppUsesNonExemptEncryption` is NO, it doesn't ask the export questions. Add yourself as an internal tester and install through the TestFlight app.
9. App Store listing, in App Store Connect → the app:
   - App Privacy: Data collection yes → Contact Info → Email Address → used for App Functionality, linked to the user, not used for tracking. Nothing else.
   - Privacy policy URL `https://etude.study/privacy`, support URL `https://etude.study` (or a page with hello@etude.study).
   - Age rating questionnaire (no objectionable content; "unrestricted web access": no, the Market is a curated catalog).
   - Screenshots: 6.9" iPhone (1320×2868 or 1290×2796) and 13" iPad if you keep iPad support. Take them from the simulator (File → Save Screen).
   - Account deletion: Apple requires in-app deletion for apps with account creation; the accounts worker adds it to Settings → Account.
   - App Review notes: Etude works without an account. The Market lists free decks; nothing is sold in the app.
10. Pick the build under the version, then **Add for Review** → **Submit**.

For each new version: bump `version` in `package.json`, then `npm run app:sync`, Archive, upload. `app:sync` runs `npm run app:version` (`scripts/native-version.mjs`), which writes MARKETING_VERSION and CURRENT_PROJECT_VERSION into the Xcode project (2.6.0 → 20600); commit the changed `project.pbxproj` with the version bump. Don't edit Version or Build by hand in Xcode, the next sync overwrites them. `node scripts/native-version.mjs --check` fails if they differ. App Store Connect refuses a build number it has seen, so a second upload of the same version needs a patch bump.
