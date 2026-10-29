# Etude Sync

Sync keeps a local collection on every device. Work offline, then exchange encrypted events through a shared folder or etude-cloud. The CLI reference lists the `sync` commands. Settings → Sync uses the same core and API in Node and the browser worker.

## Local log and identities

Setup installs SQLite triggers in the collection. Triggers capture inserts, updates and deletes inside the engine transaction, and advance a persisted hybrid logical clock using the SQLite wall clock, a counter and a random device id. A clock rollback increments the counter. Receiving a remote event advances the clock before the next edit. Rolled-back writes leave no events. Sync drains raw changes into field registers and an append-only event log.

Decks, attempts and reviews have stable random identities alongside their local integer handles. Cards receive an identity from their initial item and face, which stays stable when a face is renamed. Item ids, preset ids, type ids and scheduler ids remain their existing stable ids. Integer handles remain local and are translated at the boundary.

Registers compare wall time, logical counter and device id. JSON object leaves merge independently; arrays merge as one field. Item tag membership merges per tag. Entity deletes create permanent tombstones. Reusing a deleted identity is unsupported; use a fresh identity for new content. Two independently created decks with the same name remain separate; the later sorted identity receives a short suffix in the relational view.

Remote application updates the registers and rebuilds the relational view inside one transaction with capture muted. Foreign-key checks run before commit. Derived titles, search text and item_tags are rebuilt. No remote event is emitted again. The folder transport re-reads immutable per-device event files, so delayed files remain discoverable. Cloud transport persists the server cursor after durable receipt, pushes in batches and retries the same event id and ciphertext.

## Scope

Synced content: presets; deck names, descriptions, instructions, archive state, order and configuration; items and their individual JSON fields, tags, source, notes, dates, order and archive state; customized card types and schedulers; type folders and placements; tag metadata; attempts and graded answers; reviews; card suspension, burial and explicit reset/due controls; media and type assets. Shipped defaults are supplied by the app; custom edits and resets of edited definitions are logged.

Synced settings are dayStartHour, learnAheadMinutes, selected theme and custom themes. All AI configuration stays local, including provider URLs, model selection, language, env-key names and agent effort. Device-local content also includes ChatGPT credentials and host ids, API keys, update state, window/sidebar state, Market installation receipts, Ask Etude conversations, attachments and snapshots, server authentication options, Sync tokens, vault keys and cursors. The market catalog address remains local.

Reviews and attempts have independent identities, so simultaneous offline answers both survive. Removing an item hides its orphan history from the relational view; the event log retains it. Explicit review undo records a retraction tombstone. Snapshot-based Ask Etude undo is refused in synced collections because a whole-database restore would overwrite sync identity and causality. Ask Etude can inspect status and request sync; credential-entry commands remain outside its tool access.

## Scheduling

Each merge replays live reviews in timestamp order with stable review identity as a tie-break. FSRS replay disables fuzz and evaluates deadline caps at each recorded review time. Drill, Leitner and user scripts replay with the canonical preceding history, including tied timestamps. Sync replay uses UTC study days and the synced day-start hour so machines in different time zones converge. Script Date.now(), argument-free new Date() and Math.random() are deterministic. The script receives the review's clock and a seeded random stream. Reset controls preserve history and start a fresh scheduling state; due overrides remain until a later review.

A script that throws or exceeds the sandbox budget aborts the projection transaction and surfaces its error. Received events remain durable for retry after the script is repaired. There is no fallback to a guessed scheduling state. Historical scheduling changes and resets made before the first setup have no separate event timeline; first merge replays the available review history using the current merged scheduler and configuration.

## Encryption and secrets

The client implements etude-cloud's version-1 scheme: a random 256-bit vault key; Argon2id with 64 MiB, three passes and one lane for the Sync password; AES-256-GCM wraps; a checksummed 240-bit recovery key; HKDF-derived event and blob subkeys. Event authentication binds the event id. Blobs are named by the SHA-256 of their ciphertext. A synced plaintext-hash → ciphertext-name map lets later devices reuse existing uploads. Plaintext hashes and filenames travel inside encrypted events.

Account sign-in uses email start → code → verify → revocable device token. Reading the key envelope requires that token. Unlocking requires the separate Sync password or recovery key. The first unlock creates the envelope with a conditional initial PUT; cloud envelope updates support If-Match through the transport. The UI shows the generated recovery key once and asks for an explicit saved-key confirmation. Passwords stay in memory for the request. Neither passwords nor recovery keys are saved.

Desktop tokens and the unwrapped vault key live in a collection-device-specific JSON file under `$ETUDE_HOME/sync/`, beside the existing credentials area, with directory mode 700 and file mode 600. The browser uses the worker's credential filesystem mirrored into OPFS. Both depend on the security of the local device and application origin. The local collection and caches contain plaintext. An account takeover alone cannot open the cloud data. Malicious same-origin code, a compromised app build, local OS access or browser-profile access can obtain the saved key. Browser eviction can remove the local copy; the app requests persistent storage. Transport metadata still reveals sizes, event counts and timing.

## Running

A shared folder needs no account. Choose the folder on each desktop, create a Sync password on the first device and unlock the others. The directory contains keys.json, per-device encrypted event files and encrypted blobs. Sync software can copy those files between computers. Browser builds use cloud transport.

For cloud, configure the server URL, sign in by email, paste the code, then create or unlock the vault. HTTPS is required outside localhost. Browser clients need their exact origin in the server's `ETUDE_CLOUD_ORIGINS`, including the port for local tests. Server CORS exposes ETag for the wrapped-key protocol. Quota and entitlement errors are shown using the server message.

A sync runs in steps: download (events, then media blobs this device lacks), check (hash the local media), upload (new media, then events) and apply (rebuild the relational view). `sync status` reports the step while a sync runs as `progress`: bytes done, the total when known and the transfer rate; the check step counts files. The upload total is exact. The download total is the server's vault size on a device's first sync and unknown afterwards. Blob downloads and uploads run eight at a time, and each downloaded media file is written as soon as its blob arrives. Each device records the version of every media file it last had in step with the registers (`sync_media_seen`): a local file that still matches it takes a newer version from another device, and one that doesn't is uploaded as this device's edit. Media paths are refused only for control characters, backslashes, empty, `.` or `..` segments, or resolving outside the media folder, and such entries are skipped.

The open UI syncs on startup, after a review session ends or is left, and every three minutes outside the active study view. Network failures during automatic sync stay quiet. Manual sync shows failures. Sync stays optional and local study continues offline. A large projection currently rebuilds the relational tables synchronously; incremental projection remains a performance improvement.

## Verification

`npm test` and `npm run test:wasm` each run the seeded folder property test. It simulates three collections, 240 random offline operations, FSRS/drill/Leitner/a custom seeded scheduler, reviews on cards later deleted, tombstones, field merges, media, assets and shuffled sync interleavings. A second property test uses a real cloud instance when ETUDE_SYNC_TEST_SERVER and ETUDE_SYNC_TEST_OUTBOX point to an isolated file-mail server. It uses synthetic example.test accounts. Run both suites to exercise both SQLite drivers.

The integration test credentials and servers must be disposable. Never point these variables at an account that sends real email. The report for this implementation records the real collection-copy/Chromium acceptance run and screenshot paths.

## Remaining work

Account deletion and device management need app surfaces. Passkey login and PRF unlock, password-change/reset UI, transport switching and vault migration remain open. Folder setup has desktop paths; no mobile folder-picker bridge exists. Folder log scanning is linear in history. Event compaction, snapshot checkpoints, garbage collection of unused ciphertext blobs, multiple simultaneous browser tabs and a full external crypto review remain open. Docker self-host acceptance and physical-phone acceptance are separate checks.
