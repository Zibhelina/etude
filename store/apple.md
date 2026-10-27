# App Store Connect answers

Checked against Apple's pages on 27 Oct 2026: screenshot specifications, app privacy details, age ratings values and definitions, export compliance overview. The mobile-app worker's `store/ios/README.md` (in branch `mobile-app`) has the Xcode, signing and upload steps; this file is what you type into App Store Connect.

## New App

| Field | Answer |
|---|---|
| Platform | iOS |
| Name | Etude: Practice Anything |
| Primary language | English (U.S.) |
| Bundle ID | study.etude.app |
| SKU | etude-ios |
| User access | Full access |

## App Information

| Field | Answer |
|---|---|
| Subtitle | see `listing.md` |
| Category | Primary Education, secondary Productivity |
| Content rights | "No, it does not contain, show, or access third-party content." See the note below. |
| Age rating | see "Age rating" below |
| Privacy policy URL | https://etude.study/privacy |
| License agreement | Apple's standard EULA (the Terms at https://etude.study/terms cover the optional account) |

**Content rights.** Apple asks whether the app contains, shows or accesses third-party content. The Market shows decks from a public GitHub catalogue that people publish under open licences, and the built-in decks are Etude's own. If you'd rather be cautious, answer "Yes" and confirm you have the rights: the Market's entries are published by their authors for free redistribution, and the country map (Natural Earth), periodic-table data (PubChem) and Morse table (ITU) are public domain or openly licensed.

## Pricing and Availability

- Price: Free (USD 0).
- Availability: all countries. **France:** Etude uses only standard encryption (see Export compliance). Apple's page says an app using industry-standard algorithms that aren't the operating system's own needs a French encryption declaration to be sold in France. Etude's crypto is WebKit's Web Crypto (the OS's own) plus Argon2id from a JavaScript library. If you want to avoid the question, leave France out of the first release, or ask your accountant or lawyer about the declaration.

## App Privacy (the nutrition label)

Apple counts data as "collected" when it leaves the device and is kept longer than it takes to answer the request. Answers that match the code (`~/dev/etude-cloud` and the app):

**Do you or your third-party partners collect data from this app?** Yes.

| Data type | Collected? | Linked to the user | Used for tracking | Purposes |
|---|---|---|---|---|
| Contact Info → Email Address | Yes, only when someone creates the optional account | Yes | No | App Functionality |
| User Content → Other User Content | No (see note) | | | |
| Identifiers → User ID | Yes (the account id the server keeps with the email) | Yes | No | App Functionality |
| Diagnostics, Usage Data, Location, Contacts, Health, Financial, Browsing, Search, Purchases | No | | | |

Notes for each choice:

- **Email address.** Kept by the server to sign in (one-time links) and send account email. In-app sign-in is optional; the app works without it.
- **Other User Content: No.** Sync uploads the collection end-to-end encrypted. The server holds only ciphertext and the key never leaves the person's devices, so Etude can't read it. Apple's definition of collecting is about data you can access; encrypted data you can't open isn't collected in that sense. If you'd rather show it, add "Other User Content, linked, App Functionality" and nothing else changes.
- **AI grading.** When someone turns on AI grading, the card and their answer go from the device straight to OpenAI or OpenRouter under the person's own key. Etude never receives them. Apple's label covers data you or your partners collect; a provider the person picked and pays for is the person's own service, so it isn't declared. The Privacy Policy says it plainly.
- **Purchases: No.** The apps sell nothing. Subscriptions and paid decks are bought on the website.
- **Tracking: No.** No ads, no analytics, no third-party SDKs. The privacy manifest (`ios/App/App/PrivacyInfo.xcprivacy`) says the same: email address only, no tracking domains.
- **Security log IP addresses.** The server keeps the IP of sign-in and account events for 12 months to fight abuse. Apple's list has no IP type; it sits under App Functionality with the account. If App Review asks, point to the Privacy Policy section 3.

## Age rating questionnaire

All content descriptors: **None** (violence, sexual content or nudity, profanity, horror, alcohol/tobacco/drugs, mature or suggestive themes, simulated gambling, contests).

| Question | Answer | Why |
|---|---|---|
| Medical or treatment information | None | Recheck this answer if a medical deck is added to the free Market before submission. |
| Unrestricted web access | No | Card types run in a sandboxed frame with no network access. Links in decks open in the system browser. |
| User-generated content | No | The Market is a curated catalogue reviewed before it's published; users don't post to each other in the app. |
| Messaging and chat | No | |
| Social media | No | |
| Advertising | No | |
| Parental controls / age assurance | No | |
| Gambling, loot boxes | No | |

Expected result: 4+. The Terms set 13+ for the online account; you can choose "set a higher age rating" if you want the store to show 13+, which isn't needed for the app itself.

## App Review Information

- Sign-in required: **No**. Leave the demo account empty, or add the one below if you want them to see Sync.
- Contact: your name, phone, hello@etude.study.
- Notes (paste):

```
Etude is a free spaced-repetition (flashcard) app. Everything works without an account: open the app, tap More → Market → Decks, install "Countries of the World" or "Periodic table", then tap Practice.

No in-app purchases, no ads, no external purchase links. The app sells nothing. An optional Etude account (email sign-in) keeps a collection in step across devices with end-to-end encryption; it can be created and deleted inside the app (Settings → Account → Delete account), as guideline 5.1.1(v) requires.

Card types (guideline 4.7): some cards are small interactive HTML5/JavaScript programs, such as a map you tap or a Morse key. They run inside a sandboxed iframe (sandbox="allow-scripts", opaque origin) under a Content-Security-Policy that blocks all network access except Etude's own bundled files. They can't reach the network, the device or the app's data, and they don't download native code. They come from the built-in decks or from the Market, a public catalogue of free decks that we review before publishing (https://github.com/Zibhelina/etude-market).

AI grading is off by default. A person can turn it on with their own OpenAI or OpenRouter API key; answers then go from the device straight to that provider. Etude's servers never see them.

Support: https://etude.study/support · hello@etude.study
```

**Demo account plan.** Review doesn't need one, because nothing is behind a sign-in. If you want reviewers to try the account anyway: create review@etude.study as a free Porkbun forward to your Gmail. Sign-in is a one-time link (valid 15 minutes) whose code can also be pasted into the app, so in the notes write "Optional account: enter review@etude.study in Settings → Account and ask us through App Review messages; we'll reply with the sign-in code within the hour." Watch the inbox while the app is in review. etude-cloud has no admin command to grant Sync without a payment yet, so Sync itself can't be shown on that account unless you add one or pay for one month with your own card. Delete the account after approval.

## Export compliance

`ITSAppUsesNonExemptEncryption` is NO in `Info.plist`, so App Store Connect shouldn't ask. If it does:

- Does your app use encryption? **Yes**.
- Does it qualify for any exemptions in Category 5, Part 2? **Yes**: it uses only standard, published algorithms (HTTPS through the OS, AES-256-GCM and HKDF from the OS's Web Crypto, Argon2id), and encryption isn't its main function.
- Proprietary or non-standard algorithms? **No**.
- Documentation: none for the US. France: see Pricing and Availability.

## Screenshots

Upload from `store/screenshots/`, in the numbered order:

| Slot | Folder | Size |
|---|---|---|
| iPhone 6.9" display | `iphone-6.9/` | 1320 × 2868 |
| iPhone 6.5" display (only if 6.9" isn't given; Apple scales 6.9") | `iphone-6.5/` | 1284 × 2778 |
| iPad 13" display (required: the app supports iPad) | `ipad-13/` | 2064 × 2752 |

PNG, RGB, no alpha.
