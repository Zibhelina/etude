# Sharing notes

Share a Notebook folder or page with other people by email, like a shared Google Docs folder. Everything under it stays in step on every member's devices, and the server only ever stores ciphertext.

## Using it

- **Share**: right-click a folder or page in Notes → Share… (or the Share button at the top of a page). Type an email and pick **Can edit** or **Can view**. Sharing needs Etude Sync on your account; the people you invite don't need it, only a free Etude account.
- **Invites** show at the top of the Notes sidebar once the invited person signs in with that email. Accept puts the shared folder in their Notes (at the top, or inside a folder they pick).
- **Editing**: owners and editors change anything inside: pages, canvases, files, PDFs, pictures, new pages and subfolders. Changes go up within a few seconds and an open page takes others' edits live. When two people edit the same note at once, their changes are merged block by block; when both changed the same block, both versions are kept, one after the other, so nothing is lost.
- **View only**: a viewer's copy can't be changed, from the app, the CLI or an agent (`etude mcp`). They see "View only" on it.
- **People**: the owner changes roles and removes people. Editors can invite. Removing someone replaces the folder's key, so they can't read anything written after that. What they already had stays on their devices as a read-only copy.
- **Leave** (members) or **Stop sharing** (owner): the notes stay on your device as your own; nothing is deleted.
- **Together**: like Google Docs, you see the others while they're there. On a page, each person's cursor is a thin line in their color with their name above it (it shrinks to a dot after a few seconds of stillness) and their selection a light band. The top bar shows who's in the folder right now (a ring for the ones on this page), the sidebar a dot on the pages others have open, and a page someone else changed last says "Edited by Victor · 3 min ago". While someone is on the page you have open, that folder syncs every second instead of every three. The Share dialog says who's online and where, when the others were last active and how many edits they made, with a 14-day strip under Activity.
- What isn't shared: pins, the "Jump back in" list and where you put the shared folder in your own tree.

No keys or passwords to keep: signing in to your Etude account is all it takes, on every device, with or without Sync. A device you sign in on later gets your shared folders by itself; until another device of the share has passed it the key (seconds, when one is open), the folder says "Getting the key from another device…".

## CLI

```
etude share create 'Algorithms'
etude share invite 'Algorithms' alex@example.com --role view
etude share list                       # spaces and invites
etude share accept spc_…  [--parent Courses]
etude share members 'Algorithms'
etude share role 'Algorithms' alex@example.com edit
etude share remove 'Algorithms' alex@example.com
etude share leave 'Algorithms'   ·   etude share stop 'Algorithms'
etude share sync
etude share who ['Algorithms/Week 1' | spc_…]   # who's online and on which page
etude share activity 'Algorithms'                 # last seen, edits per person, 14 days
```

Everything answers JSON. `etude serve` (the desktop app's engine) keeps shared notes in step every few seconds while it runs; the CLI and agents sync with `share sync`.

## How it works

A shared folder is a **space** on the Etude server: an append-only log of encrypted events, encrypted media blobs, and the list of members with their roles. The server checks who may read and write (removed members can't pull, viewers can't push), and reads nothing else.

**Keys.** Every signed-in device makes its own ECDH P-256 keypair the first time sharing runs there, and sends the server only the public key. The private key never leaves the device: it's kept, with the space keys the device uses, in `$ETUDE_HOME/share/<account id>.json` (mode 600), tied to the server and device id, so signing out and in again makes a new device with a new keypair. This is how Signal and WhatsApp groups work, and it's end-to-end for everyone, with no Sync password and nothing secret on the server.

Each space has a random 256-bit key per **epoch**. It's wrapped for each member **device** with ECIES: an ephemeral P-256 key, ECDH with the device's public key, HKDF with info `etude-space-key-v2:<space>:<epoch>:<device>`, AES-256-GCM with the same string as AAD. Access is per account, keys per device: any device that holds the current key wraps it for member devices that lack it on its next pass (owners and editors for anyone, viewers for their own other devices). So a new phone gets the key from its owner's laptop, or from the person who shared. Removing someone makes the owner's device rotate to a new epoch, wrapped for every device of the people still in; signing a device out deletes its public key and wraps on the server.

The server picks a space's id, and keys and meta are bound to it, so a new space starts at a placeholder epoch 1 and its creator rotates it to epoch 2 straight away; nothing is ever written or read under epoch 1.

**Content.** The space key gives the same subkeys as Sync's vault key: events are AES-256-GCM with their id in the AAD, media blobs are AES-256-GCM addressed by the SHA-256 of the ciphertext. The space's name and root note are encrypted too, so the server never sees folder or page names. An event is one note's whole state (kind, parent, title, icon, look, position, archived, body) with the hash of the state it was edited from; a media file is uploaded once per space, and a receiving device checks it against its name (the SHA-256 of its plaintext).

**Merging.** Each device remembers, per note, the last state both sides agreed on. A note nobody edited here takes the remote state. One edited on both sides is merged against their common state: pages block by block (both kept when the same block changed), other fields take the side that changed (the later one when both did), in the order the server logged them, so every device reaches the same result. A delete loses to an edit made at the same time, and a note whose parent hasn't arrived waits under the shared folder's root.

**Presence.** While a shared note is open, the app tells the local server (`POST /api/share/presence {note, sel, block, typing}`) and it sends `PUT /v1/spaces/:id/presence` when that changes, at most every 300 ms, plus every 15 s while it stays open; closing it (or opening something not shared) sends `DELETE`. The body is `{v: 1, note, kind, sel, block, typing, at}` encrypted with the space's current key and `presence:<space>:<device>` as AAD, so the server learns only that this device is in the space, never which page or where the cursor is. `sel` is `{anchor, head}` in a page (ProseMirror positions) or `{x, y}` on a canvas; `block` is the index path of the block holding the cursor, which places a caret in the right block when the two copies differ a little. The server keeps each entry 40 s in memory only; `GET /api/share/presence?note=` returns the others, decrypted, with a stable color per account (8 hues, none near your accent), the title of the page they're on and `here` for the ones on that very page. If the app stops saying anything for 40 s (a closed tab), presence goes by itself. `GET /api/share/:space/activity` gives the server's counts: last seen (presence or syncing), last edit, edits in 7 and 30 days and in all, and edits per person per UTC day for 14 days. An edit is one change sent, counted from metadata the server already had.

**Who changed what.** A device notes the author (the server's email for each event) and time of the last change it took for each note, and its own pushes as "you"; notes inside a space carry it as `share.lastEdit: {email, name, at, you?}`.

**Limits.** There's no key fingerprint check yet, so a malicious server could hand out its own public key for someone's device. A device opened for the first time can't read a share until another device of it is online once. Events are at most 1 MiB each (a page that large is refused with an error) and a space holds 1 GiB by default.
