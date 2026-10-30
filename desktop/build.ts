// Builds the desktop installers for this computer's system: stages the app in dist/app (the engine's
// files, the web build and the desktop code, with only the engine's packages) and hands it to
// electron-builder, which writes the installers and the updater's files to dist/out.
//
//   npm run build && node desktop/build.ts
//
// Mac: Apple Silicon and Intel, ad-hoc signed unless CSC_LINK holds the Developer ID certificate
// (then also notarized when APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER are set).
// Windows: the x64 installer. Linux: AppImage, .deb and .rpm (the .rpm needs rpmbuild).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
for (const k of ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]) if (!process.env[k]) delete process.env[k];
const signed = !!process.env.CSC_LINK;

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
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    ...(signed ? { notarize: !!process.env.APPLE_API_KEY } : { identity: "-" }),
  },
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
  writeFileSync(yml, text);
}
console.log(`installers in ${relative(process.cwd(), OUT) || "."}`);
