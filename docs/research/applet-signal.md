# Applet → same-chat attempt signaling

## 1. Problem statement

Etude has three attempt paths, and only one of them needs an applet to wake the agent:

1. **Chat-native, agent-assisted:** the user answers in chat; the agent grades and records it.
2. **Applet-native, deterministic:** the applet sends the answer directly to `POST /api/attempts`; Etude computes the rating. No chat signal is needed.
3. **Applet-mediated, agent-assisted:** the applet produces a structured attempt that an agent must grade. The attempt must reach the **same logical conversation** that presented the applet, without silently creating a second conversation or displaying the payload as if it were an assistant answer.

“Same chat” means the attempt becomes a new **user-authored turn** (or an equivalent queued input) in the session that rendered the applet. Merely appending text to the transcript is insufficient: the agent must actually run with the prior session context. Conversely, directly calling the model from the applet would bypass the surface’s session, queueing, persistence, approval, and streaming machinery.

The architecture contract deliberately makes the portable v1 mechanism an Etude inbox because not every surface exposes safe programmatic chat submission (`docs/architecture.md:190-198, 223-228`). Direct signal-to-chat is an optional per-surface accelerator, never the only durable path.

## 2. Baseline: the inbox pattern

### 2.1 Contract and exact calls

The applet submits a structured envelope to Etude’s local HTTP server:

```http
POST http://127.0.0.1:2600/api/inbox
Content-Type: application/json

{
  "atom_id": "CMPT-310-07",
  "payload": {
    "kind": "matching-pairs-attempt",
    "answer": {
      "pairs": [["A", "3"], ["B", "1"], ["C", "2"]]
    },
    "applet_instance_id": "CMPT-310-07v2",
    "submission_id": "client-generated-unique-id"
  },
  "ts": "2026-07-23T14:05:12-07:00"
}
```

The required v1 body is exactly `{atom_id, payload, ts}`; the nested `kind`, `answer`, `applet_instance_id`, and `submission_id` fields are recommended conventions that fit inside the unconstrained `payload`. The server stores the item in `inbox.json` and returns its normal JSON success response. The API contract is in `docs/architecture.md:165-185`, especially lines 182-184.

The agent reads pending items on its next opportunity using either interface:

```sh
etude inbox list
```

or:

```http
GET http://127.0.0.1:2600/api/inbox
```

After grading against `etude context <atom-id> --queue <queue-id>`, the agent records the attempt through the canonical attempt path. For a structured answer, serialize the applet payload verbatim to a file, serialize feedback to another file, then call:

```sh
etude attempt CMPT-310-07 \
  --rating 2 \
  --answer-file /path/to/answer.json \
  --feedback-file /path/to/feedback.md \
  --variant CMPT-310-07v2 \
  --mode applet \
  --via applet
```

Finally, acknowledge/delete the handled inbox item:

```http
DELETE http://127.0.0.1:2600/api/inbox/0
```

or use the CLI’s item-clear operation:

```sh
etude inbox clear --id <inbox-id>
```

The CLI attempt and inbox contracts are specified at `docs/architecture.md:143-163`; the ownership rule is explicit at `docs/architecture.md:190-198`: the applet parks the payload, the agent grades it, and the agent records the final attempt with `via=applet`.

> **Index versus ID:** the HTTP contract currently names `DELETE /api/inbox/{index}`, while the CLI contract names `clear --id N`. Treat each interface’s identifier as opaque and use the value returned by that interface; do not assume an HTTP array index is a durable submission ID.

### 2.2 Sequence diagram

```text
User            Applet/iframe        Etude :2600          Same chat/agent
 | enter attempt     |                    |                       |
 |------------------>|                    |                       |
 | click Submit      |                    |                       |
 |                   | POST /api/inbox    |                       |
 |                   | {atom_id,payload,ts}|                       |
 |                   |------------------->| persist inbox.json    |
 |                   |<-------------------| success               |
 | see “Submitted”   |                    |                       |
 |                   |                    |   next agent chance   |
 | say “done” -------+------------------------------------------->|
 |                   |                    |<-- inbox list / GET --|
 |                   |                    |--- pending payload --->|
 |                   |                    |                       | grade via cascade
 |                   |                    |<-- etude attempt ------|
 |                   |                    |--- saved attempt ----->|
 |                   |                    |<-- clear / DELETE -----|
 |<--------------------------------------------------------------| feedback in same chat
```

The applet’s success state should mean **“submission stored”**, not “graded.” It should disable duplicate submission while the request is in flight, preserve the attempted answer on failure, and show a retry control. A `submission_id` allows the eventual server to deduplicate retries even though idempotency is not yet part of the v1 contract.

### 2.3 UX and polling etiquette

Two portable UX modes are valid:

- **User-mediated (preferred fallback):** after `POST /api/inbox` succeeds, the applet says “Submitted — tell the agent ‘done’ to grade it.” The next user message naturally gives the agent a new turn, and the agent immediately runs `etude inbox list`.
- **Bounded agent polling:** after presenting the applet, an agent run that can remain alive may check immediately and then at approximately **2 s, 5 s, and 10 s** (four checks total). Stop as soon as the matching `atom_id`/`applet_instance_id` appears. After the final empty result, stop polling and ask the user to say “done” when ready.

Do not hold an agent/tool turn open indefinitely, poll faster than once per second, or continue after four empty checks. Most chat responses finish as soon as the applet is rendered, so the user-mediated next turn is the reliable baseline. If multiple applets are live, match on both atom and applet instance; never consume “the first inbox row” blindly.

## 3. Per-surface findings

### 3.1 Obsidian Agents

Canonical inspected checkout: a local checkout of the `obsidian-agents` plugin source.

#### What exists today

| Finding | File/line evidence |
|---|---|
| Chat applets are parsed only from `obsidian-agents-applet` / `obsidian-agents-react` fences and rendered in the message layout. | `src/ui/components/LayoutEngine.ts:79-122` parses the fences; `src/ui/components/MessageBubble.ts:121-129` invokes `LayoutEngine.render` for an agent message. |
| Each applet runs in a `srcdoc` iframe sandboxed with `allow-scripts allow-same-origin allow-forms`. | `src/ui/components/LayoutEngine.ts:224-243`; full-screen frames use the same sandbox at lines 304-312. |
| The renderer does **not** install an applet-to-parent `message` listener or inject a chat bridge. | `src/ui/components/LayoutEngine.ts:224-301` creates/sizes the iframe and only handles load/resize/expand. A source-wide search found no `postMessage`, `MessageEvent`, or `message` event bridge. The only window listeners found are pointer/resize helpers, not chat submission. |
| The actual user-send path exists, but it is internal to `ChatView`: Composer’s callback calls private `doSendMessage`; that calls the plugin’s `sendMessage`. | `src/ui/ChatView.ts:187-195`, `380-415`, and `571-572`. |
| The plugin’s `sendMessage` creates a real `role: "user"` message in the named session, appends the agent placeholder, and invokes Hermes with that session ID. | `src/plugin.ts:596-638`, `649-680`, and `741-750`. This is the behavior a bridge must reuse rather than mutating transcript arrays directly. |
| Mid-stream user sends are not injected into the current SSE request. They are previewed and queued, then coalesced into a fresh turn after completion. | `src/ui/ChatView.ts:78-92`, `392-415`, and `536-612`. A future applet bridge should inherit this behavior. |
| The plugin already has bubbling custom DOM events, but none submits a chat message. | `src/ui/ChatView.ts:243-280` handles composer expansion, reply, branch, and term-open events. `src/ui/components/MessageBubble.ts:213-230` emits reply/branch. No applet-submit event is registered. |
| The plugin registers only its “open chat” command and no Markdown code-block processor for note content. | `src/plugin.ts:140-158` registers the view, ribbon icon, and `open-obsidian-agents` command. A source-wide search found no `registerMarkdownCodeBlockProcessor`. Therefore note-rendered DataviewJS/HTML has no supported Agents applet→chat API today. |
| A token-authenticated callback HTTP server exists, but its `chat` channel appends an **agent-authored delivery**; it does not create a user turn or invoke the agent. | `src/callback/server.ts:76-105` (route/auth), `123-173` (delivery dispatch); `src/callback/channels/chat.ts:3-21`; `src/plugin.ts:216-242` creates `role: "agent"`. It is suitable for background results, not learner attempts. |
| Callback settings default to loopback, ephemeral port, enabled, with an auto-generated token. | `src/types.ts:240-261`; startup and token generation are at `src/plugin.ts:244-264`. |

#### Plain conclusion

There is **no supported mechanism today** for HTML/React chat applets, DataviewJS, or note iframes to inject a user message into the same Obsidian Agents session. Directly reaching into `app.plugins.plugins[...]`, `chatView`, private methods, or persisted session arrays would be an unstable internal hack and would bypass queueing and streaming semantics.

### 3.2 Hermes Desktop

Inspected a local checkout of the `hermes-agent` source and docs; no profile sessions, transcripts, memories, or state databases were read.

#### What exists today

| Finding | File/line evidence |
|---|---|
| Desktop plugins can read the active runtime session ID and issue the same gateway JSON-RPC used by the app. | `website/docs/developer-guide/desktop-plugin-sdk.md:35-48`, `357-386`; specifically `host.state.activeSessionId` at lines 363-369 and `host.request` at 378-386. |
| The gateway transport is JSON-RPC 2.0 over the desktop WebSocket. | `apps/shared/src/json-rpc-gateway.ts:25-42`, `97-137`, and `259-338`. |
| A real desktop user send ultimately uses `prompt.submit` with `{session_id, text}`. | `apps/desktop/src/app/session/hooks/use-prompt-actions/submit.ts:513-527`; resume-and-retry uses the same call at lines 529-562. |
| Core submission does substantially more than one RPC: it guards the target session, resumes durable sessions, syncs attachments, paints optimistic UI, prevents duplicate in-flight submissions, retries busy/missing runtimes, and restores errors. | `submit.ts:142-237`, `239-312`, `330-434`, and `493-628`. A plugin that calls `prompt.submit` directly does not automatically inherit all renderer-side UX logic. |
| The SDK has composer **extension/middleware** slots, but the documented public exports do not include a “submit this draft to this chat” convenience method. | `desktop-plugin-sdk.md:332-337` and export table at `595-607`. The source lists `host.request`, not `host.submitPrompt`. |
| A desktop plugin may ship its own scoped REST/WebSocket backend, reached with `ctx.rest`/`ctx.socket`; sockets require a polling fallback on OAuth remotes. | `desktop-plugin-sdk.md:443-517`, especially `477-489` and `492-517`. |
| Loaded desktop plugins have full app authority; their isolation is error isolation, not a security sandbox. | `desktop-plugin-sdk.md:557-570`. |
| Generic Hermes webhooks trigger a separate webhook-origin agent run and deliver to configured messaging adapters or logs; Desktop/specific desktop session is not a documented delivery target. | `website/docs/user-guide/messaging/webhooks.md:7-11`, route fields at `73-89`, and delivery list at `296-320`. The adapter’s built-in cross-platform targets are listed in `gateway/platforms/webhook.py:74-79`. Webhooks are therefore not a same-Desktop-chat injection API. |

#### Plain conclusion

A **native Hermes Desktop plugin pane** can technically submit to the currently active runtime conversation today:

```js
const sessionId = host.state.activeSessionId.get();
if (!sessionId) throw new Error("No active session");
await host.request("prompt.submit", {
  session_id: sessionId,
  text: formatEtudeAttempt(payload)
});
```

That is a low-level RPC, not a complete applet API. A standalone HTML file opened in a browser cannot import `@hermes/plugin-sdk` or access the Desktop host. An iframe inside a plugin also needs a plugin-owned `postMessage` bridge; no generic Desktop applet iframe bridge is documented.

### 3.3 Comparable systems

Two official patterns bracket Etude’s choices:

- **OpenAI/MCP Apps:** the widget is sandboxed in an iframe and talks to the host through JSON-RPC 2.0 over `postMessage`. `ui/message` asks the host to create a user-authored follow-up; `ui/update-model-context` updates model-visible state without pretending it is a chat message. Evidence: [OpenAI, “Build your ChatGPT UI”](https://developers.openai.com/apps-sdk/build/chatgpt-ui), especially the overview and “Use the MCP Apps bridge” / “Send a follow-up message” sections (locally extracted lines 49-70 and 116-145).
- **Claude Code published artifacts:** the official documented return path is deliberately manual—an export or “Copy as prompt” control whose text the user pastes back into the session. Published pages are static/sandboxed and have no backend; connector actions are capability-scoped but are not described as same-session chat injection. Evidence: [Claude Code artifacts docs](https://code.claude.com/docs/en/artifacts), “Bring the result back to your session” and “Page constraints” (locally extracted lines 156-163 and 189-199).

The reusable lesson is: **a host-owned, capability-checked bridge creates the chat turn; sandboxed applet code never receives raw session credentials.** When no bridge exists, explicit copy/paste or a durable inbox is the honest fallback.

## 4. Recommended upgrade path per surface

### 4.1 Obsidian Agents

#### Phase A — keep inbox as the default

All Etude applets POST to `/api/inbox` first. This preserves attempts if Obsidian closes, the chat changes, or a direct signal fails. The direct bridge should carry the inbox item reference plus a compact human-readable summary, not replace persistence.

#### Phase B — add a host-owned applet bridge

Add one versioned message shape:

```ts
interface EtudeAppletSubmitV1 {
  source: "etude";
  version: 1;
  type: "attempt.submit";
  atomId: string;
  inboxRef: string | number;
  appletInstanceId: string;
  submissionId: string;
  summary: string;
}
```

Recommended flow:

1. `LayoutEngine` creates the iframe and retains its exact `contentWindow`.
2. The applet first POSTs to Etude inbox.
3. On success it calls `window.parent.postMessage(envelope, expectedOrigin)`.
4. The parent listener accepts only `event.source === iframe.contentWindow`, the exact schema/version, bounded string sizes, and an Etude applet instance registered for that message.
5. The bridge emits a typed callback to `ChatView`—do not expose private plugin/session objects to the iframe.
6. `ChatView` routes the generated user text through the same `doSendMessage` path used by Composer. If streaming, the existing steering queue handles it; if idle, it becomes a normal user turn.
7. The user turn should say, for example: `Etude applet submitted CMPT-310-07 (inbox ref 12, submission abc…). Read and grade that inbox item.` The structured payload remains in Etude rather than being duplicated into transcript text.

Do not reuse the existing callback `chat` channel as-is: it labels content as an agent message and does not run the agent. If HTTP-origin submission is also needed for note surfaces, add a **new token-authenticated user-input channel** whose implementation calls the same send/queue method—not `deliverToSession`.

#### Phase C — support note/DataviewJS surfaces explicitly

Register a documented Obsidian workspace event or plugin API, for example:

```ts
app.workspace.trigger("obsidian-agents:submit-user-message", {
  sessionId,
  source: "etude",
  text,
  submissionId
});
```

The Agents plugin must own the listener, validate the caller payload, resolve an explicit session ID (never silently use whichever chat happens to become active later), and route through normal send semantics. HTML note iframes should still use `postMessage` to a host renderer that invokes this API. DataviewJS may call the workspace event directly, but should not reach into private plugin fields.

### 4.2 Hermes Desktop

#### Phase A — native plugin prototype

Build an Etude Desktop plugin pane. The pane reads `host.state.activeSessionId.get()` **at click time**, records the payload to Etude inbox, then—only when the gateway/session is idle—calls:

```js
await host.request("prompt.submit", {
  session_id: host.state.activeSessionId.get(),
  text: `Etude applet submission stored as inbox ${inboxRef}. Read and grade it.`
});
```

Subscribe with `host.onEvent` to the matching session’s `message.complete` if the attempt is submitted while a turn is active; submit after completion rather than racing the backend’s busy guard. Keep the inbox fallback if the RPC rejects.

If the UI itself is an iframe, let the child send a typed `postMessage` to the plugin component. The parent plugin—not the child—reads the session ID and calls the SDK. Validate `event.source`, schema, and instance nonce.

#### Phase B — add a first-class Desktop SDK verb

The robust long-term API is something like:

```ts
host.submitPrompt({
  sessionId?: string,       // defaults to active at invocation time
  text: string,
  source: "plugin:etude",
  idempotencyKey: string,
  queueIfBusy: true
})
```

It should delegate to the app’s existing submit/queue/resume pipeline, preserving optimistic transcript updates, durable/runtime ID translation, attachment/session guards, retries, and error restoration. This is safer than teaching every plugin to reproduce `submit.ts` or issue `prompt.submit` directly.

#### Phase C — out-of-chat browser applets

For standalone HTML, keep the Etude inbox. If immediate signaling is required, the Desktop plugin can expose a scoped, token-authenticated local endpoint through its backend namespace, receive the submission ID, and notify the renderer via `ctx.socket` (plus polling fallback). The renderer then calls `host.submitPrompt`/`prompt.submit`. Do not expose the gateway WebSocket URL, desktop auth, or session credential directly to arbitrary browser JavaScript.

## 5. Security notes

### 5.1 V1’s actual trust boundary

Etude v1 is specified as a localhost HTTP server with **no authentication**. Binding only to `127.0.0.1` is necessary, but it means only “not directly reachable from another machine.” It does **not** protect against:

- another local process submitting or deleting inbox items;
- another browser page attempting a cross-origin request to localhost;
- DNS-rebinding or a compromised browser extension;
- an applet submitting an attempt for a different atom;
- duplicate/replayed submissions;
- oversized payloads or payload text later used in an agent prompt.

Never bind unauthenticated Etude v1 to `0.0.0.0`, `::`, a LAN address, a tunnel, or a port-forward. CORS is useful defense-in-depth but is not authentication; reject non-JSON/simple request shapes and unexpected `Origin` values rather than assuming browser SOP solves localhost CSRF.

### 5.2 Minimum hardening before direct signal-to-chat

1. **Loopback only:** bind explicitly to `127.0.0.1` (and separately `::1` only if deliberately supported), not wildcard interfaces.
2. **Per-run capability token:** generate a high-entropy token and require it on inbox writes/deletes and any signal endpoint. Prefer the parent host to retain the token; a sandboxed child receives only a narrow bridge.
3. **Schema and size validation:** allow known `type`/`version`, valid atom IDs, bounded nesting/string lengths, and a small body limit.
4. **Session binding:** bind applet instance → originating session in host state. Reject a session ID supplied solely by untrusted applet payload.
5. **Source validation:** for iframe bridges, require `event.source === expectedIframe.contentWindow`; use a strict `targetOrigin` where a non-opaque origin exists. With `srcdoc`/sandbox origins, pair source checks with an unguessable per-instance nonce.
6. **Idempotency:** key on `submission_id`; a double-click/retry must create one inbox item and one chat turn.
7. **User-authored semantics:** label the resulting turn as user/app input and route it through normal session submission. Never append it as an assistant message.
8. **Prompt-injection containment:** treat all payload fields as untrusted data. The bridge’s chat message should reference a stored inbox item; the agent should parse schema fields, not obey prose embedded in the learner answer.
9. **No raw credentials in applets:** do not embed Obsidian callback tokens, Hermes gateway credentials, or durable session secrets in generated HTML that may be copied/shared.
10. **Audit and recovery:** log accepted/rejected submission IDs without answer contents where possible; preserve inbox data until grading succeeds so a failed direct signal is recoverable.

## Decision

Ship the **inbox-first** design for v1 on every surface. Add direct same-chat signaling as a best-effort notification layered over the persisted inbox:

- **Obsidian Agents:** requires new host code; no supported applet/note → user-turn bridge exists today.
- **Hermes Desktop plugin:** low-level same-session submission is possible now with `activeSessionId + host.request("prompt.submit", ...)`, but a first-class queued `host.submitPrompt` SDK verb is the correct production upgrade.
- **Standalone/out-of-chat HTML:** use inbox unless a trusted host/plugin mediates a token-authenticated bridge.
