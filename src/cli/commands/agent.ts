import { agentFor, AgentError, type AgentEvent, type AssistantContent } from "../../core/agent.ts";
import { command, group, CliError } from "../registry.ts";

group({ name: "agent", summary: "The in-app assistant: ask it to change your collection, list and manage its conversations", defaultVerb: "list" });

const agentError = (e: unknown) => {
  if (!(e instanceof AgentError)) return e;
  return new CliError(e.message, e.status === 404 ? "not_found" : e.status === 409 ? "conflict" : "validation");
};

command({
  name: "agent ask",
  summary: "Send a message to the assistant and wait for its reply. It can run Etude commands on the collection.",
  description:
    "Starts a new conversation unless --conversation is given. Destructive commands the assistant wants to run are denied unless --yes is given. The collection is snapshotted before the reply's first write, so `etude agent undo` can put it back. Progress (each command it runs) goes to stderr.",
  args: [{ name: "message", description: "What to ask.", required: true, variadic: true }],
  flags: [
    { name: "conversation", type: "string", short: "c", description: "Continue this conversation.", placeholder: "ID" },
    { name: "model", type: "string", short: "m", description: "Model ref: chatgpt:<model>, openrouter:<model> or custom:<model>. Default: the conversation's, then the last used, then the agent setting, then the feedback model.", placeholder: "REF" },
    { name: "attach", type: "string", multiple: true, description: "Attach a file (image, PDF, text, .apkg). Repeat for several.", placeholder: "FILE" },
    { name: "yes", type: "boolean", short: "y", description: "Allow destructive commands without asking." },
  ],
  writes: true,
  examples: ['etude agent ask "make a deck from these notes" --attach notes.md', 'etude agent ask -c 1a2b3c4d "now move it under Languages"', 'etude agent ask --model openrouter:deepseek/deepseek-v4.1-flash-1017 "switch to the Nord theme"'],
  output: "{ conversation, reply, commands: [{ command, status, exit }], changed, canUndo, model, ms, error? }",
  async run(ctx) {
    const a = agentFor(ctx.e);
    try {
      const conv = ctx.flags.conversation ? a.conversation(ctx.flags.conversation) : a.createConversation(ctx.flags.model ?? null);
      const ids: string[] = [];
      for (const f of ctx.flags.attach ?? []) ids.push((await a.addAttachmentFile(conv.id, f)).id);
      const msg = await a.send(conv.id, { text: ctx.args.message.join(" "), attachments: ids, model: ctx.flags.model ?? undefined, autoConfirm: ctx.flags.yes ? true : "deny" }, (e: AgentEvent) => {
        if (e.type === "tool_start" && e.item.tool === "etude_run") ctx.note(`→ ${e.item.label}`);
        if (e.type === "tool_end" && e.item.status !== "done") ctx.note(`  ${e.item.status}${e.item.exit ? ` (exit ${e.item.exit})` : ""}`);
      });
      const c = msg.content as AssistantContent;
      return {
        conversation: conv.id,
        reply: c.text,
        commands: c.items.filter((i) => i.type === "tool" && i.tool === "etude_run").map((i: any) => ({ command: i.label, status: i.status, exit: i.exit ?? null })),
        changed: c.changed,
        canUndo: msg.canUndo,
        model: c.model,
        ms: c.ms,
        ...(c.error ? { error: c.error } : {}),
      };
    } catch (e) {
      throw agentError(e);
    }
  },
});

command({
  name: "agent list",
  summary: "Conversations with the assistant, newest first.",
  output: "array of { id, title, model, created, updated }",
  run: (ctx) => agentFor(ctx.e).listConversations(),
});

command({
  name: "agent show",
  summary: "One conversation with all its messages, the commands run and their output.",
  args: [{ name: "id", description: "Conversation id.", required: true }],
  output: "{ id, title, model, created, updated, messages: [{ id, role, content, created, snapshot, undone, canUndo }] }",
  run(ctx) {
    try {
      return agentFor(ctx.e).conversation(ctx.args.id);
    } catch (e) {
      throw agentError(e);
    }
  },
});

command({
  name: "agent rename",
  summary: "Give a conversation your own title. Automatic titles stop for it.",
  args: [
    { name: "id", description: "Conversation id.", required: true },
    { name: "title", description: "New title.", required: true },
  ],
  writes: true,
  output: "{ id, title, autoTitle, model, created, updated }",
  run(ctx) {
    try {
      return agentFor(ctx.e).renameConversation(ctx.args.id, ctx.args.title);
    } catch (e) {
      throw agentError(e);
    }
  },
});

command({
  name: "agent delete",
  summary: "Delete a conversation and its attachments. Changes it made to the collection stay.",
  args: [{ name: "id", description: "Conversation id.", required: true }],
  writes: true,
  confirm: true,
  output: "{ deleted }",
  run(ctx) {
    try {
      return agentFor(ctx.e).deleteConversation(ctx.args.id);
    } catch (e) {
      throw agentError(e);
    }
  },
});

command({
  name: "agent undo",
  summary: "Put the collection back as it was before one of the assistant's replies (default: its latest reply that changed something). Changes made after it are undone too.",
  args: [{ name: "id", description: "Conversation id.", required: true }],
  flags: [{ name: "message", type: "number", description: "The assistant message to undo (see `agent show`).", placeholder: "ID" }],
  writes: true,
  confirm: true,
  output: "{ restored, undone: [message ids] }",
  run(ctx) {
    try {
      return agentFor(ctx.e).undo(ctx.args.id, ctx.flags.message);
    } catch (e) {
      throw agentError(e);
    }
  },
});

command({
  name: "agent models",
  summary: "Models the assistant can use, from every configured provider (ChatGPT plan, OpenRouter tool-capable models, a custom endpoint).",
  flags: [{ name: "search", type: "string", description: "Only models whose ref or name contains this.", placeholder: "TEXT" }],
  output: "{ configured, default, groups: [{ provider, label, models: [{ ref, name, vision }], error? }] }",
  async run(ctx) {
    const m = await agentFor(ctx.e).models(true);
    const q = String(ctx.flags.search ?? "").toLowerCase();
    if (!q) return m;
    return { ...m, groups: m.groups.map((g) => ({ ...g, models: g.models.filter((x) => x.ref.toLowerCase().includes(q) || x.name.toLowerCase().includes(q)) })) };
  },
});
