import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushViewCommand, readViewState, viewCommandsAfter, viewDir, writeViewState } from "../src/core/view-remote.ts";
import { run } from "../src/cli/run.ts";

function scratch() {
  const home = mkdtempSync(join(tmpdir(), "etude-view-"));
  return { home, db: join(home, "etude.db"), done: () => rmSync(home, { recursive: true, force: true }) };
}

async function cli(home: string, db: string, argv: string[]) {
  let out = "", err = "";
  const code = await run(["--db", db, ...argv], { stdout: (s) => (out += s), stderr: (s) => (err += s), stdin: () => "", isTTY: false, env: { ...process.env, ETUDE_HOME: home } });
  return { code, json: out.trim() ? JSON.parse(out) : null, err };
}

test("view commands queue in order, and only fresh ones are handed out", () => {
  const s = scratch();
  try {
    const dir = viewDir(s.home, s.db);
    assert.equal(viewCommandsAfter(dir, 0).seq, 0);
    const a = pushViewCommand(dir, { action: "open", note: "n1", where: "right" });
    const b = pushViewCommand(dir, { action: "close", target: { pane: 2 } });
    assert.deepEqual([a, b], [1, 2]);
    assert.deepEqual(viewCommandsAfter(dir, 1).commands.map((c) => c.action), ["close"]);
    assert.equal(viewCommandsAfter(dir, 2).commands.length, 0);
    // Another collection in the same home has its own queue.
    assert.equal(viewCommandsAfter(viewDir(s.home, s.db + "2"), 0).seq, 0);
  } finally {
    s.done();
  }
});

test("view state says whether the app is live", () => {
  const s = scratch();
  try {
    const dir = viewDir(s.home, s.db);
    assert.equal(readViewState(dir), null);
    writeViewState(dir, { route: "/notes", panes: [{ n: 1, focused: true, front: null, tabs: [] }], applied: 3 });
    const st = readViewState(dir)!;
    assert.equal(st.live, true);
    assert.equal(st.applied, 3);
  } finally {
    s.done();
  }
});

test("etude view: show works without the app, open refuses when it isn't open", async () => {
  const s = scratch();
  try {
    const shown = await cli(s.home, s.db, ["view", "show"]);
    assert.equal(shown.code, 0);
    assert.equal(shown.json.live, false);
    await cli(s.home, s.db, ["note", "new", "Week 3"]);
    const r = await cli(s.home, s.db, ["view", "open", "Week 3", "--where", "right"]);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /isn't open/);
  } finally {
    s.done();
  }
});

test("etude view open queues the command for a live app and reports what it shows after", async () => {
  const s = scratch();
  try {
    const page = (await cli(s.home, s.db, ["note", "new", "Week 3"])).json;
    const dir = viewDir(s.home, s.db);
    writeViewState(dir, { route: "/notes", panes: [{ n: 1, focused: true, front: null, tabs: [] }] });
    // The app: picks the command up and says it carried it out.
    const app = setInterval(() => {
      const r = viewCommandsAfter(dir, 0);
      if (r.commands.length) writeViewState(dir, { route: "/notes", panes: [{ n: 1, focused: false, front: null, tabs: [] }, { n: 2, focused: true, front: { id: page.id, kind: "page", title: "Week 3" }, tabs: [] }], applied: r.seq });
    }, 50);
    const r = await cli(s.home, s.db, ["view", "open", "Week 3", "--where", "right", "--beside", "1"]);
    clearInterval(app);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.done, true);
    assert.equal(r.json.view.panes[1].front.id, page.id);
    const q = viewCommandsAfter(dir, 0).commands[0];
    assert.deepEqual({ action: q.action, note: (q as { note: string }).note, where: (q as { where: string }).where, beside: (q as { beside: unknown }).beside }, { action: "open", note: page.id, where: "right", beside: { pane: 1 } });
  } finally {
    s.done();
  }
});

test("etude view queues tab, group, sidebar and panel commands in the shapes the app reads", async () => {
  const s = scratch();
  try {
    const a = (await cli(s.home, s.db, ["note", "new", "Week 1"])).json;
    const b = (await cli(s.home, s.db, ["note", "new", "Week 2"])).json;
    const dir = viewDir(s.home, s.db);
    writeViewState(dir, { route: "/notes", panes: [{ n: 1, focused: true, front: null, tabs: [] }] });
    // The app: carries out everything at once.
    const app = setInterval(() => {
      const r = viewCommandsAfter(dir, 0);
      if (r.commands.length) writeViewState(dir, { route: "/notes", panes: [{ n: 1, focused: true, front: null, tabs: [] }], applied: r.seq });
    }, 30);
    const runs: [string[], object][] = [
      [["view", "open"], { action: "open", where: "tab" }],
      [["view", "pin", "Week 1"], { action: "pin", tab: a.id, on: true }],
      [["view", "pin", "Week 1", "--off"], { action: "pin", tab: a.id, on: false }],
      [["view", "icon", "Week 1", "🧪"], { action: "icon", tab: a.id, icon: "emoji:🧪" }],
      [["view", "group", "Week 1", "Week 2", "--name", "CMPT 361", "--color", "blue"], { action: "group", tabs: [a.id, b.id], name: "CMPT 361", color: "blue" }],
      [["view", "group-edit", "CMPT 361", "--fold"], { action: "group-edit", group: "CMPT 361", collapsed: true }],
      [["view", "ungroup", "--tab", "Week 2"], { action: "ungroup", tab: b.id }],
      [["view", "move", "Week 2", "--to", "1", "--side", "bottom"], { action: "move", tab: b.id, to: { pane: 1 }, before: null, side: "bottom" }],
      [["view", "move", "chat:abc", "--to", "panel"], { action: "move", tab: "chat:abc", to: { panel: true }, before: null }],
      [["view", "resize", "2", "40%"], { action: "resize", target: { pane: 2 }, size: 0.4 }],
      [["view", "sidebar", "rail"], { action: "sidebar", mode: "rail" }],
      [["view", "pages", "hide"], { action: "pages", open: false }],
      [["view", "panel", "close"], { action: "panel", open: false }],
      [["view", "go", "stats"], { action: "go", route: "/stats" }],
    ];
    for (const [argv, want] of runs) {
      const r = await cli(s.home, s.db, argv);
      assert.equal(r.code, 0, `${argv.join(" ")}: ${r.err}`);
      const q = viewCommandsAfter(dir, 0).commands.at(-1)! as Record<string, unknown>;
      const { seq: _s, at: _a, ...got } = q;
      assert.deepEqual(got, want, argv.join(" "));
    }
    clearInterval(app);
    const bad = await cli(s.home, s.db, ["view", "group", "Week 1", "--color", "beige"]);
    assert.notEqual(bad.code, 0);
    assert.match(bad.err, /colour/);
  } finally {
    s.done();
  }
});

test("etude view shows the app's reason when it can't carry a command out", async () => {
  const s = scratch();
  try {
    await cli(s.home, s.db, ["note", "new", "Week 1"]);
    const dir = viewDir(s.home, s.db);
    writeViewState(dir, { route: "/notes", panes: [{ n: 1, focused: true, front: null, tabs: [] }] });
    const app = setInterval(() => {
      const r = viewCommandsAfter(dir, 0);
      if (r.commands.length) writeViewState(dir, { route: "/notes", panes: [], applied: r.seq, failed: { seq: r.seq, error: "only a pinned tab has an icon of its own: pin it first" } });
    }, 30);
    const r = await cli(s.home, s.db, ["view", "icon", "Week 1", "🧪"]);
    clearInterval(app);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /pin it first/);
  } finally {
    s.done();
  }
});
