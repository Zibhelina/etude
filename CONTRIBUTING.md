# Contributing

Thanks for wanting to improve Etude. Bug reports, card types, docs fixes and pull requests are all welcome.

## Setup

You need Node 24 or newer (Node runs the TypeScript sources directly, no build step for the server).

```sh
git clone https://github.com/Zibhelina/etude.git
cd etude
npm install
npm run build        # builds the web app into web/dist
npm run dev          # API on :4610, restarts on changes
npm run dev:web      # Vite on :4611 with hot reload, proxies the API
```

Use a scratch collection while developing so you never touch your real one:

```sh
ETUDE_HOME=$(mktemp -d) node src/cli/main.ts import examples/showcase.pack.json
```

## Before opening a pull request

```sh
npm test
npm run typecheck
npm run build
```

CI runs the same three commands.

## Conventions

[`AGENTS.md`](AGENTS.md) describes the layout and the rules in detail. The short version:

- New operations go in the engine (`src/core/engine.ts`) and are exposed by both the HTTP server and the CLI. Anything the UI can do needs a CLI command.
- After changing any CLI command, regenerate the reference with `node scripts/gen-cli-docs.ts`. A test fails when `docs/cli.md` is stale.
- CLI output is JSON with stable keys.
- Keep dependencies light: prefer the Node standard library.
- Card frames and user scripts stay sandboxed. Don't give them more access.
- Tests use temporary databases, never a real collection.
- Markdown paragraphs are one line each.

## Card types and packs

New card types can live in a pack instead of the core. See [`docs/types.md`](docs/types.md) and [`docs/packs.md`](docs/packs.md), and check a pack with `node scripts/check-pack.ts my.pack.json`.
