import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import createDOMPurify from "dompurify";
import { renderMarkdown } from "../web/src/lib/render-markdown.ts";

// The browser build uses window's DOMPurify; here it runs on jsdom, with the same config and hooks.
const { window } = new JSDOM("<!doctype html><html><body></body></html>");
const purify = createDOMPurify(window as any);
const md = (s: string) => renderMarkdown(s, purify);

/** Parses rendered HTML and lists anything that could run script or escape the description box. */
function dangers(html: string): string[] {
  const doc = new JSDOM(`<!doctype html><body><div id=r>${html}</div></body>`).window.document;
  const out: string[] = [];
  for (const el of doc.querySelectorAll("#r *")) {
    const tag = el.tagName.toLowerCase();
    if (["script", "iframe", "frame", "object", "embed", "style", "form", "link", "meta", "base", "svg", "math", "template", "textarea", "select", "button", "video", "audio"].includes(tag) && !el.closest(".katex")) out.push(`<${tag}>`);
    for (const a of el.attributes) {
      if (/^on/i.test(a.name)) out.push(`${tag}.${a.name}`);
      if (a.name === "style" && !el.closest(".katex")) out.push(`${tag}.style`);
      if (["id", "name", "srcdoc", "formaction", "action", "xlink:href", "srcset"].includes(a.name)) out.push(`${tag}.${a.name}`);
      if (["href", "src"].includes(a.name) && /^\s*(?:javascript|vbscript|data:text|data:image\/svg)/i.test(a.value.replace(/[\s\u0000-\u001f]/g, ""))) out.push(`${tag}.${a.name}=${a.value}`);
    }
  }
  return out;
}

const PAYLOADS: [string, string][] = [
  ["audit repro: single-quoted onerror", `<img src=x onerror='document.title=1337'>`],
  ["double-quoted onerror", `<img src="x" onerror="alert(1)">`],
  ["unquoted onerror", `<img src=x onerror=alert(1)>`],
  ["svg onload", `<svg onload=alert(1)><circle r=1></circle></svg>`],
  ["svg with script", `<svg><script>alert(1)</script></svg>`],
  ["iframe srcdoc", `<iframe srcdoc="<script>parent.alert(1)</script>"></iframe>`],
  ["iframe javascript src", `<iframe src="javascript:alert(1)"></iframe>`],
  ["script tag", `<script>alert(1)</script>`],
  ["javascript: href", `<a href="javascript:alert(1)">x</a>`],
  ["javascript: href with entities", `<a href="jav&#x09;ascript:alert(1)">x</a>`],
  ["javascript: href mixed case", `<a href="JaVaScRiPt:alert(1)">x</a>`],
  ["markdown javascript link", `[click](javascript:alert(1))`],
  ["markdown data link", `[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)`],
  ["vbscript href", `<a href="vbscript:msgbox(1)">x</a>`],
  ["style element", `<style>body{display:none}</style>`],
  ["style attribute overlay", `<div style="position:fixed;inset:0;background:red;z-index:9999">fake screen</div>`],
  ["details ontoggle", `<details open ontoggle=alert(1)>x</details>`],
  ["form action", `<form action="javascript:alert(1)"><button>go</button></form>`],
  ["button formaction", `<button formaction="javascript:alert(1)">go</button>`],
  ["object data", `<object data="javascript:alert(1)"></object>`],
  ["embed", `<embed src="javascript:alert(1)">`],
  ["meta refresh", `<meta http-equiv="refresh" content="0;url=javascript:alert(1)">`],
  ["base href", `<base href="https://evil.example/">`],
  ["link import", `<link rel="stylesheet" href="https://evil.example/x.css">`],
  ["math xlink", `<math><mi xlink:href="javascript:alert(1)">m</mi></math>`],
  ["dom clobbering id", `<img id="ETUDE_CONFIG" name="ETUDE_CONFIG" src="/x.png">`],
  ["img svg data uri", `<img src="data:image/svg+xml,<svg onload=alert(1)>">`],
  ["video onerror", `<video src=x onerror=alert(1)></video>`],
  ["textarea break-out", `<textarea><img src=x onerror=alert(1)></textarea>`],
  ["noscript mXSS", `<noscript><p title="</noscript><img src=x onerror=alert(1)>">`],
  ["template", `<template><img src=x onerror=alert(1)></template>`],
  ["input autofocus onfocus", `<input autofocus onfocus=alert(1)>`],
  ["math placeholder smuggling", "\uE0000\uE001 <a href=\"\uE0000\uE001\">x</a> $x$"],
  ["katex \\href", `$\\href{javascript:alert(1)}{x}$`],
  ["katex \\htmlData", `$\\htmlData{foo=bar}{x}$`],
];

for (const [name, payload] of PAYLOADS) {
  test(`markdown sanitize: ${name}`, () => {
    const html = md(`Before.\n\n${payload}\n\nAfter.`);
    assert.deepEqual(dangers(html), [], html);
    assert.match(html, /Before\./);
    assert.match(html, /After\./);
  });
}

test("markdown sanitize: formatting, math, code and links still render", () => {
  const html = md(
    [
      "# Title",
      "**bold** _em_ ~~gone~~ and a [real link](https://example.com) and [a deck](/deck?name=Spanish).",
      "",
      "Inline $\\frac{a}{b}$ and display:",
      "",
      "$$x^2$$",
      "",
      "`code $x$` and",
      "",
      "```python\nprint('$5')\n```",
      "",
      "| a | b |\n|---|---|\n| 1 | 2 |",
      "",
      "- [x] done\n- [ ] todo",
      "",
      "![pic](/media/files/abc.png) <sub>low</sub><kbd>K</kbd>",
    ].join("\n"),
  );
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">real link<\/a>/);
  assert.match(html, /<a href="\/deck\?name=Spanish">a deck<\/a>/);
  assert.match(html, /class="katex"/);
  assert.match(html, /class="katex-display"/);
  assert.match(html, /<code>code \$x\$<\/code>/);
  assert.match(html, /<pre><code class="language-python">print\('\$5'\)/);
  assert.match(html, /<table>/);
  assert.match(html, /<input (?=[^>]*type="checkbox")(?=[^>]*disabled)[^>]*>/);
  assert.match(html, /<img src="\/media\/files\/abc.png" alt="pic">/);
  assert.match(html, /<sub>low<\/sub><kbd>K<\/kbd>/);
  assert.deepEqual(dangers(html), []);
});

test("markdown sanitize: KaTeX output is put back only in text, never inside an attribute", () => {
  const html = md(`<a href="https://x.example/\uE0000\uE001">x</a> $y$`);
  assert.doesNotMatch(html, /href="[^"]*katex/);
  assert.equal((html.match(/class="katex"/g) ?? []).length, 1);
});
