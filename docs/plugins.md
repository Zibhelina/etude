# Plugins

Plugins extend Etude on **desktop and web** (mobile apps stay plugin-free). Every plugin runs inside a sandboxed iframe (`sandbox="allow-scripts"`, opaque origin) with a strict Content-Security-Policy and explicit, revocable permissions.

## Package layout

A plugin is a folder containing `plugin.json` plus its `.js` and `.html` files (no build step required):

```text
pomodoro/
  plugin.json
  main.js
  timer.html
```

Example `plugin.json`:

```json
{
  "etude": "plugin/1",
  "id": "pomodoro",
  "name": "Pomodoro",
  "version": "1.0.0",
  "author": "Etude",
  "description": "Floating focus and break timer with fold-to-pill, chime, and shortcuts.",
  "main": "main.js",
  "views": {
    "timer": "timer.html"
  },
  "permissions": ["ui.commands", "ui.floating", "storage", "notify"],
  "platforms": ["desktop", "web"]
}
```

## Permissions

Every call over the plugin bridge is checked against the permissions the user has **granted**, not just what the manifest declares:

- `ui.commands`: register entries in Ctrl/⌘K and the right-click menu.
- `ui.floating`: open, resize, and message a floating panel over Etude.
- `ui.sidebar` / `ui.tab` / `ui.block`: UI surfaces for plugins.
- `storage`: private key/value store and append-only event log in the collection (`plugin_kv`, `plugin_events`), isolated per plugin ID.
- `notify`: show toast notifications and play a gentle chime.
- `read.decks` / `read.cards` / `read.reviews` / `read.notes`: read collection data (never private answers during active study).
- `write.cards` / `write.notes`: create or edit cards or notes.
- `events.review`: receive an event after a card is rated.
- `net:<host>`: allow `connect-src https://<host>` in the iframe's CSP. Without it, `connect-src` is `'none'`.

Plugins can never access AI API keys, Ask Etude agents, local disk folders, Sync credentials, or another plugin's storage.

When a plugin update requests additional permissions, Etude pauses it (`enabled = false`) until you review and approve the new permissions in **Settings -> Plugins** or with `etude plugin permissions`.

## CLI workflow

```bash
etude plugin new my-plugin ./my-plugin
etude plugin check ./my-plugin
etude plugin install ./my-plugin --enable
etude plugin list
etude plugin permissions my-plugin --grant ui.commands,storage
etude plugin disable my-plugin
etude plugin uninstall my-plugin --yes
```

Ask Etude and MCP cannot install, enable, disable, change permissions on, or uninstall plugins.

## Publishing to the Etude Market

Plugins in the official Market are free. Pull requests to `Zibhelina/etude-market` under `entries/plugins/<id>.json` run automated static checks (manifest validation, SHA-256 hash verification, and rejection of remote code loading) and require manual review and approval from both project maintainers before merging.
