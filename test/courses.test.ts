import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { checkCourse, courseHash, coursesFor, loadCourseSource, packageFromHtml } from "../src/core/courses.ts";
import { buildIndex, buildSubmission, checkEntry, entryJson, installEntry, installFile, installState } from "../src/core/market.ts";
import { courseFrame } from "../src/server/frame.ts";
import { createApp } from "../src/server/app.ts";
import { run } from "../src/cli/run.ts";
import "../src/cli/commands/index.ts";

function makeTemp() {
  const dir = mkdtempSync(join(tmpdir(), "etude-courses-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const SAMPLE_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Tiny Circuits</title></head>
<body><h1>Tiny Circuits</h1><p>Lesson 1</p></body>
</html>`;

const KIT_HTML = `<!doctype html>
<html lang="en" data-theme="dark">
<head><meta charset="utf-8"><meta name="generator" content="Etude Course Kit 1.0"><title>Kit Sample</title></head>
<body><script>window.COURSE = {"id":"kit-sample","title":"Kit Sample","subtitle":"CS 101","summary":"Learn step by step.","ui":"en","units":[{"id":"u1","label":"Unit 1","title":"Basics","lessons":[{"id":"l1","short":"Lesson 1"},{"id":"l2","short":"Lesson 2"}]}]};\nwindow.COURSE_KIT_MINIMI = {};</script></body>
</html>`;

describe("courses: core store, plain HTML & Course Kit, Market, API and CLI", () => {
  it("imports plain HTML and Course Kit folders, persists progress and serves sandboxed theme-bridged frame", async () => {
    const tmp = makeTemp();
    try {
      const e = await Etude.open(join(tmp.dir, "etude.db"), { home: tmp.dir });
      const store = coursesFor(e);

      // 1. Plain HTML import (no Course Kit needed)
      const plainPkg = packageFromHtml(SAMPLE_HTML, { id: "tiny-circuits", author: "Alice" });
      assert.deepEqual(checkCourse(plainPkg), []);
      const r1 = store.install(plainPkg);
      assert.equal(r1.status, "installed");
      assert.equal(r1.course.manifest.name, "Tiny Circuits");

      // Re-installing identical content is unchanged
      assert.equal(store.install(plainPkg).status, "unchanged");

      // 2. Course Kit folder import auto-detects units/lessons/subtitle
      const folder = join(tmp.dir, "kit-course");
      mkdirSync(folder);
      writeFileSync(join(folder, "course.json"), JSON.stringify({ id: "kit-sample", title: "Kit Sample", subtitle: "CS 101", summary: "Learn step by step." }));
      writeFileSync(join(folder, "index.html"), KIT_HTML);
      const kitPkg = loadCourseSource(folder);
      assert.equal(kitPkg.manifest.id, "kit-sample");
      assert.equal(kitPkg.manifest.subtitle, "CS 101");
      assert.equal(kitPkg.manifest.lessons?.length, 2);
      assert.equal(kitPkg.manifest.units?.[0], "Unit 1 · Basics");
      assert.equal(kitPkg.manifest.kit, "Etude Course Kit 1.0");

      const r2 = store.install(kitPkg);
      assert.equal(r2.status, "installed");
      assert.equal(store.list().length, 2);

      // 3. Progress persistence & reset
      const prog = store.saveProgress("kit-sample", {
        state: { cur: "l1", done: { l1: true } },
        doneCount: 1,
        totalCount: 2,
        minsLeft: 8,
        currentId: "l2",
        currentTitle: "Lesson 2",
      });
      assert.equal(prog.doneCount, 1);
      assert.equal(prog.totalCount, 2);
      assert.equal(prog.minsLeft, 8);
      assert.equal((prog.state as any).cur, "l1");

      // 4. Sandboxed frame injects CSP, host theme slot & etudeCourse bridge
      const html = courseFrame("kit-sample", KIT_HTML, "http://127.0.0.1:4610");
      assert.match(html, /Content-Security-Policy/);
      assert.match(html, /id="etude-host-theme"/);
      assert.match(html, /window\.etudeCourse/);

      // 5. HTTP API routes work end to end
      const app = createApp(e);
      const listRes = await app.request("/api/courses");
      assert.equal(listRes.status, 200);
      const listJson = (await listRes.json()) as any;
      assert.equal(listJson.courses.length, 2);

      const frameRes = await app.request("/frame-course/kit-sample");
      assert.equal(frameRes.status, 200);
      assert.match(await frameRes.text(), /window\.etudeCourse/);

      const putRes = await app.request("/api/courses/kit-sample/progress", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: { cur: "l2", done: { l1: true, l2: true } }, doneCount: 2, totalCount: 2, minsLeft: 0 }),
      });
      assert.equal(putRes.status, 200);
      assert.equal(((await putRes.json()) as any).doneCount, 2);

      store.resetProgress("kit-sample");
      assert.equal(store.getProgress("kit-sample").doneCount, 0);

      store.remove("tiny-circuits");
      assert.equal(store.get("tiny-circuits"), null);
      e.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("publishes, indexes and installs a course through the Market and CLI", async () => {
    const tmp = makeTemp();
    try {
      const e1 = await Etude.open(join(tmp.dir, "author.db"), { home: tmp.dir });
      const pkg = packageFromHtml(KIT_HTML, { author: "Ada" });
      coursesFor(e1).install(pkg);

      // Build Market submission from installed course
      const entry = buildSubmission(e1, { kind: "course", ref: "kit-sample", author: "Ada", tags: ["cs", "intro"], version: "1.0.0" });
      assert.deepEqual(checkEntry(entry), []);
      assert.equal(entry.kind, "course");
      assert.equal(entry.content.hash, courseHash(pkg));

      // Write into a local Market repo and index it
      const marketDir = join(tmp.dir, "market");
      mkdirSync(join(marketDir, "entries", "courses"), { recursive: true });
      writeFileSync(join(marketDir, "entries", "courses", `${entry.id}.json`), entryJson(entry));
      const { index, problems } = await buildIndex(marketDir);
      assert.deepEqual(problems, []);
      assert.equal(index.entries.length, 1);
      assert.equal(index.entries[0].kind, "course");
      assert.equal((index.entries[0].summary as any).course.lessons, 2);
      writeFileSync(join(marketDir, "index.json"), JSON.stringify(index, null, 2));

      // Install into a fresh collection from that Market
      const e2 = await Etude.open(join(tmp.dir, "learner.db"), { home: tmp.dir });
      const res = await installEntry(e2, "kit-sample", { url: marketDir, kind: "course" });
      assert.equal(res.result, "created");
      assert.equal(coursesFor(e2).get("kit-sample")?.source, "market");
      assert.equal(installState(e2, index.entries[0]), "installed");

      // Deleting the course makes Market offer it again (installGone)
      coursesFor(e2).remove("kit-sample");
      assert.equal(installState(e2, index.entries[0]), null);

      // Re-installing via installFile works
      const res2 = installFile(e2, entry);
      assert.equal(res2.result, "created");
      assert.ok(coursesFor(e2).get("kit-sample"));

      // CLI course list / show
      let out = "";
      const code = await run(
        ["course", "list"],
        { stdout: (s) => (out += s), stderr: () => {}, stdin: () => "", isTTY: false, env: process.env },
        { etude: e2 },
      );
      assert.equal(code, 0);
      assert.equal(JSON.parse(out).length, 1);

      e1.close();
      e2.close();
    } finally {
      tmp.cleanup();
    }
  });
});
