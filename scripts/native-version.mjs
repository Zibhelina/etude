// Writes package.json's version into the iOS Xcode project, so the native app can't drift from the release.
// 2.5.0 → MARKETING_VERSION 2.5.0, CURRENT_PROJECT_VERSION 20500 (major*10000 + minor*100 + patch).
// Android reads package.json itself in android/app/build.gradle, with its own versionCode scheme (store/android/README.md). Runs as part of `npm run app:sync`; `--check` only reports a mismatch.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
if (!m) throw new Error(`package.json version ${version} is not major.minor.patch`);
const [major, minor, patch] = m.slice(1).map(Number);
if (minor > 99 || patch > 99) throw new Error(`minor and patch must be below 100 for the build number scheme (${version})`);
const marketing = `${major}.${minor}.${patch}`;
const build = String(major * 10000 + minor * 100 + patch);

const pbx = join(root, "ios/App/App.xcodeproj/project.pbxproj");
const before = readFileSync(pbx, "utf8");
const after = before
  .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${marketing};`)
  .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${build};`);

if (process.argv.includes("--check")) {
  if (after !== before) {
    console.error(`iOS version differs from package.json ${marketing} (${build}); run npm run app:version`);
    process.exit(1);
  }
  console.log(`iOS version matches package.json: ${marketing} (${build})`);
} else if (after !== before) {
  writeFileSync(pbx, after);
  console.log(`iOS version set to ${marketing} (${build})`);
} else {
  console.log(`iOS version already ${marketing} (${build})`);
}
