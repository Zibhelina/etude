// /api/account/*: the app's view of the Etude account. Each route maps to one AccountClient call.
import type { Context, Hono } from "hono";
import type { Etude } from "../core/engine.ts";
import { accountFor, AccountError } from "../core/account.ts";

export function accountRoutes(app: Hono, e: Etude) {
  const a = accountFor(e);
  const body = async (c: Context): Promise<any> => {
    try {
      return await c.req.json();
    } catch {
      return {};
    }
  };
  const need = (v: unknown, what: string) => {
    if (typeof v !== "string" || !v.trim()) throw new AccountError(`${what} is required`, 400, "invalid");
    return v;
  };

  app.get("/api/account", async (c) => c.json(await a.status()));
  app.put("/api/account/server", async (c) => c.json(a.setServer(String((await body(c)).server ?? ""))));
  app.post("/api/account/signin", async (c) => c.json(await a.signin(need((await body(c)).email, "email"))));
  app.post("/api/account/verify", async (c) => {
    const b = await body(c);
    return c.json(await a.verify(need(b.code, "code"), b.deviceName));
  });
  app.post("/api/account/signout", async (c) => c.json(await a.signout()));

  app.get("/api/account/passkeys", async (c) => c.json(await a.passkeys()));
  app.delete("/api/account/passkeys/:id", async (c) => c.json(await a.removePasskey(c.req.param("id"))));
  app.post("/api/account/passkeys/register/options", async (c) => c.json(await a.passkeyRegisterOptions()));
  app.post("/api/account/passkeys/register/verify", async (c) => c.json(await a.passkeyRegisterVerify(await body(c))));
  app.post("/api/account/passkeys/login/options", async (c) => c.json(await a.passkeyLoginOptions()));
  app.post("/api/account/passkeys/login/verify", async (c) => c.json(await a.passkeyLoginVerify(await body(c))));

  app.get("/api/account/devices", async (c) => c.json(await a.devices()));
  app.patch("/api/account/devices/:id", async (c) => c.json(await a.renameDevice(c.req.param("id"), need((await body(c)).name, "name"))));
  app.delete("/api/account/devices/:id", async (c) => c.json(await a.revokeDevice(c.req.param("id"))));

  app.get("/api/account/email", async (c) => c.json(await a.emailPending()));
  app.post("/api/account/email/start", async (c) => c.json(await a.emailStart(need((await body(c)).email, "email"))));
  app.post("/api/account/email/verify", async (c) => c.json(await a.emailVerify(need((await body(c)).code, "code"))));
  app.delete("/api/account/email", async (c) => c.json(await a.emailCancel()));

  app.get("/api/account/export", async (c) => {
    const data = await a.exportData();
    c.header("Content-Disposition", `attachment; filename="etude-account-${new Date().toISOString().slice(0, 10)}.json"`);
    c.header("Cache-Control", "no-store");
    return c.json(data);
  });
  app.post("/api/account/delete", async (c) => c.json(await a.deleteAccount(String((await body(c)).confirm ?? ""))));

  app.get("/api/account/billing", async (c) => c.json(await a.billing()));
  app.post("/api/account/billing/checkout", async (c) => c.json(await a.syncCheckout()));
  app.post("/api/account/billing/portal", async (c) => c.json(await a.billingPortal()));

  app.get("/api/account/market", async (c) => c.json(await a.paidIndex()));
  app.post("/api/account/market/checkout", async (c) => c.json(await a.checkout(need((await body(c)).listing, "listing"))));
  app.get("/api/account/library", async (c) => c.json(await a.library()));
  app.post("/api/account/library/install", async (c) => {
    const b = await body(c);
    return c.json(await a.install(need(b.listing, "listing"), { dryRun: !!b.dryRun }));
  });

  app.get("/api/account/creator", async (c) => c.json({ creator: await a.creator() }));
  app.post("/api/account/creator", async (c) => {
    const b = await body(c);
    return c.json(await a.becomeCreator(need(b.country, "country"), b.displayName));
  });
  app.post("/api/account/creator/onboarding", async (c) => c.json(await a.onboardingLink()));
  app.post("/api/account/creator/dashboard", async (c) => c.json(await a.dashboardLink()));
  app.get("/api/account/creator/sales", async (c) => c.json(await a.sales()));
  app.get("/api/account/listings", async (c) => c.json(await a.listings()));
  app.post("/api/account/listings", async (c) => c.json(await a.createListing(await body(c))));
  app.patch("/api/account/listings/:id", async (c) => c.json(await a.updateListing(c.req.param("id"), await body(c))));
  app.put("/api/account/listings/:id/cover", async (c) => c.json(await a.setCover(c.req.param("id"), await body(c))));
  app.post("/api/account/listings/:id/versions", async (c) => c.json(await a.newVersion(c.req.param("id"), await body(c))));
  app.post("/api/account/listings/:id/submit", async (c) => c.json(await a.submit(c.req.param("id"))));
  app.post("/api/account/listings/:id/hide", async (c) => c.json(await a.hide(c.req.param("id"))));

  app.get("/api/account/review", async (c) => c.json(await a.reviewQueue()));
  app.post("/api/account/review/:id/approve", async (c) => c.json(await a.approve(c.req.param("id"), (await body(c)).notes)));
  app.post("/api/account/review/:id/reject", async (c) => c.json(await a.reject(c.req.param("id"), need((await body(c)).notes, "notes"))));
}
