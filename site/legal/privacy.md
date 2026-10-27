---
title: Privacy Policy
description: What the Etude app, the website and Etude's server collect, who processes it, how long it's kept and how to delete it.
last-updated: 2026-10-27
---

# Privacy Policy

Etude is run by João Henrique Costa Araujo, a sole proprietor in British Columbia, Canada ("Etude", "we"). He is the person responsible for your personal information. Contact: hello@etude.study.

The short version: the app works without an account and sends us nothing. If you use Sync, your collection is encrypted on your device and we can't read it. We keep the minimum needed to run accounts and payments, and we don't sell data, show ads or use analytics.

## 1. The app

The Etude app stores your collection (decks, cards, reviews, media, settings) on your own device. It has no analytics, crash reporting or advertising, and it never sends your collection to us. It contacts these outside services:

| When | The app contacts | What it sends |
|---|---|---|
| you open the Market or install a free deck | GitHub (raw.githubusercontent.com, api.github.com) | a normal web request for the catalogue and its files |
| the desktop app is open (at most every 10 minutes), and when you install an update | GitHub (api.github.com, github.com) | a normal web request to check for a newer version |
| you turn on AI grading and answer an AI-graded card, ask for feedback, use Edit for me, or use Ask Etude | the AI provider you set up (see below) | the card, your answer (including drawings and images), your message, any file you attach, and the parts of your collection Ask Etude reads to do what you asked |
| you sign in to ChatGPT for AI features, and every few minutes while you're signed in | OpenAI | OpenAI's own sign-in, then a request for the list of models your plan offers; the sign-in token stays on your device |
| you use an account, Sync or the paid Market | our server (sync.etude.study) | see sections 3 to 5 |

**AI providers.** AI features are off until you add a key or sign in. You choose the provider: OpenRouter, OpenAI (through an API key or your ChatGPT sign-in), or any compatible server, including one on your own computer. OpenRouter passes each request on to the company that runs the model you picked. Out of the box those are `liquid/d1-ultra` for quick grading decisions and `deepseek/deepseek-v4.1-flash-1017` for written feedback, and you can change both in Settings. Content you send to an AI provider goes straight from your device to that provider, under your own account with it. Etude never receives it. That provider's privacy policy applies.

**Card types.** Card types, including ones from the Market, run in a sandbox that can't reach the internet. They can only load files from Etude itself.

## 2. The website

etude.study is a static site hosted on GitHub Pages. It sets no cookies and runs no analytics. GitHub receives your IP address and browser details when you load it, as any web host does. While you read it, your browser also asks GitHub's API for the project's star count and loads the Market catalogue from GitHub ([GitHub's privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement)). Links to YouTube and Ko-fi take you to those sites; the website doesn't embed them.

## 3. Accounts and Sync: what we collect

An account is optional. You need one only for Sync and the paid Market.

| Data | Why | How long |
|---|---|---|
| Your email address | to sign you in (sign-in links) and send service email | while your account exists |
| Display name (optional) | shown to buyers if you're a creator | while your account exists |
| Devices: the name you give each one, how it signed in, when it was added, last used and last signed in | so you can see and revoke them | until you delete the account |
| Passkey public keys | to verify passkey sign-ins (we never get the private key) | until you remove the passkey or delete the account |
| Sign-in requests: your email address, IP address and time, with the link itself stored only as a hash | to make each link work once and limit abuse | deleted a day after the link expires (links last 15 minutes) |
| Email change requests: old and new address, IP address and time, with the link stored only as a hash | to confirm the new address | deleted a day after the link expires |
| A security log of sign-ins and account events: account id, IP address, time, and for sign-in attempts a hash of the email address | to detect abuse and investigate incidents | 12 months, also after you delete your account |
| **Your encrypted collection** (encrypted changes, encrypted media and your wrapped keys), with its size, upload times and which of your devices uploaded each change | to sync your devices | see section 5 |
| Subscription status from Polar (active, renewal or end date, Polar customer id) | to turn Sync on and off | while your account exists |
| Paid Market orders: deck, price, fee, tax, billing country, Stripe payment ids | to deliver purchases, handle refunds and meet tax law | 6 years after the sale, as Canadian tax law requires |
| Creators: Stripe connected-account id, country, payout status | to pay you | while you sell, then 6 years for tax |
| Emails you send to hello@etude.study | to answer you | as long as needed to help you |

**What we can't see.** Sync encrypts your collection on your device with a key that only your devices hold. That key is protected by your Sync password, your recovery key or your passkey, and we never receive any of them. The server stores only ciphertext. We cannot read your decks, cards, answers, reviews, media or deck names, and we can't hand them to anyone, including in response to a legal demand. What the server can see is how much you store, how many changes you upload and when.

**Payments.** Card details go to Polar (Sync) or Stripe (paid Market) directly. We never see or store your card number. Polar is the merchant of record for Sync, so it also processes your name, address and payment data as an independent controller under [its own privacy policy](https://polar.sh/legal/privacy).

## 4. Who processes data for us

| Provider | What it does | Where |
|---|---|---|
| DigitalOcean | hosts the server, database and encrypted storage, and its backups | Toronto, Canada |
| Resend | sends sign-in and account email (your address and the message) | United States |
| Porkbun and Google | Porkbun forwards mail sent to hello@etude.study to a Gmail inbox, where it's read and stored | United States |
| Polar | sells and bills Sync subscriptions (merchant of record) | United States |
| Stripe | processes paid Market payments and creator payouts | United States and Canada |
| GitHub | hosts the website, the free Market and app downloads | United States |

Some of these are outside Canada, so your information may be processed under the laws of other countries. Each provider is bound by its contract with us to protect it and use it only to provide its service.

We don't sell or rent personal information, and we don't share it for advertising. We disclose it only to the providers above, when the law requires it, or to protect users and the service from fraud or abuse.

## 5. Deleting your data

- **Delete your account** in the app (Settings → Account → Delete account), on your account page at sync.etude.study/account, or by writing to hello@etude.study from the address on the account. In the app and on the web you need to have signed in within the last 10 minutes. Deleting immediately removes your email address, display name, devices, passkeys, pending sign-in and email-change links, your subscription link and your entire encrypted collection from the server. Paid Market orders are kept for tax purposes, detached from you, with only a hash of your email address so a tax or refund question can be matched to the order. A creator's listings are hidden. The security log keeps its rows until their 12 months are up.
- **When Sync ends** (you cancel or a payment lapses), we keep your encrypted data for 90 days so you can come back, then delete it.
- **Backups** of the server are kept for at most 30 days, so deleted data is gone from them within 30 days.
- Deleting your account doesn't touch the collection on your devices. To remove that, uninstall the app, or on a computer delete the `.etude` folder in your home folder.

## 6. Your rights

You can ask us to access, correct, export or delete your personal information, or ask questions about how we handle it, by writing to hello@etude.study. We answer within 30 days. Once you're signed in you can also do most of it yourself: change your email or display name, see and revoke devices, download a copy of your account data, and delete your account. Your collection lives on your devices, and you can export any deck as a pack at any time.

If you're in Canada, you can also complain to the Office of the Privacy Commissioner of Canada or, in British Columbia, the Office of the Information and Privacy Commissioner for BC. If you're in the EU or UK, the legal bases we rely on are performing our contract with you (accounts, Sync, purchases), legal obligation (tax records) and legitimate interest (security logs), and you can complain to your local data protection authority.

## 7. Security

Sync data is end-to-end encrypted. Sign-in links and device tokens are stored only as hashes, and a device's sign-in expires after 90 days without use. Connections to our server use HTTPS. Access to the server is limited to Etude's operator. If a breach puts your information at real risk, we'll tell you and the authorities the law requires us to tell.

## 8. Children

The services are for people 13 and older. We don't knowingly collect information from younger children; if you believe a child under 13 has an account, write to us and we'll delete it.

## 9. Changes

If we change this policy in a way that matters, we'll email account holders before it takes effect and update the date above.
