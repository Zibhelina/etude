// /api/share/*: sharing Notebook folders and pages with other Etude accounts (docs/sharing.md). Each route maps to
// one ShareClient call; the client does the crypto and the syncing.
import type { Context, Hono } from "hono";
import type { Etude } from "../core/engine.ts";
import { EtudeError } from "../core/engine.ts";
import { shareFor } from "../core/share/client.ts";

export function shareRoutes(app: Hono, e: Etude) {
  const s = shareFor(e);
  const body = async (c: Context): Promise<any> => {
    try {
      return await c.req.json();
    } catch {
      return {};
    }
  };
  const need = (v: unknown, what: string) => {
    if (typeof v !== "string" || !v.trim()) throw new EtudeError(`${what} is required`);
    return v.trim();
  };
  const role = (v: unknown) => {
    if (v !== "edit" && v !== "view") throw new EtudeError('the role is "edit" or "view"');
    return v;
  };

  app.get("/api/share", (c) => c.json(s.status()));
  app.get("/api/share/note/:id", async (c) => c.json({ space: await s.forNote(c.req.param("id")) }));
  app.post("/api/share", async (c) => c.json({ space: await s.create(need((await body(c)).noteId, "noteId")) }));
  app.post("/api/share/sync", async (c) => c.json(await s.auto(true)));
  app.post("/api/share/auto", async (c) => c.json(await s.auto()));
  app.post("/api/share/:space/invite", async (c) => {
    const b = await body(c);
    return c.json({ member: await s.invite(c.req.param("space"), need(b.email, "email"), b.role === undefined ? "edit" : role(b.role)) });
  });
  app.patch("/api/share/:space/members/:member", async (c) => c.json({ member: await s.setRole(c.req.param("space"), c.req.param("member"), role((await body(c)).role)) }));
  app.delete("/api/share/:space/members/:member", async (c) => c.json(await s.removeMember(c.req.param("space"), c.req.param("member"))));
  app.post("/api/share/:space/accept", async (c) => {
    const b = await body(c);
    return c.json(await s.accept(c.req.param("space"), { parentId: typeof b.parentId === "string" && b.parentId ? b.parentId : null }));
  });
  app.post("/api/share/:space/decline", async (c) => c.json(await s.decline(c.req.param("space"))));
  app.post("/api/share/:space/leave", async (c) => c.json(await s.leave(c.req.param("space"))));
  // Presence (docs/sharing.md): the app says what's open and where the cursor is; fire and forget, no error when the
  // note isn't shared. Reading it also keeps a space you're on together with someone syncing every second.
  app.post("/api/share/presence", async (c) => {
    const b = await body(c);
    try {
      s.setPresence(typeof b.note === "string" && b.note ? b.note : null, b.sel ?? null, { block: b.block, typing: !!b.typing });
    } catch {}
    return c.json({ ok: true });
  });
  app.get("/api/share/presence", async (c) => {
    const note = c.req.query("note") || null;
    const people = await s.who({ noteId: note });
    if (people.some((p) => p.here)) void s.auto().catch(() => {});
    return c.json({ people: people.map(({ device, accountId, email, name, color, note, title, kind, sel, block, typing, at, here, space }) => ({ device, accountId, email, name, color, note, title, kind, sel, block, typing, at, here, space })) });
  });
  app.get("/api/share/:space/activity", async (c) => c.json(await s.activity(s.spaceFor(c.req.param("space")))));
  app.delete("/api/share/:space", async (c) => c.json(await s.stop(c.req.param("space"))));
}
