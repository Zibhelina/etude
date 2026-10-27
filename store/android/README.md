# Etude for Android

The app is the serverless browser build (`npm run build:browser` → `dist-browser/`) inside a Capacitor shell in `android/`. App id `study.etude.app`, name Etude. `versionName` and `versionCode` come from `package.json`: 2.3.0 becomes versionName `2.3.0` and versionCode `20300` (major × 10000 + minor × 100 + patch). Bump the version in `package.json` before each upload; Play refuses a versionCode it has seen.

`targetSdkVersion` and `compileSdkVersion` are 36 (Android 16). Since 31 August 2026, Google Play requires new apps and updates to target API 36 or higher. `minSdkVersion` is 24 (Android 7.0).

## Toolchain (user-local, no sudo)

- JDK: Temurin 21 in `~/.local/opt/jdk-21.0.13+9`
- SDK: `~/Android/Sdk` (command-line tools, platform-tools, platforms;android-36, build-tools 35.0.0 and 36.0.0, emulator, system-images;android-36;google_apis;x86_64)

```sh
export JAVA_HOME=~/.local/opt/jdk-21.0.13+9 ANDROID_HOME=~/Android/Sdk
export PATH=$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH
echo "sdk.dir=$ANDROID_HOME" > android/local.properties   # once
```

## Builds

```sh
npm run app:android:debug     # android/app/build/outputs/apk/debug/app-debug.apk
npm run app:android:release   # android/app/build/outputs/bundle/release/app-release.aab
```

Without `ETUDE_KEYSTORE` set, the release bundle is unsigned (fine to inspect, not to upload).

## The upload key (run once, keep it safe)

Play App Signing holds the real app signing key; you sign uploads with an upload key that stays on your machine. Create it outside the repo:

```sh
mkdir -p ~/.etude-signing && chmod 700 ~/.etude-signing
keytool -genkeypair -v \
  -keystore ~/.etude-signing/etude-upload.jks \
  -alias etude-upload \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=Etude, O=Etude, C=CA"
```

`keytool` asks for a password. Put it in your password manager, and back up `etude-upload.jks` somewhere off this machine. If the upload key is lost, Play support can reset it, which takes days.

Sign a release bundle:

```sh
export ETUDE_KEYSTORE=~/.etude-signing/etude-upload.jks
export ETUDE_KEY_ALIAS=etude-upload
read -rs ETUDE_KEYSTORE_PASSWORD && export ETUDE_KEYSTORE_PASSWORD
npm run app:android:release
```

`android/app/build.gradle` reads those four variables (`ETUDE_KEY_PASSWORD` defaults to the store password). No keystore or password is ever committed.

## App Links (https://etude.study/app/…)

`AndroidManifest.xml` claims `https://etude.study/app/*` with `autoVerify`. Android only opens those links in the app when `https://etude.study/.well-known/assetlinks.json` lists the **app signing** key's SHA-256 fingerprint (from Play Console → Test and release → App integrity → App signing; with Play App Signing it differs from your upload key). Replace `SHA256_FINGERPRINT` in `store/well-known/assetlinks.json` with it (colon-separated, upper case), and add your upload key's fingerprint as a second entry if you also install builds you signed yourself:

```sh
keytool -list -v -keystore ~/.etude-signing/etude-upload.jks -alias etude-upload | grep SHA256
```

`etude://…` links work without any of this.

## Play Console, step by step

1. Create the developer account at play.google.com/console (US$25 once, identity verification). For a new personal account Google requires a closed test with at least 12 testers for 14 continuous days before production access.
2. Create app: name Etude, default language English, App, Free.
3. App content: privacy policy URL (`https://etude.study/privacy`), app access (no login needed to use the app; the optional Etude account uses email links), ads: none, content rating questionnaire, target audience (not designed for children), data safety form (see below), government apps: no, financial features: none.
4. Data safety: data collected is the email address, only if the person creates the optional account, for app functionality and account management, encrypted in transit, deletable on request (and in the app). Collections synced with Etude Sync are end-to-end encrypted, so the server can't read them. Nothing is shared with third parties. AI grading sends answers from the device straight to the provider the person configures with their own key; Etude doesn't receive them.
5. Store listing: short and full description, icon 512×512 (`assets/icon-only.png` scaled), feature graphic 1024×500, at least 2 phone screenshots (the `emu-shots/` from the report are a start; take final ones on a real phone).
6. Test and release → Closed testing → create track → upload `app-release.aab` (signed as above), accept Play App Signing, add testers by email list, roll out. Keep it running 14 days with 12 testers who opted in.
7. Copy the app signing SHA-256 from App integrity into `assetlinks.json` and publish the site.
8. Apply for production access, then Production → create release with the same bundle (or a newer versionCode).
