import { AccountError } from "../../core/account.ts";
import { shareFor } from "../../core/share/client.ts";
import { command, group, CliError } from "../registry.ts";

group({ name: "share", summary: "Share Notebook folders and pages with other Etude accounts, end-to-end encrypted", defaultVerb: "list" });

const s = (c: { e: any }) => shareFor(c.e);
const SPACE = { name: "space", description: "Shared space id (spc_…), or a note in it (id or path).", required: true };
const ROLE = { name: "role", type: "string" as const, description: "edit (default) or view." };
/** Server answers become CLI errors with the matching exit code. */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AccountError) {
      const code = e.code === "sync_required" ? "sync_required" : e.status === 404 ? "not_found" : e.status === 409 ? "conflict" : e.status >= 500 ? "external" : e.status === 400 || e.status === 422 ? "validation" : "usage";
      throw new CliError(e.message, code, { status: e.status, code: e.code });
    }
    throw e;
  }
}
const role = (v: unknown) => {
  if (v === undefined) return "edit" as const;
  if (v !== "edit" && v !== "view") throw new CliError('the role is "edit" or "view"', "validation");
  return v;
};

command({
  name: "share list",
  summary: "Shared spaces on this device and invites waiting for you.",
  description: "Reads the server's list first when signed in (new invites, roles, removed access), without syncing notes. A space whose access was removed stays here as a read-only copy (`status` \"removed\") until you leave it.",
  output: "{ signedIn, email, server, waiting, received, spaces: [{ id, rootId, name, role, status, owner, lastSync, error, pending }], invites: [{ spaceId, memberId, role, owner, name, created }] }",
  run: (c) =>
    call(async () => {
      const sh = s(c);
      if (sh.signedIn()) await sh.refresh();
      return sh.status();
    }),
});
command({
  name: "share create",
  summary: "Share a folder or page: everything under it syncs with the people you invite.",
  description: "Needs Etude Sync on your account (the people you invite don't). Shared folders don't nest. Makes this account's sharing identity on first use; nothing to save or type.",
  args: [{ name: "note", description: "The folder or page (id or path).", required: true }],
  writes: true,
  output: "{ space }",
  examples: ["etude share create 'Algorithms'"],
  run: (c) => call(async () => ({ space: await s(c).create(c.e.notes.resolve(c.args.note).id) })),
});
command({
  name: "share invite",
  summary: "Invite someone by email to view or edit a shared space.",
  description: "They get an email and see the invite at the top of Notes once they sign in with that address. Owners and editors can invite.",
  args: [SPACE, { name: "email", description: "Their email address.", required: true }],
  flags: [ROLE],
  writes: true,
  output: "{ member: { id, email, role, status, hasKey } }",
  examples: ["etude share invite 'Algorithms' alex@example.com --role view"],
  run: (c) => call(async () => ({ member: await s(c).invite(s(c).spaceFor(c.args.space), c.args.email, role(c.flags.role)) })),
});
command({
  name: "share members",
  summary: "The people in a shared space and their roles.",
  args: [SPACE],
  output: "{ members: [{ id, email, name, role, status, hasKey }] }",
  run: (c) => call(async () => ({ members: await s(c).listMembers(s(c).spaceFor(c.args.space)) })),
});
command({
  name: "share role",
  summary: "Change someone's role (owner only).",
  args: [SPACE, { name: "email", description: "Their email address (or member id).", required: true }, { name: "role", description: "edit or view.", required: true }],
  writes: true,
  output: "{ member }",
  run: (c) => call(async () => ({ member: await s(c).setRole(s(c).spaceFor(c.args.space), c.args.email, role(c.args.role)) })),
});
command({
  name: "share remove",
  summary: "Remove someone from a shared space (owner only); the key is replaced so they can't read what comes next.",
  args: [SPACE, { name: "email", description: "Their email address (or member id).", required: true }],
  writes: true,
  output: "{ ok, removed }",
  run: (c) => call(() => s(c).removeMember(s(c).spaceFor(c.args.space), c.args.email)),
});
command({
  name: "share accept",
  summary: "Accept an invite: the shared folder appears in your Notes and syncs.",
  args: [{ name: "space", description: "The invite's space id (spc_…), from `share list`.", required: true }],
  flags: [{ name: "parent", type: "string", description: "Put it inside this folder (id or path) instead of at the top." }],
  writes: true,
  output: "{ space, rootId }",
  run: (c) => call(() => s(c).accept(c.args.space, { parentId: c.flags.parent ? c.e.notes.resolve(c.flags.parent).id : null })),
});
command({
  name: "share decline",
  summary: "Decline an invite.",
  args: [{ name: "space", description: "The invite's space id (spc_…).", required: true }],
  writes: true,
  output: "{ ok }",
  run: (c) => call(() => s(c).decline(c.args.space)),
});
command({
  name: "share leave",
  summary: "Leave a shared space; its notes stay here as your own. Also drops a removed copy's link.",
  args: [SPACE],
  writes: true,
  output: "{ ok, rootId }",
  run: (c) => call(() => s(c).leave(s(c).spaceFor(c.args.space))),
});
command({
  name: "share stop",
  summary: "Stop sharing (owner): the space is deleted from the server for everyone; your notes stay here.",
  args: [SPACE],
  writes: true,
  output: "{ ok, rootId }",
  run: (c) => call(() => s(c).stop(s(c).spaceFor(c.args.space))),
});
command({
  name: "share sync",
  summary: "Sync every shared space now: pull what others changed, send what changed here.",
  writes: true,
  output: "share list's status",
  run: (c) => call(() => s(c).auto(true)),
});
command({
  name: "share who",
  summary: "Who's in your shared spaces right now, and on which page.",
  description: "Other people's devices that said they were here in the last 40 seconds (your own device is left out). With a note, only its space, and `here` marks the people on that very note; with a space id, that space; with nothing, every space. What page they're on travels encrypted; the server only knows they're in the space.",
  args: [{ name: "ref", description: "A note (id or path) or a space id (spc_…).", required: false }],
  output: "{ people: [{ space, email, name, color, note, title, kind, sel, block, typing, at, here }] }",
  examples: ["etude share who", "etude share who 'Algorithms/Week 1'"],
  run: (c) =>
    call(async () => {
      const sh = s(c);
      if (!sh.signedIn()) throw new CliError("sign in to your Etude account first", "usage");
      const ref = c.args.ref as string | undefined;
      const opts = !ref ? {} : ref.startsWith("spc_") ? { spaceId: sh.spaceFor(ref) } : { noteId: c.e.notes.resolve(ref).id };
      const people = await sh.who(opts);
      return { people: people.map(({ space, email, name, color, note, title, kind, sel, block, typing, at, here }) => ({ space, email, name, color, note, title, kind, sel, block, typing, at, here })) };
    }),
});
command({
  name: "share activity",
  summary: "How active each person in a shared space is: last seen, last edit, edits this week and month, and a 14-day strip.",
  description: "Counted by the server from when and by whom changes were sent (it can't read them). An edit is one change sent; typing a paragraph is a few. `days` are UTC days, oldest first, each with edits per account id.",
  args: [SPACE],
  output: "{ members: [{ memberId, accountId, email, name, color, lastSeen, lastEdit, edits7d, edits30d, editsTotal }], days: [{ day, edits }] }",
  examples: ["etude share activity 'Algorithms'"],
  run: (c) => call(() => s(c).activity(s(c).spaceFor(c.args.space))),
});
