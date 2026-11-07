# Sync snapshots and event packs

Snapshots are implemented for etude-cloud; [sync.md](sync.md#snapshots) describes them as they are. Snapshots through a shared folder, compaction and event packs are still a proposal. With incremental projection, a sync costs in proportion to what changed. Two costs still grow with history: a new device downloads, decrypts and merges every event ever written (60,000 events for 5,000 cards and 50,000 reviews, about 14 s), and the log only grows, because a new device needs all of it. This proposes encrypted snapshots of the registers, so a new device downloads one blob and then the tail of the log, and compressed event packs, so the log itself is smaller. The first prepares compaction of the log.

## Snapshots

A snapshot is the merged state: `sync_registers` and `sync_deleted` up to a server seq. It is made from the registers, not the relational view, so it holds exactly what merging the log gives. Event bodies, `sync_media_seen`, media bytes and `sync_replay` stay out: the first are history, the others are local or rebuilt.

As built, it differs from the first draft of this proposal in a few places. It is stored in parts of 50,000 registers instead of one blob, so a phone never holds the whole state (126 MB of JSON, 14 MB compressed, for a collection of 145,000 events and 770,000 registers) and a cut-off download goes on from the next part. Each part's AAD carries the snapshot's random id, its seq and the part's place, and the last part says it is the last. The pointer, `{v, id, seq, parts, size, device, created}` behind `GET`/`PUT /v1/vault/snapshot` with ETag and If-Match, lists the parts in order. Only the desktop and the CLI make snapshots, after a sync that left nothing to send, once the log has grown by 20,000 events since the last; the server deletes the old parts when the pointer moves.

A device with an empty log reads the pointer, downloads and merges each part in its own transaction with the same last-writer-wins comparison `apply` uses, advances its clock past the largest stamp, sets its cursor to the snapshot's seq, pulls the tail and runs the full projection once.

This is safe because the registers form a state-based CRDT: each field keeps the value with the largest (wall, counter, device) stamp, and a tombstone keeps its largest stamp. Merging is commutative, associative and idempotent. An event the snapshot already includes changes nothing when it is applied again, and a snapshot merged over a log that already has some of its events changes nothing either. Tombstones stay in every snapshot, so a deleted identity stays deleted after the events that deleted it are gone.

Through a shared folder, `covers` would be the set of event ids per device, as ranges of (wall, counter), since files arrive in any order; a new device would take the snapshot in `snapshots/<device>.json` that covers the most. That isn't built.

## Compaction

Once a snapshot covers seq S, a device no longer needs the events up to S: a new one merges the snapshot, and one that was offline since before S merges it too, then pulls after S. The server may then delete those events. A cursor below the oldest kept seq gets `410 compacted` with the snapshot pointer, so the device knows to merge it. In a folder, a device would remove only its own event files covered by two snapshots older than 90 days, since sync programs can resurrect or delay files.

## Event packs

Each change is one wire event today: its own AES-GCM tag and nonce, base64 and JSON framing, a server row and, in a folder, a file. A pack carries the events of one push as one wire event: plaintext `{v: 2, events: [{id, event}, …]}`, gzip-compressed, then encrypted with the events subkey, with the pack id in the AAD. Its ciphertext starts with version byte 2, so it can't be taken for a version 1 event. The id is the last inner event's id with a `.p` suffix, which fits the server's id rules and file names. A pack stops at 512 KiB of plaintext and stays below the server's 1 MiB event limit after compression; JSON events compress five to ten times. A device keeps which inner events went into which pack, so a retry sends the same id and ciphertext and the server's deduplication still works. Receiving a pack records each inner event under its own id in `sync_events`, so duplicate detection and no-echo work as before.

## What changes in etude-cloud

The snapshot pointer is built: `GET`/`PUT /v1/vault/snapshot`, with ETag and If-Match, and its parts use `PUT`/`GET /v1/blobs`. Still proposed: compaction: a server job, or `DELETE /v1/sync/events?through=S`, allowed only when a snapshot covers S and every device of the vault reads version 2; `GET /v1/sync/events?after=` below the oldest kept seq answers `410 compacted` with the pointer. Packs need nothing new: a pack is an event of at most 1 MiB. Usage accounting already counts blobs and events. The server learns which version each device reads from a request header and keeps the vault's minimum.

## Older clients

Snapshots alone change nothing for them: the events stay, and an older client keeps pulling and applying them. Packs and compaction would break them. A version 1 client fails on a version 2 ciphertext ("not an Etude Sync ciphertext (or an unknown version)"), and after compaction one starting from an empty collection would build an incomplete collection without noticing. So both wait until every device of the vault reads version 2. Older clients refuse events for unknown tables, so a device can't announce itself with a new table; it writes a settings field that older clients store and ignore when projecting (`/value/syncProtocol/<device>`), since `safeSettings` drops unknown keys. Packs are written, and compaction allowed, only once every device that wrote an event in the last 90 days has announced version 2. A device that comes back later on an older version stops at the first pack with the error above and has to be updated; on the cloud, the server can refuse it earlier with a plain "update Etude" message, from the version header.

The rollout follows from that: first, clients that read snapshots and packs and announce themselves, but write neither; then snapshots; then packs, per vault, once every device has announced version 2; compaction last.
