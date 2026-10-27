import type { Hono } from "hono";
import type { Etude } from "../core/engine.ts";
import { syncFor } from "../core/sync/client.ts";
export function syncRoutes(app:Hono,e:Etude) {
  const s=syncFor(e);
  app.get("/api/sync/status",c=>c.json(s.status()));
  app.post("/api/sync/setup",async c=>c.json(s.setup(await c.req.json())));
  app.post("/api/sync/signin",async c=>c.json(await s.signin((await c.req.json()).email)));
  app.post("/api/sync/verify",async c=>c.json(await s.verify((await c.req.json()).code)));
  app.post("/api/sync/unlock",async c=>c.json(await s.unlock(await c.req.json())));
  app.post("/api/sync/auto",async c=>{await s.auto();return c.json(s.status());});
  app.post("/api/sync/now",async c=>c.json(await s.now()));
  app.post("/api/sync/off",async c=>c.json(await s.off()));
}
