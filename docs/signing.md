# Signing the desktop apps

The desktop installers come from `.github/workflows/desktop.yml`, which runs `node desktop/build.ts` on a Mac, a Windows and a Linux runner. Without signing, people get a warning the first time they open Etude: macOS says the app "is damaged", Windows SmartScreen says it "protected your PC". This page says what turns that off.

## Mac

### What the build does

| Secrets present | Mac app | Updates on a Mac |
|---|---|---|
| none (and every pull request) | signed ad hoc | a link to the download |
| the certificate only | signed with the Developer ID, hardened runtime, not notarized | by itself |
| the certificate and the API key | signed, notarized and stapled: both apps (the same ones go in the `.zip` files) and both `.dmg` files | by itself |

electron-builder signs the apps with the Developer ID certificate and the hardened runtime, using `desktop/build/entitlements.mac.plist`. It then sends each app to Apple's notary service and staples the ticket to it. It doesn't notarize the `.dmg` around the app, so `desktop/build.ts` does that afterwards with `xcrun notarytool` and `xcrun stapler`, then puts the stapled file's new hash and size in `latest-mac.yml`. A stapled file passes Gatekeeper even offline.

Pull requests never get the secrets, so a pull request from anyone builds the same way it always did. Only the Mac runner gets them; the Windows runner would otherwise sign its installer with the Mac certificate.

When the secrets are there, the step "The Mac apps' signatures hold" also checks that each app is signed by a Developer ID with the hardened runtime, and when notarized, that `stapler validate` and `spctl` accept the apps and the `.dmg` files. A broken signature fails the build before anything reaches a release.

### What João creates (once)

Only the Account Holder of the Apple Developer team can create a Developer ID certificate. On an individual account that's the account owner.

1. **The Developer ID Application certificate.** On the Mac, in Xcode: Settings → Accounts → select the team → Manage Certificates → **+** → **Developer ID Application**. (Or on developer.apple.com → Certificates → **+** → Developer ID Application, with a certificate signing request made in Keychain Access → Certificate Assistant.) Pick "Developer ID Application", not "Developer ID Installer" (that one is for `.pkg` files) and not "Apple Development".
2. **Export it as a .p12.** Keychain Access → login → My Certificates → right-click "Developer ID Application: …" → Export → format `.p12`, with a strong password. The export includes the private key; keep the file somewhere safe and off the repo.
3. **The App Store Connect API key, for notarizing.** App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → **+**. Name it something like "Etude notarization", role **Developer**. Download the `.p8` file: Apple lets you download it only once. The page shows the **Key ID** next to the key and the **Issuer ID** above the list.

### The GitHub secrets

Repository → Settings → Secrets and variables → Actions → New repository secret. The names have to match exactly:

| Secret | What goes in it |
|---|---|
| `MAC_CERTIFICATE` | the `.p12` as base64: `base64 -i DeveloperID.p12 \| pbcopy`, then paste |
| `MAC_CERTIFICATE_PASSWORD` | the password chosen when exporting the `.p12` |
| `APPLE_API_KEY` | the whole text of the `.p8` file, including the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines |
| `APPLE_API_KEY_ID` | the Key ID, 10 characters |
| `APPLE_API_ISSUER` | the Issuer ID, a UUID |

With the GitHub CLI instead: `base64 -i DeveloperID.p12 | gh secret set MAC_CERTIFICATE`, `gh secret set APPLE_API_KEY < AuthKey_XXXXXXXXXX.p8`, and `gh secret set NAME` for the others (it asks for the value).

### Trying it before a release

Run the "Desktop app" workflow by hand on `main` (Actions → Desktop app → Run workflow). That builds without making a release. Notarizing adds a few minutes per file (two apps and two `.dmg` files). Then check:

- the log of "The Mac apps' signatures hold" shows `Authority=Developer ID Application: …` and `accepted` / `source=Notarized Developer ID` for each app and `.dmg`;
- "The packaged app runs from outside the repo" passed (the engine and its native optimizer load under the hardened runtime);
- the `etude-macOS` artifact's `.dmg`, downloaded with a browser on a Mac, opens with no warning beyond "downloaded from the internet".

The same `.p8` and IDs work on a Mac too: `APPLE_API_KEY=~/path/AuthKey_XXXXXXXXXX.p8 APPLE_API_KEY_ID=… APPLE_API_ISSUER=… CSC_LINK=~/path/DeveloperID.p12 CSC_KEY_PASSWORD=… node desktop/build.ts`. `APPLE_API_KEY` may be the file's path or its text; the build writes the text to a private temporary file for `notarytool` and deletes it after.

### After the first signed release

- The download page (`site/src/download.html`) tells Mac users to run `xattr` and `codesign --sign -` and tells Windows users the installer isn't signed. Take each out once the matching signed release is published, not before.
- Mac installs from before then keep updating through the download link; from the signed version on they update themselves.
- `com.apple.security.cs.disable-library-validation` in the entitlements is only needed for ad-hoc builds. A signed build might run without it; try that in a hand-run build before removing it, since the smoke test is what shows the native optimizer still loads.
- The certificate lasts five years. The API key doesn't expire, but anyone with it can notarize under the team: revoke it in App Store Connect if it leaks.

## Windows

Windows signing isn't set up yet. Since June 2023 a code-signing certificate's private key has to live on a hardware token or in a cloud HSM, so a plain `.pfx` file in a secret is no longer an option. These are the routes open to one person in Canada, checked on November 3, 2026:

| | Azure Artifact Signing (was "Trusted Signing") | OV / IV certificate from a CA | SignPath Foundation |
|---|---|---|---|
| Price | Basic: US$9.99 a month, 5,000 signatures a month included, then US$0.005 each (Azure price list) | SSL.com IV (individual): US$129 a year, plus a paid eSigner cloud subscription to sign from CI or a US$379 YubiKey. Certum (Poland): from €209 a year for standard code signing in its SimplySign cloud | free |
| Open to an individual in Canada | yes: individuals must be in the US or Canada | yes | only for projects that qualify (below) |
| Identity check | an Azure subscription whose billing account type is Individual, with the legal name and address matching a government photo ID; the check runs through Au10tix and Microsoft Authenticator (Verified ID) on a phone; 1 to 20 business days | the CA checks a government photo ID and contact details; the steps and time depend on the CA | none of the developer; SignPath checks the project and that the binary is built from its public repository |
| Name shown as publisher | the legal name from the ID | the legal name | "SignPath Foundation" |
| Works from GitHub Actions | yes: electron-builder 26 has `win.azureSignOptions` | eSigner yes (an extra CI tool and a paid tier); a YubiKey needs a self-hosted Windows runner with the key plugged in | yes, through SignPath's GitHub action |
| SmartScreen warning | goes away as the signed file builds download history | the same | the same |

SignPath's free certificate needs an OSI-approved license "without commercial dual-licensing for all components" and no proprietary parts. Etude is AGPL-3.0 but also offered under a commercial license (README, `CLA.md`), so it doesn't qualify.

No option clears SmartScreen on day one; Microsoft says the prompt stops "once the file hash has sufficient download history". What a signature changes right away is the publisher line: a name instead of "Unknown publisher", and the warning fades with use instead of starting over at every release.

**Recommendation: Azure Artifact Signing, Basic.** It's the cheapest (about US$120 a year, against US$129 plus the cloud-signing fee for an IV certificate), it's meant for exactly this case (an individual in the US or Canada), there's no token to buy or lose, the certificate renews itself, and electron-builder signs with it from the GitHub Windows runner. The catch: Windows shows the legal name from the ID as the publisher, and the billing address has to match the ID.

### What it would take (not done yet)

1. An Azure account with an Individual billing account and a pay-as-you-go subscription (a credit card).
2. In the portal: register the `Microsoft.CodeSigning` resource provider, create an Artifact Signing account (Basic) in a supported region (East US is `https://eus.codesigning.azure.net`), and give yourself the "Artifact Signing Identity Verifier" role.
3. A New identity → Individual request, completed on a phone with the photo ID; wait for it to be Completed.
4. A Public Trust certificate profile on that identity.
5. An app registration (service principal) for CI with the "Artifact Signing Certificate Profile Signer" role on the account, and a client secret.
6. In GitHub: secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` (the names Azure's credential libraries read; check against electron-builder's docs when setting it up) passed to the Windows build only; in `desktop/build.ts`, `win.azureSignOptions` with `publisherName` (exactly the certificate's name), `endpoint`, `codeSigningAccountName` and `certificateProfileName`, set only when the secrets exist, the way the Mac signing works.

Then `win.verifyUpdateCodeSignature` can stay on: the updater refuses an update not signed by the same publisher.

## Sources

- electron-builder 26.18 source: `app-builder-lib/out/mac/MacTargetHelper.js` (notarization credentials), `codeSign/macCodeSign.js` (signing skipped on pull requests), `platformPackager.js` (Windows falls back to `CSC_LINK`), `dmg-builder/out/dmg.js` (`dmg.sign`), `@electron/notarize` (staples the app; the API key must be a file path).
- Microsoft Learn, Artifact Signing quickstart and FAQ (eligibility, identity validation, regions, SmartScreen), and the Azure retail prices API for "Trusted Signing" (Basic US$9.99, Premium US$99.99, overage US$0.005), read November 3, 2026.
- SSL.com IV and OV code signing pages; Certum shop, code signing; signpath.org/terms, read November 3, 2026.
