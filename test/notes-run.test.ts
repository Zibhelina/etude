import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { createApp } from "../src/server/app.ts";
import { runFrameHtml, runLanguage } from "../src/core/run-frame.ts";
import { mediaType } from "../src/core/media.ts";
import { docToHtml, docToMarkdown } from "../src/core/notes-md.ts";

test("code blocks: which languages run, and the run frame is sandboxed and only reaches Pyodide", async (t) => {
  assert.equal(runLanguage("Python"), "python");
  assert.equal(runLanguage("js"), "js");
  assert.equal(runLanguage("rust"), null);
  assert.equal(runLanguage(null), null);

  const html = runFrameHtml("http://127.0.0.1:4610/");
  const csp = /content="([^"]+)"/.exec(html)![1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src http:\/\/127\.0\.0\.1:4610\/runtime\/pyodide\//);
  assert.doesNotMatch(csp, /connect-src[^;]*\/api/);
  // Without a server there's no Python and nothing to connect to.
  assert.match(/content="([^"]+)"/.exec(runFrameHtml(null))![1], /connect-src 'none'/);

  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-run-"));
  const e = await Etude.open(join(dir, "etude.db"), { home: join(dir, "home") });
  t.after(() => {
    e.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const app = createApp(e);
  const frame = await app.request("/frame/run");
  assert.equal(frame.status, 200);
  assert.equal(frame.headers.get("content-security-policy"), "sandbox allow-scripts");
  const core = await app.request("/runtime/pyodide/pyodide.mjs");
  assert.equal(core.status, 200);
  assert.equal(core.headers.get("access-control-allow-origin"), "*");
  // Only Pyodide's own files and packages from its lock file: nothing else is fetched or served.
  for (const bad of ["evil.txt", "..%2Fpackage.json", "not-a-package-1.0-py3-none-any.whl"]) assert.equal((await app.request(`/runtime/pyodide/${bad}`)).status, 404, bad);
  assert.equal((await app.request("/runtime/pdfjs/standard_fonts/FoxitDingbats.pfb")).status, 200);
  assert.equal((await app.request("/runtime/pdfjs/build/pdf.mjs")).status, 404);
});

test("PDFs are media; video and PDF blocks and HTML blocks export", () => {
  assert.deepEqual(mediaType("Notes.PDF"), { mime: "application/pdf", kind: "document", extension: ".pdf" });
  const doc = {
    type: "doc",
    content: [
      { type: "htmlEmbed", attrs: { html: '<b id="x">hi</b>' } },
      { type: "noteVideo", attrs: { src: "/media/files/a.mp4" } },
      { type: "notePdf", attrs: { src: "/media/files/b.pdf", name: "Slides.pdf" } },
    ],
  };
  const md = docToMarkdown(doc as any, "T");
  assert.match(md, /<b id="x">hi<\/b>/);
  assert.match(md, /<video src="\/media\/files\/a\.mp4" controls><\/video>/);
  assert.match(md, /\[Slides\.pdf\]\(\/media\/files\/b\.pdf\)/);
  const html = docToHtml(doc as any, "T");
  // The HTML block stays sandboxed in the exported page.
  assert.match(html, /<iframe class="embed" sandbox="allow-scripts" srcdoc="&lt;b id=&quot;x&quot;&gt;hi&lt;\/b&gt;">/);
  assert.match(html, /<a href="\/media\/files\/b\.pdf">Slides\.pdf<\/a>/);
});
