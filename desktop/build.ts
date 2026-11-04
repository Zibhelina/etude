// Builds the desktop installers for this computer's system: stages the app in dist/app (the engine's
// files, the web build and the desktop code, with only the engine's packages) and hands it to
// electron-builder, which writes the installers and the updater's files to dist/out.
//
//   npm run build && node desktop/build.ts
//
// Mac: Apple Silicon and Intel, ad-hoc signed unless CSC_LINK holds the Developer ID certificate
// (then also notarized and stapled, the apps and the .dmg files, when APPLE_API_KEY, APPLE_API_KEY_ID
// and APPLE_API_ISSUER are set). docs/signing.md says how to get them.
// Windows: the x64 installer. Linux: AppImage, .deb and .rpm (the .rpm needs rpmbuild).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { build, type Configuration } from "electron-builder";

const DESKTOP = import.meta.dirname;
const ROOT = join(DESKTOP, "..");
const APP = join(DESKTOP, "dist", "app");
const OUT = join(DESKTOP, "dist", "out");
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const pkg = read(join(ROOT, "package.json"));
const desktopPkg = read(join(DESKTOP, "package.json"));
// CI passes the signing secrets even when they don't exist yet, as empty strings, and electron-builder
// would take an empty CSC_LINK for a certificate. Without them the Mac app is signed ad hoc.
const SIGNING = ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"];
for (const k of SIGNING) if (!process.env[k]) delete process.env[k];
// The Developer ID certificate is only for the Mac: electron-builder would also sign the Windows
// installer with CSC_LINK when WIN_CSC_LINK is unset. A pull request builds unsigned, as
// electron-builder skips signing there, and an app marked signed but left unsigned wouldn't open.
if (process.platform !== "darwin" || process.env.GITHUB_EVENT_NAME === "pull_request") for (const k of SIGNING) delete process.env[k];
const signed = !!process.env.CSC_LINK;
// notarytool wants the API key as a file; CI holds the .p8's text in the secret.
let keyDir: string | null = null;
if (process.env.APPLE_API_KEY?.includes("PRIVATE KEY")) {
  keyDir = mkdtempSync(join(tmpdir(), "etude-notary-"));
  const file = join(keyDir, `AuthKey_${process.env.APPLE_API_KEY_ID ?? "key"}.p8`);
  writeFileSync(file, process.env.APPLE_API_KEY.trim() + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  process.env.APPLE_API_KEY = file;
}
const notarized = signed && !!process.env.APPLE_API_KEY;

/** Mac downloads keep the names the download page links to; the updater's zips keep arm64/x64, which it reads. */
const MAC_NAMES: Record<string, string> = { arm64: "apple-silicon", x64: "intel" };

if (!existsSync(join(ROOT, "web", "dist", "index.html"))) throw new Error("Build the web app first: npm run build");

// ---------------------------------------------------------------- stage

rmSync(join(DESKTOP, "dist"), { recursive: true, force: true });
for (const dir of ["bin", "runtime", "types", "schedulers", "examples", join("web", "dist")]) cpSync(join(ROOT, dir), join(APP, dir), { recursive: true });
// src/browser is the serverless build's, bundled elsewhere.
cpSync(join(ROOT, "src"), join(APP, "src"), { recursive: true, filter: (p) => relative(join(ROOT, "src"), p).split(/[\\/]/)[0] !== "browser" });
cpSync(join(ROOT, "LICENSE"), join(APP, "LICENSE"));
const shell = new Set(["main.mjs", "preload.cjs", "pages", "bin"]);
for (const name of readdirSync(DESKTOP)) {
  if (shell.has(name) || (name.endsWith(".ts") && name !== "build.ts")) cpSync(join(DESKTOP, name), join(APP, "desktop", name), { recursive: true });
}
writeFileSync(
  join(APP, "package.json"),
  JSON.stringify(
    {
      name: "etude",
      productName: "Etude",
      version: pkg.version,
      description: pkg.description,
      author: pkg.author,
      license: pkg.license,
      homepage: pkg.homepage,
      type: "module",
      main: "desktop/main.mjs",
      // Linux desktops match the window to its menu entry by this name.
      desktopName: "etude-desktop.desktop",
      dependencies: { ...pkg.dependencies, ...desktopPkg.dependencies },
      optionalDependencies: pkg.optionalDependencies,
      // How this build updates on a Mac: by itself once signed, else through a link.
      etudeDesktop: { macSigned: signed },
    },
    null,
    2,
  ),
);
cpSync(join(ROOT, "package-lock.json"), join(APP, "package-lock.json"));
const npm = (args: string[]) => execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, { cwd: APP, stdio: "inherit", shell: process.platform === "win32" });
npm(["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"]);
// One Mac build makes both apps, so both get the FSRS optimizer's native part.
if (process.platform === "darwin") {
  const v = read(join(APP, "node_modules", "@open-spaced-repetition", "binding", "package.json")).version;
  npm(["install", "--no-save", "--force", "--no-audit", "--no-fund", "--loglevel=error", `@open-spaced-repetition/binding-darwin-arm64@${v}`, `@open-spaced-repetition/binding-darwin-x64@${v}`]);
}
rmSync(join(APP, "package-lock.json"));

// ---------------------------------------------------------------- installers

const linuxScripts = { afterInstall: "build/linux-after-install.sh", afterRemove: "build/linux-after-remove.sh" };
const hasRpmbuild = (() => {
  try {
    execFileSync("rpmbuild", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
if (process.platform === "linux" && !hasRpmbuild) console.warn("rpmbuild isn't installed: skipping the .rpm");

const config: Configuration = {
  appId: "study.etude.desktop",
  productName: "Etude",
  copyright: "© 2026 Etude contributors",
  directories: { app: "dist/app", output: "dist/out", buildResources: "build" },
  // The engine reads its own files from disk, as in a checkout.
  asar: false,
  // The only native package (the optimizer) ships prebuilt for each system.
  npmRebuild: false,
  electronFuses: {
    // The etude command runs the app's program in Node mode.
    runAsNode: true,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
  },
  publish: { provider: "github", owner: "Zibhelina", repo: "etude" },
  mac: {
    category: "public.app-category.education",
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ],
    artifactName: "Etude-mac-${arch}.${ext}",
    minimumSystemVersion: "12.0",
    hardenedRuntime: true,
    // Absolute: codesign doesn't run from this folder.
    entitlements: join(DESKTOP, "build", "entitlements.mac.plist"),
    entitlementsInherit: join(DESKTOP, "build", "entitlements.mac.plist"),
    // Inside the app folder only native modules are code; the app's seal covers the other files.
    signIgnore: ["/Contents/Resources/app/(?!.*\\.node$)"],
    ...(signed ? { notarize: notarized } : { identity: "-" }),
  },
  // Signed with the same certificate; notarized and stapled below, after electron-builder.
  dmg: { sign: signed },
  win: { target: [{ target: "nsis", arch: ["x64"] }] },
  nsis: { oneClick: true, perMachine: false, artifactName: "Etude-windows-setup.${ext}" },
  linux: {
    target: ["AppImage", "deb", ...(hasRpmbuild ? ["rpm"] : [])],
    // /usr/bin/etude is the etude command; the app's program gets another name.
    executableName: "etude-desktop",
    category: "Education",
    maintainer: "Etude <hello@etude.study>",
    synopsis: "Spaced repetition with programmable card types",
    syncDesktopName: true,
  },
  appImage: { artifactName: "Etude-linux-x86_64.AppImage" },
  deb: { artifactName: "Etude-linux-amd64.deb", ...linuxScripts },
  rpm: { artifactName: "Etude-linux-x86_64.rpm", ...linuxScripts },
};

try {
  await build({ projectDir: DESKTOP, config, publish: "never" });

  if (process.platform === "darwin") {
    const yml = join(OUT, "latest-mac.yml");
    let text = readFileSync(yml, "utf8");
    for (const [arch, name] of Object.entries(MAC_NAMES)) {
      for (const ext of [".dmg", ".dmg.blockmap"]) {
        const from = join(OUT, `Etude-mac-${arch}${ext}`);
        if (existsSync(from)) renameSync(from, join(OUT, `Etude-mac-${name}${ext}`));
      }
      text = text.replaceAll(`Etude-mac-${arch}.dmg`, `Etude-mac-${name}.dmg`);
    }
    if (notarized) for (const name of Object.values(MAC_NAMES)) text = notarizeDmg(`Etude-mac-${name}.dmg`, text);
    writeFileSync(yml, text);
  }
} finally {
  if (keyDir) rmSync(keyDir, { recursive: true, force: true });
}

/**
 * electron-builder notarizes the apps but not the .dmg around them. Apple asks for the file people
 * download to be notarized too, so Gatekeeper passes it offline. Stapling changes the file, so its
 * entry in latest-mac.yml gets the new hash and size, and its block map (made for the old file, and
 * unused: the Mac updater downloads the .zip) goes.
 */
function notarizeDmg(file: string, yml: string): string {
  const path = join(OUT, file);
  const xcrun = (args: string[]) => execFileSync("xcrun", args, { stdio: "inherit" });
  xcrun(["notarytool", "submit", path, "--key", process.env.APPLE_API_KEY!, "--key-id", process.env.APPLE_API_KEY_ID!, "--issuer", process.env.APPLE_API_ISSUER!, "--wait"]);
  xcrun(["stapler", "staple", path]);
  xcrun(["stapler", "validate", path]);
  rmSync(`${path}.blockmap`, { force: true });
  return updateYmlEntry(yml, file, createHash("sha512").update(readFileSync(path)).digest("base64"), statSync(path).size);
}
console.log(`installers in ${relative(process.cwd(), OUT) || "."}`);

/** Gives one file's entry in an electron-builder update file a new hash and size, and drops its block map size. */
function updateYmlEntry(yml: string, file: string, sha512: string, size: number): string {
  const lines = yml.split("\n");
  const at = lines.findIndex((l) => l.trim() === `- url: ${file}`);
  if (at < 0) throw new Error(`${file} isn't in the update file`);
  const indent = lines[at].indexOf("-") + 2;
  let end = at + 1;
  while (end < lines.length && lines[end].startsWith(" ".repeat(indent)) && !lines[end].trim().startsWith("-")) end++;
  const entry = [lines[at], `${" ".repeat(indent)}sha512: ${sha512}`, `${" ".repeat(indent)}size: ${size}`];
  for (const l of lines.slice(at + 1, end)) if (!/^\s*(sha512|size|blockMapSize):/.test(l)) entry.push(l);
  lines.splice(at, end - at, ...entry);
  return lines.join("\n");
}
