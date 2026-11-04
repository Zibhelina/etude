# Etude account and the paid Market

The account is optional. Etude works fully offline without one. An account gives three things: Etude Sync (encrypted sync between devices, US$5/month or US$40/year, 1 GB), purchased decks from the paid Market, and selling decks on it.

The app talks to an etude-cloud server. The default is `https://sync.etude.study`. Change it in Settings → Account → Server, with `etude account server <url>`, or with `$ETUDE_CLOUD_URL` (the saved choice wins). The account token lives in `<ETUDE_HOME>/account.json` (mode 600) and never reaches the web page; the UI goes through `/api/account/*` on the local server, which forwards to the cloud.

## Settings → Account

- Sign in with a one-time code from the email, or with a passkey (WebAuthn in the browser; the server's RP id must match the page's host, so passkeys work on `etude.study` pages and on localhost in development).
- Email, change email (a link goes to the new address; needs a sign-in in the last 10 minutes).
- Passkeys: add, remove.
- Devices: list, rename, revoke. Revoking another device needs a fresh sign-in.
- Export my data: the server's JSON export.
- Delete account: type the email to confirm, then confirm a fresh sign-in if the last one is older than 10 minutes. The server deletes devices, passkeys, the Sync vault and entitlements; orders stay anonymized for tax. The local collection stays.

The Sync plan is in Settings → Sync, at the top while signed in to the account (not for folder sync): plan, renewal or end date, storage used of 1 GB. "Subscribe on etude.study" and "Manage subscription" open the website (Polar checkout and portal).

Signing in to the account also signs Sync in when Sync uses the same server, so Sync only needs the vault password afterwards.

## Store rules

`web/src/lib/platform.ts` reads `window.Capacitor` (no import): `isNativeApp()`, `nativePlatform()`, `isIOSApp()`, `canShowPurchases()`.

- Desktop app and browsers: prices, "Buy on etude.study", "Subscribe on etude.study", "Manage subscription", and the Selling tab.
- iOS and Android apps: the apps sell nothing. Paid decks appear only when owned, under "Your decks", with no price, no buy button and no link to buy. The Sync plan shows plan and storage with no price and no subscribe or manage buttons. The Selling tab is hidden.

## Market

The Market has three tabs. Browse shows paid listings from `GET /v1/market/paid-index.json` above the free GitHub catalog. Library lists purchased decks (`GET /v1/library`); Install fetches `/v1/listings/:id/pack` and imports it with the normal pack import, so updates keep scheduling. When a new version is approved the button reads Update.

## Selling

In Market → Selling (desktop and web only):

1. Set up with Stripe: creates the creator's own Stripe account (full Stripe Dashboard) and opens Stripe's onboarding. The creator is the seller: each sale is a direct charge on their account, Stripe's processing fee comes out of it, Etude keeps 20% as an application fee, refunds, disputes and the creator's sales tax are theirs, and payouts follow their Stripe settings. Open Stripe dashboard goes to dashboard.stripe.com, where they sign in with the Stripe login made during setup. A creator who set up before direct charges gets `setupRequired: true` (and `stripeAccount: null`) and sets up once more; their listings stay.
2. List a deck: pick a deck from this collection, a description, a price (US$5 minimum), and a cover. The app exports the deck as a pack and uploads it as version 1.0.0.
3. Submit for review. The listing shows Draft, In review, Live, Rejected (with the reviewer's notes) or Hidden.
4. New version: re-exports the deck with a changelog. Buyers get it after review; a version that isn't approved shows the reviewer's notes.
5. Edit page: name, description, tags, price and cover. Before a listing has been on sale, edits apply right away (it's reviewed when submitted). Once it has been on sale, every edit goes to the Etude team first: the listing shows "Changes waiting for review" with what changed, buyers keep seeing the approved page (and pay the approved price) until it's approved, and the change can be edited further or withdrawn. If it isn't approved, the reviewer's notes appear under the listing and the approved page stays.
6. Sales: orders, gross, Etude's 20% fee, and the creator's share before Stripe's processing fee.

The same flow is in the CLI: `etude account sell`, `list-deck`, `submit`, `update-listing`, `edit-listing`, `withdraw-changes`, `listings`, `sales`.

## Review (admins)

Admins are the account ids in the server's `ETUDE_CLOUD_ADMINS`. Everything waits for review: new decks, new pack versions, and every change to the page of a deck that has been on sale. Signed in as an admin, Market → Selling lists the queue and opens each item on the server's review screen (`/account/admin/review`), which shows the approved and proposed page side by side (covers included), the pack diff with the card-type code that changed, and automatic flags (links, e-mail addresses, card code that reaches the network or the host page, unusual media). Approve sends the exact hashes shown, so a change made during the review can't slip through; reject needs notes, which the creator sees. The queue is also `etude account review`; the HTTP routes are `GET /v1/admin/review[/:id]`, `POST /v1/admin/listings/:id/{approve,reject,hide}` and `POST /v1/admin/revisions/:id/{approve,reject}`.
