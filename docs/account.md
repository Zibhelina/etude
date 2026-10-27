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
- Etude Sync: plan, renewal or end date, storage used of 1 GB. "Subscribe on etude.study" and "Manage subscription" open the website (Polar checkout and portal).

Signing in to the account also signs Sync in when Sync uses the same server, so Sync only needs the vault password afterwards.

## Store rules

`web/src/lib/platform.ts` reads `window.Capacitor` (no import): `isNativeApp()`, `nativePlatform()`, `isIOSApp()`, `canShowPurchases()`.

- Desktop app and browsers: prices, "Buy on etude.study", "Subscribe on etude.study", "Manage subscription", and the Selling tab.
- iOS and Android apps: the apps sell nothing. Paid decks appear only when owned, under "Your decks", with no price, no buy button and no link to buy. The Sync block shows plan and storage with no price and no subscribe or manage buttons. The Selling tab is hidden.

## Market

The Market has three tabs. Browse shows paid listings from `GET /v1/market/paid-index.json` above the free GitHub catalog. Library lists purchased decks (`GET /v1/library`); Install fetches `/v1/listings/:id/pack` and imports it with the normal pack import, so updates keep scheduling. When a new version is approved the button reads Update.

## Selling

In Market → Selling (desktop and web only):

1. Set up payouts: creates the Stripe Express account and opens Stripe's onboarding. The status updates from Stripe's `account.updated` webhook.
2. List a deck: pick a deck from this collection, a description, a price (US$5 minimum), and a cover. The app exports the deck as a pack and uploads it as version 1.0.0.
3. Submit for review. The listing shows Draft, In review, Live, Rejected (with the reviewer's notes) or Hidden.
4. New version: re-exports the deck with a changelog. Buyers get it after review.
5. Sales: orders, gross, Etude's 20% fee, net.

The same flow is in the CLI: `etude account sell`, `list-deck`, `submit`, `update-listing`, `listings`, `sales`.

## Review (admins)

Admins are the account ids in the server's `ETUDE_CLOUD_ADMINS`. Signed in as an admin, Market → Selling shows a Review queue with Approve and Reject (reject needs a reason). The same queue is `etude account review`, `etude account approve <listing>` and `etude account reject <listing> --notes ...`, or the HTTP routes `GET /v1/admin/review` and `POST /v1/admin/listings/:id/{approve,reject,hide}`.
