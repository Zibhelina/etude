// App Store Connect API calls for the iOS workflow (.github/workflows/ios.yml). Node only, no packages.
//
//   node scripts/ios-ci.mjs certs-before <file>   before the archive: write the ids of the team's development certificates
//   node scripts/ios-ci.mjs certs-prune <file>    after the upload: revoke the development certificates this run made
//   node scripts/ios-ci.mjs wait-build <version> <build>   wait until Apple has processed the uploaded build
//
// On a fresh runner the keychain is empty, so Xcode's automatic signing makes a new "Apple Development"
// certificate through the API key to sign the archive. The team can hold only a few, so the run revokes
// the ones it made (only development certificates that weren't there before; never a distribution or
// Developer ID certificate, nor one made in Xcode on a Mac). The upload itself is signed with Apple's
// cloud-managed distribution certificate, which doesn't depend on that development one.
//
// Needs ASC_KEY_PATH (the .p8 file), ASC_KEY_ID, ASC_ISSUER_ID and, for wait-build, ASC_APP_ID.
import { readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, sign } from "node:crypto";

const { ASC_KEY_PATH, ASC_KEY_ID, ASC_ISSUER_ID, ASC_APP_ID } = process.env;
const [command, ...args] = process.argv.slice(2);
if (!ASC_KEY_PATH || !ASC_KEY_ID || !ASC_ISSUER_ID) {
  console.error("ASC_KEY_PATH, ASC_KEY_ID and ASC_ISSUER_ID must be set");
  process.exit(2);
}

function token() {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${part({ alg: "ES256", kid: ASC_KEY_ID, typ: "JWT" })}.${part({ iss: ASC_ISSUER_ID, iat: now, exp: now + 600, aud: "appstoreconnect-v1" })}`;
  const key = createPrivateKey(readFileSync(ASC_KEY_PATH));
  return `${unsigned}.${sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

async function api(method, path) {
  const response = await fetch(`https://api.appstoreconnect.apple.com${path}`, { method, headers: { authorization: `Bearer ${token()}` } });
  if (!response.ok) throw new Error(`${method} ${path.split("?")[0]}: HTTP ${response.status} ${(await response.text()).slice(0, 500)}`);
  return response.status === 204 ? null : response.json();
}

async function developmentCertificates() {
  const found = await api("GET", "/v1/certificates?limit=200&filter[certificateType]=DEVELOPMENT,IOS_DEVELOPMENT&fields[certificates]=name,displayName,certificateType");
  return found.data.map((c) => ({ id: c.id, name: `${c.attributes.name ?? ""} ${c.attributes.displayName ?? ""}` }));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (command === "certs-before") {
  const certs = await developmentCertificates();
  writeFileSync(args[0], JSON.stringify(certs.map((c) => c.id)));
  console.log(`${certs.length} development certificate(s) before the archive.`);
} else if (command === "certs-prune") {
  let before;
  try {
    before = new Set(JSON.parse(readFileSync(args[0], "utf8")));
  } catch {
    console.log("No list from before the archive, so nothing is revoked.");
    process.exit(0);
  }
  // Xcode names the ones it makes with an API key "Created via API".
  const fresh = (await developmentCertificates()).filter((c) => !before.has(c.id) && /Created via API/i.test(c.name));
  for (const c of fresh) {
    await api("DELETE", `/v1/certificates/${c.id}`);
    console.log(`Revoked development certificate ${c.id}, made for this run.`);
  }
  if (fresh.length === 0) console.log("This run made no development certificate.");
} else if (command === "wait-build") {
  const [version, build] = args;
  if (!ASC_APP_ID || !version || !build) {
    console.error("usage: ASC_APP_ID=… node scripts/ios-ci.mjs wait-build <version> <build>");
    process.exit(2);
  }
  const query = `/v1/builds?filter[app]=${ASC_APP_ID}&filter[preReleaseVersion.version]=${encodeURIComponent(version)}&filter[version]=${encodeURIComponent(build)}&fields[builds]=version,processingState,uploadedDate`;
  const deadline = Date.now() + 25 * 60_000;
  let last = "";
  for (;;) {
    const found = await api("GET", query);
    const state = found.data[0]?.attributes.processingState ?? "not listed yet";
    if (state !== last) console.log(`${version} (${build}): ${state}`);
    last = state;
    if (state === "VALID") break;
    if (state === "FAILED" || state === "INVALID") {
      console.error(`Apple rejected build ${build}: ${state}. App Store Connect → TestFlight shows why, and Apple emails the account holder.`);
      process.exit(1);
    }
    if (Date.now() > deadline) {
      console.log(`Still ${state} after 25 minutes; the upload went through and Apple finishes processing on its own.`);
      break;
    }
    await sleep(30_000);
  }
} else {
  console.error("usage: node scripts/ios-ci.mjs certs-before|certs-prune <file> | wait-build <version> <build>");
  process.exit(2);
}
