import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import {
  bundledPlugin,
  bundledPlugins,
  checkPlugin,
  loadPluginDir,
  netConnectOrigins,
  pluginHash,
  pluginsFor,
  scaffoldPlugin,
  type PluginPackage,
} from "../src/core/plugins.ts";
import { pluginControllerFrame, pluginCsp, pluginViewFrame } from "../src/server/frame.ts";
import { createApp } from "../src/server/app.ts";
import { agentRefusal } from "../src/core/agent-guard.ts";
import { COMMANDS } from "../src/cli/registry.ts";
import "../src/cli/commands/index.ts";
import { buildSubmission, checkEntry, installFile, summarize } from "../src/core/market.ts";

function makeTemp() {
  const dir = mkdtempSync(join(tmpdir(), "etude-plugins-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("plugins core, sandbox, permissions, and bundled Pomodoro", () => {
  it("ships bundled Pomodoro plugin that passes static checks and installs cleanly", async () => {
    const list = bundledPlugins();
    const pomo = bundledPlugin("pomodoro");
    assert.ok(pomo, "pomodoro bundled plugin should exist");
    assert.ok(list.some((p) => p.manifest.id === "pomodoro"));
    assert.deepEqual(checkPlugin(pomo), []);
    assert.deepEqual(pomo.manifest.platforms, ["desktop", "web"]);

    const tmp = makeTemp();
    try {
      const e = await Etude.open(join(tmp.dir, "etude.db"), { home: tmp.dir });
      const store = pluginsFor(e);
      const res = store.install(pomo, { source: "bundled", expectedHash: pomo.hash, enable: true });
      assert.equal(res.status, "installed");
      assert.equal(res.plugin.enabled, true);
      assert.deepEqual(res.plugin.pendingPermissions, []);

      // Storage works when enabled + storage granted
      store.kvSet("pomodoro", "state", { phase: "focus", done: 2 });
      assert.deepEqual(store.kvGet("pomodoro", "state"), { phase: "focus", done: 2 });
      const ev = store.appendEvent("pomodoro", "phase.done", { mins: 25 });
      assert.equal(ev.kind, "phase.done");
      assert.equal(store.listEvents("pomodoro").length, 1);

      // Revoking storage blocks KV and event log immediately
      store.setPermissions("pomodoro", ["ui.commands", "ui.floating"]);
      assert.throws(() => store.kvGet("pomodoro", "state"), /storage/);
      assert.throws(() => store.appendEvent("pomodoro", "phase.done", {}), /storage/);

      e.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("rejects remote code loading, traversal paths, unknown permissions, and mobile platforms", () => {
    const bad: PluginPackage = {
      manifest: {
        etude: "plugin/1",
        id: "bad-plugin",
        name: "Bad",
        version: "1.0.0",
        author: "Test",
        description: "Bad",
        main: "main.js",
        views: { v: "v.html" },
        permissions: ["super.admin", "net:http://evil.com"],
        platforms: ["ios" as any],
      },
      files: {
        "main.js": `import("https://evil.example/a.js"); importScripts("x.js");`,
        "v.html": `<script src="https://evil.example/x.js"></script>`,
        "../escape.js": "1+1",
      },
    };
    const errs = checkPlugin(bad);
    assert.ok(errs.some((e) => e.includes("unknown or invalid permission")));
    assert.ok(errs.some((e) => e.includes("platforms")));
    assert.ok(errs.some((e) => e.includes("remote dynamic import")));
    assert.ok(errs.some((e) => e.includes("importScripts")));
    assert.ok(errs.some((e) => e.includes("remote <script src>")));
    assert.ok(errs.some((e) => e.includes("invalid file path")));
  });

  it("refuses tampered hash and pauses plugin on permission escalation update", async () => {
    const tmp = makeTemp();
    try {
      const e = await Etude.open(join(tmp.dir, "etude.db"), { home: tmp.dir });
      const store = pluginsFor(e);
      const v1: PluginPackage = {
        manifest: {
          etude: "plugin/1",
          id: "sample-tool",
          name: "Sample Tool",
          version: "1.0.0",
          author: "Tester",
          description: "v1",
          main: "main.js",
          permissions: ["ui.commands"],
          platforms: ["desktop", "web"],
        },
        files: { "main.js": `etude.commands.register({ id: "hi", label: "Hi", run() {} });` },
      };
      // Tampered expectedHash fails
      assert.throws(() => store.install(v1, { expectedHash: "0".repeat(64) }), /hash mismatch/);

      const r1 = store.install(v1, { expectedHash: pluginHash(v1), enable: true });
      assert.equal(r1.plugin.enabled, true);

      // Update requesting an extra permission must pause the plugin
      const v2: PluginPackage = {
        ...v1,
        manifest: { ...v1.manifest, version: "1.1.0", permissions: ["ui.commands", "read.notes"] },
      };
      const r2 = store.install(v2, { source: "market" });
      assert.equal(r2.status, "updated");
      assert.equal(r2.pausedForPermissions, true);
      assert.equal(r2.plugin.enabled, false);
      assert.deepEqual(r2.plugin.pendingPermissions, ["read.notes"]);

      e.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("enforces strict CSP with connect-src 'none' unless net:<host> is granted", () => {
    assert.deepEqual(netConnectOrigins(["storage", "notify"]), []);
    assert.ok(pluginCsp(["storage"]).includes("connect-src 'none'"));
    assert.ok(pluginCsp(["net:api.example.com"]).includes("connect-src https://api.example.com"));
    const ctrl = pluginControllerFrame("p1", "console.log(1)", []);
    assert.ok(ctrl.includes("connect-src 'none'"));
    const view = pluginViewFrame("p1", "v1", `<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"><base href="https://evil.example/"></head><body>ok</body></html>`, []);
    assert.ok(!view.includes("default-src *"), "author CSP must be stripped");
    assert.ok(!view.includes("evil.example"), "author base tag must be stripped");
    assert.ok(view.includes("connect-src 'none'"));
  });

  it("scaffolds, loads, publishes to Market shape, and installs via Market", async () => {
    const tmp = makeTemp();
    try {
      const dir = join(tmp.dir, "my-plug");
      scaffoldPlugin("my-plug", dir, { name: "My Plug", author: "Dev" });
      const pkg = loadPluginDir(dir);
      assert.deepEqual(checkPlugin(pkg), []);

      const e = await Etude.open(join(tmp.dir, "etude.db"), { home: tmp.dir });
      const sub = buildSubmission(e, { kind: "plugin", ref: dir, author: "Dev" });
      assert.deepEqual(checkEntry(sub), []);
      const sum = summarize(sub) as any;
      assert.equal(sum.plugin.id, "my-plug");

      const installed = installFile(e, sub);
      assert.equal(installed.result, "created");
      assert.ok(pluginsFor(e).get("my-plug")?.enabled);
      e.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("serves HTTP plugin routes and isolates KV across plugins", async () => {
    const tmp = makeTemp();
    try {
      const e = await Etude.open(join(tmp.dir, "etude.db"), { home: tmp.dir });
      const app = createApp(e);
      const listRes = await app.fetch(new Request("http://localhost/api/plugins"));
      assert.equal(listRes.status, 200);
      const listJson = await listRes.json();
      assert.ok(listJson.bundled.some((b: any) => b.id === "pomodoro"));

      const instRes = await app.fetch(
        new Request("http://localhost/api/plugins/install-bundled", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: "pomodoro" }),
        }),
      );
      assert.equal(instRes.status, 200);

      const mainRes = await app.fetch(new Request("http://localhost/frame-plugin/pomodoro/main"));
      assert.equal(mainRes.status, 200);
      assert.ok((await mainRes.text()).includes("connect-src 'none'"));

      const viewRes = await app.fetch(new Request("http://localhost/frame-plugin/pomodoro/view/timer"));
      assert.equal(viewRes.status, 200);
      const viewHtml = await viewRes.text();
      assert.ok(viewHtml.includes("Focus"));
      assert.ok(viewHtml.includes("connect-src 'none'"));

      const putRes = await app.fetch(
        new Request("http://localhost/api/plugins/pomodoro/kv/hello", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: { ok: 1 } }),
        }),
      );
      assert.equal(putRes.status, 200);
      const getRes = await app.fetch(new Request("http://localhost/api/plugins/pomodoro/kv/hello"));
      assert.deepEqual(await getRes.json(), { key: "hello", value: { ok: 1 } });

      // Disabling stops frame serving and KV access
      await app.fetch(
        new Request("http://localhost/api/plugins/pomodoro", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        }),
      );
      assert.equal((await app.fetch(new Request("http://localhost/frame-plugin/pomodoro/main"))).status, 404);
      assert.equal((await app.fetch(new Request("http://localhost/api/plugins/pomodoro/kv/hello"))).status, 403);

      e.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("blocks Ask Etude from mutating plugins across all plugin CLI commands", () => {
    const pluginCmds = COMMANDS.filter((c) => c.name.startsWith("plugin "));
    assert.ok(pluginCmds.length >= 9);
    const readonly = new Set(["plugin list", "plugin show", "plugin check"]);
    for (const cmd of pluginCmds) {
      const refusal = agentRefusal({ cmd, values: {}, named: {}, attachmentDir: "" });
      if (readonly.has(cmd.name)) assert.equal(refusal, null, `${cmd.name} should stay readable`);
      else assert.ok(refusal, `${cmd.name} must be refused to Ask Etude`);
    }
  });
});
