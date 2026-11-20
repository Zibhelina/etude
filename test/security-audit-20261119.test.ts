import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { agentRefusal, mcpRefusal } from "../src/core/agent-guard.ts";
import { parseInvocation, resolveCommand, run, wantsHelp } from "../src/cli/run.ts";
import { sessionDeleteCommand } from "../src/core/acp.ts";
import { pluginViewFrame } from "../src/server/frame.ts";
import "../src/cli/commands/index.ts";

function makeTemp() {
  const dir = mkdtempSync(join(tmpdir(), "etude-sec-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("2026-11-19 security audit regression tests", () => {
  it("H-1: blocks all 7 local file read bypasses in Ask Etude while allowing attached files", async () => {
    const tmp = makeTemp();
    try {
      const attachDir = join(tmp.dir, "attachments");
      mkdirSync(attachDir, { recursive: true });
      const secret = join(tmp.dir, "secret.txt");
      const secretImg = join(tmp.dir, "secret.png");
      const okFile = join(attachDir, "ok.txt");
      writeFileSync(secret, "TOP_SECRET_VALUE");
      writeFileSync(secretImg, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      writeFileSync(okFile, "ATTACHED_OK");

      const check = (argv: string[]) => {
        const inv = parseInvocation(argv);
        assert.ok(inv, `should parse ${argv.join(" ")}`);
        return agentRefusal({ cmd: inv.cmd, values: inv.values, named: inv.named, extra: inv.extra, attachmentDir: attachDir });
      };

      // 1. Dynamic --<field>-file
      assert.ok(check(["item", "add", "--deck", "D", "--front-file", secret, "--back", "x"]));
      assert.equal(check(["item", "add", "--deck", "D", "--front-file", okFile, "--back", "x"]), null);

      // 2. --set-file field=path
      assert.ok(check(["item", "add", "--deck", "D", "--set-file", `front=${secret}`, "--back", "x"]));
      assert.equal(check(["item", "add", "--deck", "D", "--set-file", `front=${okFile}`, "--back", "x"]), null);

      // 3. note import <paths...>
      assert.ok(check(["note", "import", secret]));
      assert.equal(check(["note", "import", okFile]), null);

      // 4. note new --pdf
      assert.ok(check(["note", "new", "Doc", "--pdf", secret]));

      // 5. note new --cover <local file> (presets stay allowed)
      assert.ok(check(["note", "new", "Doc", "--cover", secretImg]));
      assert.equal(check(["note", "new", "Doc", "--cover", "sky"]), null);

      // 6. settings avatar/banner set photo:/image:
      assert.ok(check(["settings", "avatar", "set", `photo:${secretImg}`]));
      assert.ok(check(["settings", "banner", "set", `image:${secretImg}`]));
      assert.equal(check(["settings", "avatar", "set", "fox"]), null);

      // 7. Markdown image auto-import via mdContext when ctx.agent is true
      const e = await Etude.open(join(tmp.dir, "etude.db"), { home: tmp.dir });
      let err = "";
      const code = await run(
        ["note", "new", "Injected", "--md", `![leak](${secretImg})`],
        { stdout: () => {}, stderr: (s) => (err += s), stdin: () => "", isTTY: false, env: process.env },
        { etude: e, agent: true, attachmentDir: attachDir },
      );
      assert.notEqual(code, 0);
      assert.match(err, /attached/i);
      e.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("H-2: prevents --help / --dry-run smuggling after -- or as flag values", () => {
    const noteNew = resolveCommand(["note", "new"])!;
    assert.equal(wantsHelp(["note", "new", "--help"], noteNew), true);
    assert.equal(wantsHelp(["note", "new", "--", "--help"], noteNew), false);
    assert.equal(wantsHelp(["note", "new", "--parent", "--help", "Title"], noteNew), false);
    const inv = parseInvocation(["note", "new", "--parent", "--dry-run", "Title"]);
    assert.ok(inv);
    assert.equal(inv.values["dry-run"], undefined);
  });

  it("H-3 & H-4: guards share, plugin, activity, folder, sync writes on both Ask Etude and MCP", () => {
    const blocked = [
      ["share", "create", "Notes"],
      ["share", "invite", "Notes", "a@b.com"],
      ["share", "accept", "spc_1"],
      ["plugin", "install", "pomodoro"],
      ["plugin", "enable", "pomodoro"],
      ["activity", "on"],
      ["folder", "open", "/tmp"],
      ["folder", "sync", "on", "f1"],
      ["sync", "setup", "--folder", "/tmp"],
      ["settings", "chatgpt", "import", "/tmp/x.json"],
      ["media", "prune"],
    ];
    for (const argv of blocked) {
      const cmd = resolveCommand(argv)!;
      assert.ok(cmd, `command exists: ${argv.join(" ")}`);
      assert.ok(mcpRefusal(cmd), `MCP must refuse ${cmd.name}`);
      if (cmd.name !== "settings chatgpt import" && cmd.name !== "media prune") {
        assert.ok(agentRefusal({ cmd, values: {}, named: {}, attachmentDir: "/tmp" }), `Ask must refuse ${cmd.name}`);
      }
    }
    // Read-only share/plugin/activity/sync commands stay allowed
    for (const argv of [["share", "list"], ["plugin", "list"], ["activity", "status"], ["sync", "status"]]) {
      const cmd = resolveCommand(argv)!;
      assert.ok(cmd, `command exists: ${argv.join(" ")}`);
      assert.equal(mcpRefusal(cmd), null, `MCP should allow read-only ${cmd.name}`);
    }
  });

  it("M-1: blocks symlink escape, dotfile creation, and dotfile resolveLink in open local folders", async () => {
    const tmp = makeTemp();
    try {
      const folderDir = join(tmp.dir, "vault");
      const outside = join(tmp.dir, "outside");
      mkdirSync(folderDir, { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "secret.md"), "SECRET");
      writeFileSync(join(folderDir, ".env"), "API_KEY=123");
      symlinkSync(outside, join(folderDir, "link-out"));

      const e = await Etude.open(join(tmp.dir, "etude.db"), { home: tmp.dir });
      const opened = e.folders.open(folderDir);
      const rootId = `fs:${opened.id}`;

      // Symlink escape refused
      assert.throws(() => e.folders.get(`fs:${opened.id}/link-out/secret.md`), /leaves the folder/i);

      // Creating dotfile when hidden=false refused BEFORE writing
      assert.throws(() => e.folders.create(rootId, { kind: "file", title: ".hidden-file", content: "x" }), /dot/i);

      // resolveLink does not expose .env when hidden=false
      const resolved = await e.folders.resolveLink(rootId, ".env");
      assert.equal(resolved, null);

      // relocate sanitizes name and blocks dotfile target
      const normal = e.folders.create(rootId, { kind: "file", title: "ok.md", content: "hi" });
      assert.throws(() => e.folders.relocate(normal.id, rootId, ".env2"), /dot/i);
      e.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("M-3 & Track B: rejects option-injected sessionId and scripts placed before <head> in plugin views", () => {
    const def = { id: "h", name: "Hermes", command: "hermes", args: ["acp"], preset: "hermes" as const };
    assert.equal(sessionDeleteCommand(def, "--all"), null);
    assert.equal(sessionDeleteCommand(def, "abc\n--all"), null);
    const ok = sessionDeleteCommand(def, "sess_123");
    assert.deepEqual(ok?.args, ["sessions", "delete", "--yes", "sess_123"]);

    const sneaky = `<script>alert(1)</script><head></head><body>hi</body>`;
    const rendered = pluginViewFrame("p1", "v1", sneaky, []);
    const cspPos = rendered.indexOf("Content-Security-Policy");
    const alertPos = rendered.indexOf("alert(1)");
    assert.ok(cspPos > 0 && cspPos < alertPos, "host CSP must precede any author script");
  });

  it("L-1: redacts external agent env values for Ask and MCP while keeping them for the user CLI", async () => {
    const tmp = makeTemp();
    try {
      const e = await Etude.open(join(tmp.dir, "etude.db"), { home: tmp.dir });
      e.updateSettings({
        ai: {
          ...e.settings().ai,
          agents: [{ id: "ext1", name: "Ext", command: "echo", args: [], env: { MY_SECRET: "super-secret-token" } }],
        } as any,
      });
      let agentOut = "";
      await run(["settings", "get"], { stdout: (s) => (agentOut += s), stderr: () => {}, stdin: () => "", isTTY: false, env: process.env }, { etude: e, agent: true });
      assert.ok(!agentOut.includes("super-secret-token"), "agent must not receive plaintext agent env values");
      assert.ok(agentOut.includes("[redacted]"));

      let userOut = "";
      await run(["settings", "get"], { stdout: (s) => (userOut += s), stderr: () => {}, stdin: () => "", isTTY: false, env: process.env }, { etude: e });
      assert.ok(userOut.includes("super-secret-token"), "user CLI still sees configured env");
      e.close();
    } finally {
      tmp.cleanup();
    }
  });
});
