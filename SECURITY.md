# Security

## Trust model

Etude is a self-hosted app. One server holds one collection, and whoever can reach the server's API can read and change that collection.

- **Card code is untrusted.** Card types are HTML, CSS and JavaScript, and packs can bring their own types. Each card renders in an `<iframe sandbox="allow-scripts">` without same-origin access, so card code can't read the app, its storage or the API. It talks to the app only through `postMessage`. Private fields (answers, reference solutions) are sent to the frame only after the answer is submitted.
- **User scripts run in QuickJS.** Generators, `prepare` and `grade` scripts run on the server in a QuickJS WebAssembly sandbox with a memory cap, a stack cap and a time limit. Only JSON crosses the boundary. They never run in Node.
- **The network boundary is the token.** The server binds to `127.0.0.1` by default and refuses any other address unless `--token` (or `ETUDE_TOKEN`) is set. With a token, every `/api` request must carry it. Card frames (`/frame/*`), the card runtime and uploaded media (`/media/*`) are served without the token, so treat drawings and attachments as readable by anyone who can reach the port.
- **Cross-site writes are refused.** Requests that change data must be `application/json`, and a foreign `Origin` gets a 403.
- **Put a TLS proxy in front for anything beyond your own network.** Etude speaks plain HTTP. If you use a reverse proxy, the server reads `X-Forwarded-Proto` and `X-Forwarded-Host` to build card frame URLs.

## What AI grading sends

AI grading is optional and off until you set a provider key. When a card is graded by AI, Etude sends the configured provider:

- every field of the card after `prepare` runs, private ones included (prompt, reference answer, explanation), except a generator script,
- the grading instructions from the card type, the deck and its parents, and the card's tags,
- the learner's answer, including a drawing or photo as an image when the answer is one.

Nothing else from the collection is sent. Keys are read from the environment or `~/.etude/.env` and are never returned by the API. The default providers are OpenRouter endpoints; change them in Settings → AI grading or point them at a local OpenAI-compatible server to keep everything on your machine.

## Reporting a vulnerability

Please report sandbox escapes, auth bypasses and anything that lets card code or a pack reach outside its frame through a [private security advisory](https://github.com/Zibhelina/etude/security/advisories/new) instead of a public issue. Include the Etude version, how you ran the server and a minimal pack or steps that reproduce it.
