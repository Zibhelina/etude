import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { accountFor, AccountError } from "../../core/account.ts";
import { command, group, CliError } from "../registry.ts";

group({ name: "account", summary: "Etude account: sign-in, devices, Sync subscription, purchased decks and selling on the paid Market", defaultVerb: "status" });

const a = (c: { e: any }) => accountFor(c.e);
const LISTING = { name: "listing", description: "Listing id (lst_…) or slug.", required: true };
const COVER_TYPES: Record<string, string> = { ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

function cover(path: string | undefined) {
  if (!path) return undefined;
  const type = COVER_TYPES[extname(path).toLowerCase()];
  if (!type) throw new CliError("covers are .webp, .png or .jpg", "validation");
  if (!existsSync(path)) throw new CliError(`no such file: ${path}`, "not_found");
  return { type, data: readFileSync(path).toString("base64") };
}
function cents(v: unknown): number {
  const n = Number(String(v ?? "").replace(/^US\$|^\$/, ""));
  if (!Number.isFinite(n) || n <= 0) throw new CliError("--price is in US dollars, e.g. 10 or 7.50", "validation");
  return Math.round(n * 100);
}
/** Server answers become CLI errors with the matching exit code. */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AccountError) {
      const code = e.status === 404 ? "not_found" : e.status === 409 ? "conflict" : e.status === 502 || e.status >= 500 ? "external" : e.status === 400 || e.status === 422 ? "validation" : "usage";
      throw new CliError(e.message, code, { status: e.status, code: e.code });
    }
    throw e;
  }
}

command({ name: "account status", summary: "Server, sign-in state, account, Sync plan and storage.", output: "{ server, offering, signedIn, email, me, billing, vault }", run: (c) => call(() => a(c).status()) });
command({
  name: "account server",
  summary: "Show or change the Etude server this install uses (default https://sync.etude.study, or $ETUDE_CLOUD_URL).",
  args: [{ name: "url", description: "Server address. Empty string goes back to the default." }],
  writes: true,
  examples: ["etude account server", "etude account server http://localhost:4870"],
  output: "{ server }",
  run: (c) => (c.args.url === undefined ? { server: a(c).server() } : call(async () => a(c).setServer(c.args.url))),
});
command({ name: "account signin", summary: "Email a one-time sign-in code.", args: [{ name: "email", description: "Account email.", required: true }], writes: true, output: "{ ok, server, email }", run: (c) => call(() => a(c).signin(c.args.email)) });
command({ name: "account verify", summary: "Redeem the code from the sign-in email. When already signed in, it re-confirms this device.", args: [{ name: "code", description: "The code from the email.", required: true }], flags: [{ name: "name", type: "string", description: "Name for this device." }], writes: true, output: "{ reauth, email }", run: (c) => call(() => a(c).verify(c.args.code, c.flags.name)) });
command({ name: "account signout", summary: "Sign this device out of the account. Local data stays.", writes: true, output: "{ signedIn }", run: (c) => call(() => a(c).signout()) });
command({ name: "account devices", summary: "Devices signed in to the account.", output: "{ devices: [{ id, name, via, created, lastSeen, current }] }", run: (c) => call(() => a(c).devices()) });
command({ name: "account revoke", summary: "Sign a device out. Another device needs a sign-in on this one within 10 minutes.", args: [{ name: "device", description: "Device id.", required: true }], writes: true, output: "{ ok }", run: (c) => call(() => a(c).revokeDevice(c.args.device)) });
command({ name: "account passkeys", summary: "Passkeys on the account (add them in Settings → Account; the browser holds them).", output: "{ passkeys }", run: (c) => call(() => a(c).passkeys()) });
command({ name: "account email", summary: "Start an email change: a link goes to the new address. Needs a recent sign-in.", args: [{ name: "email", description: "New address.", required: true }], writes: true, output: "{ ok, expiresIn }", run: (c) => call(() => a(c).emailStart(c.args.email)) });
command({ name: "account email-confirm", summary: "Confirm an email change with the code from the link.", args: [{ name: "code", description: "Code from the link.", required: true }], writes: true, output: "{ ok, email }", run: (c) => call(() => a(c).emailVerify(c.args.code)) });
command({
  name: "account export",
  summary: "Download everything the server holds about the account (JSON).",
  flags: [{ name: "out", type: "string", short: "o", description: "Write it to this file instead of stdout.", placeholder: "FILE" }],
  output: "the export, or { written }",
  run: (c) =>
    call(async () => {
      const data = await a(c).exportData();
      if (!c.flags.out) return data;
      const path = resolve(c.flags.out);
      writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
      return { written: path };
    }),
});
command({
  name: "account delete",
  summary: "Delete the account on the server: devices, passkeys, the Sync vault, purchases. Orders stay anonymized for tax. Local data stays.",
  description: "Needs a sign-in on this device within the last 10 minutes (`account signin` + `account verify`), the account's email as --confirm, and --yes.",
  flags: [{ name: "confirm", type: "string", description: "The account's email address." }],
  writes: true,
  confirm: true,
  output: "{ ok, deleted }",
  run: (c) => call(() => a(c).deleteAccount(c.flags.confirm ?? "")),
});
command({ name: "account subscribe", summary: "A checkout link for Etude Sync (US$5/month or US$40/year). Open it in a browser.", flags: [{ name: "yearly", type: "boolean", description: "The yearly plan (US$40) instead of monthly." }], writes: true, output: "{ url, id, plan }", run: (c) => call(() => a(c).syncCheckout(c.flags.yearly ? "yearly" : "monthly")) });
command({ name: "account billing", summary: "A link to manage the Sync subscription (cancel, card, invoices).", output: "{ url }", run: (c) => call(() => a(c).billingPortal()) });
command({ name: "account market", summary: "Paid decks on the server's Market, with price and whether you own them.", output: "{ entries: [{ id, name, price, currency, listing, owned, installed }] }", run: (c) => call(() => a(c).paidIndex()) });
command({ name: "account buy", summary: "A checkout link for a paid deck. Open it in a browser.", args: [LISTING], writes: true, output: "{ url, id, price, fee, currency }", run: (c) => call(() => a(c).checkout(c.args.listing)) });
command({ name: "account library", summary: "Decks you bought, with the latest approved version and whether it's installed here.", output: "{ library: [{ listing, slug, name, version, installed }] }", run: (c) => call(() => a(c).library()) });
command({ name: "account install", summary: "Install or update a purchased deck in this collection.", args: [LISTING], writes: true, dryRun: "self", output: "{ entry, result, ids, report }", run: (c) => call(() => a(c).install(c.args.listing, { dryRun: c.dry })) });
command({ name: "account creator", summary: "Your seller profile on the paid Market, or null.", output: "{ country, stripeAccount, chargesEnabled, payoutsEnabled, detailsSubmitted } | null", run: (c) => call(() => a(c).creator()) });
command({
  name: "account sell",
  summary: "Start selling: creates the payout account and returns the Stripe onboarding link.",
  flags: [
    { name: "country", type: "string", description: "Two-letter country of the payout account (US, CA, GB, EEA, CH)." },
    { name: "name", type: "string", description: "Name shown as the author." },
  ],
  writes: true,
  output: "{ creator, url }",
  run: (c) =>
    call(async () => {
      let cr = await a(c).creator();
      if (!cr) {
        if (!c.flags.country) throw new CliError("--country is required the first time", "usage");
        cr = await a(c).becomeCreator(c.flags.country, c.flags.name);
      }
      return { creator: cr, url: (await a(c).onboardingLink()).url };
    }),
});
command({ name: "account listings", summary: "Your listings with status, versions and review notes.", output: "{ listings }", run: (c) => call(() => a(c).listings()) });
command({
  name: "account list-deck",
  summary: "Put a deck from this collection up for sale: draft listing, cover, version 1.0.0. Submit it for review afterwards.",
  args: [{ name: "deck", description: "Deck name.", required: true }],
  flags: [
    { name: "price", type: "string", description: "Price in US dollars (at least 5)." },
    { name: "name", type: "string", description: "Listing name (default: the deck's)." },
    { name: "description", type: "string", description: "What buyers get." },
    { name: "tag", type: "string", multiple: true, description: "Tag (repeatable)." },
    { name: "cover", type: "string", description: "Cover image (.webp, .png or .jpg, ≤ 600 KB).", placeholder: "FILE" },
  ],
  writes: true,
  examples: ['etude account list-deck "Pharmacology" --price 12 --cover cover.webp --description "…"'],
  output: "the listing",
  run: (c) => call(() => a(c).createListing({ deck: c.args.deck, price: cents(c.flags.price), name: c.flags.name, description: c.flags.description, tags: c.flags.tag, cover: cover(c.flags.cover) })),
});
command({ name: "account update-listing", summary: "Upload the deck again as the next version. Buyers get it after review.", args: [LISTING, { name: "deck", description: "Deck name.", required: true }], flags: [{ name: "changelog", type: "string", description: "What changed." }], writes: true, output: "the listing", run: (c) => call(() => a(c).newVersion(c.args.listing, { deck: c.args.deck, changelog: c.flags.changelog })) });
command({ name: "account submit", summary: "Send a listing for review.", args: [LISTING], writes: true, output: "the listing", run: (c) => call(() => a(c).submit(c.args.listing)) });
command({ name: "account hide", summary: "Take a listing off sale. Buyers keep it.", args: [LISTING], writes: true, output: "the listing", run: (c) => call(() => a(c).hide(c.args.listing)) });
command({ name: "account sales", summary: "Your sales and earnings (after Etude's 20% fee).", output: "{ sales, totals: { count, gross, earnings } }", run: (c) => call(() => a(c).sales()) });
command({ name: "account review", summary: "Admins: listings waiting for review.", output: "{ queue }", run: (c) => call(() => a(c).reviewQueue()) });
command({ name: "account approve", summary: "Admins: approve a listing's pending versions; it goes live.", args: [{ name: "listing", description: "Listing id.", required: true }], flags: [{ name: "notes", type: "string", description: "Note to the creator." }], writes: true, output: "the listing", run: (c) => call(() => a(c).approve(c.args.listing, c.flags.notes)) });
command({ name: "account reject", summary: "Admins: turn down a listing's pending versions with a reason.", args: [{ name: "listing", description: "Listing id.", required: true }], flags: [{ name: "notes", type: "string", description: "Why (sent to the creator)." }], writes: true, output: "the listing", run: (c) => call(() => a(c).reject(c.args.listing, c.flags.notes ?? "")) });
