# Play Console answers

Checked against Google's help pages on 27 Oct 2026: preview assets, Data safety. The mobile-app worker's `store/android/README.md` (in branch `mobile-app`) has the signing, upload and closed-test steps; this file is what you type into Play Console.

## Create app

| Field | Answer |
|---|---|
| App name | Etude: Practice Anything |
| Default language | English (United States) |
| App or game | App |
| Free or paid | Free |
| Declarations | Developer Program Policies, US export laws: tick both |

## Main store listing

| Field | Where the text is |
|---|---|
| App name | `listing.md`, Shared |
| Short description | `listing.md`, Play: short description |
| Full description | `listing.md`, Description |
| App icon (512 × 512, 32-bit PNG) | `graphics/play-icon-512.png` |
| Feature graphic (1024 × 500, no alpha) | `graphics/play-feature-1024x500.png` |
| Phone screenshots (2 to 8) | `screenshots/android-phone/` (1080 × 1920, 6 images) |
| 7-inch tablet screenshots | `screenshots/android-7in/` (1200 × 1920) |
| 10-inch tablet screenshots | `screenshots/android-10in/` (1600 × 2560) |
| Video | leave empty (or the YouTube promo) |

## Store settings

- Category: **Education**. Tags: Flashcards, Study, Education, Language learning, Productivity (pick what Play offers).
- Email: hello@etude.study. Website: https://etude.study. Phone: optional, leave empty.
- External marketing: on.

## App content

| Section | Answer |
|---|---|
| Privacy policy | https://etude.study/privacy |
| App access | **All or some functionality is restricted**: the optional account. Instructions: "Everything except the optional account works without signing in. To test the account, enter any email address you can read in Settings → Account; a sign-in link arrives by email." No credentials needed. |
| Ads | **No**, the app has no ads |
| Content rating | see below |
| Target audience | **13–15, 16–17, 18 and over**. Not designed for children, so the Families policy doesn't apply. |
| Data safety | see below |
| Government app | No |
| Financial features | My app doesn't provide any financial features |
| Health | My app doesn't have any health features |
| News app | No |
| Advertising ID | No, the app doesn't use the advertising ID |
| Account deletion | URL: https://etude.study/support#delete. Deletion is also inside the app: Settings → Account → Delete account |

## Content rating (IARC questionnaire)

- Email: hello@etude.study. Category: **Reference, News, or Educational**.
- Violence, fear, sexuality, language, controlled substances, crude humour: **No** to all.
- Gambling or simulated gambling: **No**.
- Do users interact or exchange content with each other? **No** (no chat, no posting; the Market is a reviewed catalogue).
- Does the app share the user's current physical location with others? **No**.
- Does the app allow users to purchase digital goods? **No**. Nothing is sold in the app.
- Unrestricted internet access (a web browser)? **No**.

Expected result: Everyone / PEGI 3 / USK 0.

## Data safety

Google counts data as "collected" when the app sends it off the device. Exempt: data that stays on the device, data that's end-to-end encrypted, and data processed only ephemerally. Transfers a person starts themselves to a provider they chose aren't "sharing".

**Does your app collect or share any of the required user data types?** Yes.
**Is all of the user data collected by your app encrypted in transit?** Yes (HTTPS only).
**Do you provide a way for users to request that their data is deleted?** Yes (in the app, on the website and by email).

| Data type | Collected | Shared | Optional? | Ephemeral? | Purposes |
|---|---|---|---|---|---|
| Personal info → Email address | Yes | No | Optional (only with the account) | No | App functionality, Account management |
| Personal info → User IDs | Yes (account id) | No | Optional | No | App functionality, Account management |
| App activity → Other user-generated content | Yes, see note | No | Optional (only with AI grading turned on) | No | App functionality |

Everything else (location, contacts, financial info, health, messages, photos and videos, audio, files and docs, calendar, web browsing, app activity other than above, app info and performance, device or other IDs): **Not collected**.

Notes:

- **Sync is exempt.** The collection is end-to-end encrypted on the device and only the person's devices hold the key, which is exactly Google's exemption. Don't declare it.
- **AI grading.** When someone turns it on, the card and their answer leave the device for OpenAI or OpenRouter under their own key. Etude's servers never see them, and it isn't "sharing" because the person set it up and expects it. Google's definition of collection is "sent off the device", with no exception for a provider the user picked, so the safe answer is to declare it as collected, optional, for app functionality. If Google's reviewer disagrees, remove it.
- **Security log IP addresses** (12 months, abuse prevention) count with the account under App functionality; Play has no separate IP row.
- **Market and update checks** fetch public files from GitHub. Nothing personal is sent, so nothing to declare.

## Testing and release

New personal developer accounts need a closed test with at least 12 opted-in testers for 14 days in a row before applying for production. Upload `app-release.aab` (signed with your upload key) to a closed testing track, add the testers' Google account emails, roll out, and keep it running. After production access, copy the **app signing** SHA-256 from Test and release → App integrity into `site/src/.well-known/assetlinks.json` in place of `SHA256_FINGERPRINT`, and publish the site.
