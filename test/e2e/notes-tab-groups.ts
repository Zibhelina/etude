// Tabs in the Notebook: pinned ones and groups (named, coloured, folded), kept across a reload. Through the real UI: `etude serve` on a scratch
// collection with the scripted ACP agent (test/fixtures/fake-acp-agent.mjs), driven in Chromium. Not part of
// `npm test` (it needs Chromium, playwright-core and a built web app). From an etude2 worktree:
//   npm run build && node test/e2e/notes-tab-groups.ts [<screenshot dir>]
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { Etude } from "../../src/core/engine.ts";
import { run } from "../../src/cli/run.ts";
const require = createRequire(join(process.env.PLAYWRIGHT_FROM ?? process.cwd(), "package.json"));
const { chromium } = require("playwright-core");

const WT = resolve(import.meta.dirname, "../..");
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "tab-groups-"));
const SHOTS = process.argv[2] ?? join(scratch, "shots");
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });

const db = join(scratch, "etude.db");
const ids: Record<string, string> = {};
{
  const e = await Etude.open(db, { home: scratch });
  e.updateSettings({ ai: { ...e.settings().ai, agents: [{ id: "fake", name: "Fakey", command: process.execPath, args: [join(WT, "test/fixtures/fake-acp-agent.mjs")] }] }, onboarding: { ...e.settings().onboarding, done: true } });
  e.addAgentProfile({ id: "p-fake", name: "Fakey", brain: { kind: "external", agent: "fake" } });
  e.setDefaultAgentProfile("p-fake");
  const make = async (key: string, argv: string[]) => {
    let out = "";
    assert.equal(await run(["note", "new", ...argv, "--json"], { stdout: (x) => (out += x), stderr: (x) => process.stderr.write(x), stdin: () => "", isTTY: false, env: process.env }, { etude: e }), 0);
    const r = JSON.parse(out);
    ids[key] = r.id ?? r.note?.id;
    assert.ok(ids[key], `made ${key}`);
  };
  await make("folder", ["Course", "--folder"]);
  await make("inside", ["Lecture one", "--parent", "Course", "--text", "First line."]);
  await make("other", ["Reading list", "--text", "A book."]);
  await make("third", ["Problem set", "--text", "Q1."]);
  await make("fourth", ["Formula sheet", "--text", "E = mc2."]);
  e.close();
}
const server = spawn(process.execPath, ["src/cli/main.ts", "--db", db, "serve", "--port", String(port)], { cwd: WT, env: { ...process.env, ETUDE_HOME: scratch }, stdio: ["ignore", "ignore", "inherit"] });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) { if (await fetch(base + "/api/agent/profiles").then((r) => r.ok, () => false)) break; await sleep(150); }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/sbin/chromium" });
let failed = false;
let page: any;
try {
  page = await browser.newPage({ viewport: { width: 1900, height: 900 }, colorScheme: (process.env.SCHEME as any) ?? "dark" });
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.addInitScript(() => {
    try {
      if (!localStorage.getItem("etude.agent.open")) localStorage.setItem("etude.agent.open", "1");
    } catch {}
  });
  const shot = (name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
  const tabs = () => page.locator(".note-tab").evaluateAll((els: HTMLElement[]) => els.map((x) => x.dataset.tab));
  const row = (id: string) => page.locator(`[role=tree] [data-note-row="${id}"]`).first();

  await page.goto(`${base}/notes?id=${ids.inside}`);
  await page.getByText("Skip", { exact: true }).click({ timeout: 2500 }).catch(() => {});
  await page.locator("[data-pane] .note-title").first().waitFor();
  for (const k of ["other", "third", "fourth"]) {
    await row(ids[k]).click({ modifiers: ["Control"] });
    await page.locator(`.note-tab[data-tab="${ids[k]}"]`).waitFor();
  }
  const tab = (k: string) => page.locator(`.note-tab[data-tab="${ids[k]}"]`);
  const menu = async (k: string, item: string | RegExp) => {
    await tab(k).click({ button: "right" });
    await page.getByRole("menuitem", { name: item }).click();
    await sleep(250);
  };
  const order = async () => (await tabs()).map((t: string) => Object.keys(ids).find((k) => ids[k] === t) ?? t);
  await shot("0-plain");

  // ---- pin: small, first, no ×, and a click on a page doesn't replace it.
  await menu("third", "Pin");
  assert.deepEqual((await order()).slice(0, 1), ["third"]);
  const w = (await tab("third").boundingBox())!.width;
  assert.ok(w < 50, `a pinned tab is icon-sized: ${w}`);
  assert.equal(await tab("third").locator(".note-tab-x").isVisible(), false);
  await tab("third").click();
  await row(ids.other).click();
  await sleep(200);
  assert.ok((await tabs()).includes(ids.third), "the pinned page is still open");

  // ---- a group: made from a tab's menu, named in the card that opens, coloured, joined by another tab.
  await menu("inside", "Add to new group");
  const card = page.locator("[data-tab-group-card]");
  await card.waitFor();
  await page.keyboard.type("Course");
  await card.locator("[data-color=pink]").click();
  await shot("1-group-card");
  await page.keyboard.press("Escape");
  await card.waitFor({ state: "detached" });
  const chip = page.locator("[data-tab-group]").first();
  assert.equal((await chip.innerText()).trim(), "Course");
  await menu("fourth", "Add to Course");
  assert.equal(await page.locator(".note-tab.in-group").count(), 2);
  const o = await order();
  assert.equal(o.indexOf("fourth"), o.indexOf("inside") + 1, `side by side: ${o}`);
  await shot("2-grouped");

  // ---- folded: its tabs hide behind the label, which counts them; unfolded, they're back.
  await tab("other").click();
  await chip.click();
  await tab("inside").waitFor({ state: "detached" }); // they tuck into the label first, then go
  await tab("fourth").waitFor({ state: "detached" });
  assert.equal(await tab("inside").count(), 0);
  assert.equal(await tab("fourth").count(), 0);
  assert.match(await chip.innerText(), /Course\s*2/);
  await shot("3-folded");

  // ---- a reload keeps the pin, the group, its name, colour and fold.
  await page.reload();
  await page.locator("[data-pane] .note-title").first().waitFor();
  assert.equal(await tab("third").getAttribute("data-pinned"), "true");
  assert.match(await chip.innerText(), /Course\s*2/);
  assert.equal(await chip.getAttribute("aria-expanded"), "false");
  await chip.click();
  await tab("inside").waitFor();
  assert.equal(await tab("inside").evaluate((el: HTMLElement) => el.style.getPropertyValue("--tg")), "var(--nc-pink)");
  // …and so does a visit to another screen.
  await page.getByRole("button", { name: "Stats", exact: true }).first().click();
  await page.waitForURL(/\/stats/);
  await page.getByRole("button", { name: "Notebook", exact: true }).first().click();
  await tab("inside").waitFor();
  assert.equal(await page.locator(".note-tab.in-group").count(), 2);

  // ---- drag and drop: a tab onto the label joins; onto a tab outside, it leaves; a folded group takes it too.
  const mid = async (loc: any, fx = 0.5) => {
    const b = (await loc.boundingBox())!;
    return { x: b.x + b.width * fx, y: b.y + b.height / 2 };
  };
  const drag = async (from: { x: number; y: number }, to: { x: number; y: number }, midShot?: string) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 10, from.y + 4, { steps: 3 });
    await page.mouse.move(to.x, to.y, { steps: 10 });
    await sleep(200);
    if (midShot) await shot(midShot);
    await page.mouse.up();
    await sleep(350);
  };
  const inGroup = (k: string) => tab(k).getAttribute("data-in-group");
  assert.equal(await inGroup("other"), null);
  await drag(await mid(tab("other")), await mid(chip), "5-drop-on-label");
  assert.ok(await inGroup("other"), "dropped on the label, it's in the group");
  let now = await order();
  assert.equal(now.indexOf("other"), now.indexOf("fourth") + 1, `after the group's last tab: ${now}`);
  // Onto the pinned tab (outside any group): it leaves the group.
  await drag(await mid(tab("other")), await mid(tab("third"), 0.8));
  assert.equal(await inGroup("other"), null);
  // Onto the left half of a tab in the group: it joins, in front of that tab.
  await drag(await mid(tab("other")), await mid(tab("fourth"), 0.25), "6-drop-on-group-tab");
  assert.ok(await inGroup("other"));
  now = await order();
  assert.equal(now.indexOf("other"), now.indexOf("fourth") - 1, `in front of it: ${now}`);
  await menu("other", "Remove from group");
  // A folded group: the label is the only way in.
  await tab("other").click();
  await chip.click();
  await tab("inside").waitFor({ state: "detached" });
  await page.locator(".note-tab-plus").first().click({ force: true });
  await sleep(300);
  await drag(await mid(tab("other")), await mid(chip));
  assert.match(await chip.innerText(), /Course\s*3/);
  await chip.click();
  await tab("other").waitFor();
  assert.ok(await inGroup("other"));
  await menu("other", "Remove from group");

  // ---- the whole group moves by its label; a click on the label still folds.
  now = await order();
  const startTab = page.locator(".note-tab:not(.in-group):not(.is-pinned)").last();
  const end = (await startTab.boundingBox())!;
  await drag(await mid(chip), { x: end.x + end.width - 8, y: end.y + end.height / 2 }, "7-dragging-group");
  now = await order();
  assert.deepEqual(now.slice(-2), ["inside", "fourth"], `the group is last now: ${now}`);
  assert.equal(await chip.getAttribute("aria-expanded"), "true", "the drop wasn't taken for a click");
  await drag(await mid(chip), await mid(tab("other"), 0.2));
  now = await order();
  assert.ok(now.indexOf("inside") < now.indexOf("other"), `back in front: ${now}`);
  await shot("8-group-moved");

  // ---- a pinned tab's own icon.
  await tab("third").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Set an icon…" }).click();
  const picker = page.locator("[data-tab-icon-card]");
  await picker.waitFor();
  await shot("9-icon-picker");
  await picker.locator("button.av-emoji-glyph").nth(3).click();
  await picker.waitFor({ state: "detached" });
  const glyph = (await tab("third").locator(".note-tab-icon").innerText()).trim();
  assert.ok(glyph.length > 0, "the pinned tab shows the emoji");
  await page.reload();
  await page.locator("[data-pane]").first().waitFor();
  await tab("third").waitFor();
  assert.equal((await tab("third").locator(".note-tab-icon").innerText()).trim(), glyph, "kept across a reload");
  await tab("third").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Change icon…" }).click();
  await picker.getByRole("tab", { name: "Illustration" }).click();
  await picker.locator("button img").first().click();
  await picker.waitFor({ state: "detached" });
  assert.equal(await tab("third").locator(".note-tab-icon img").count(), 1, "an illustration works too");
  await shot("10-pinned-icon");

  // ---- a colour of its own: the rainbow swatch opens a small mixer; a hex typed there, or a drag on it, sets it.
  await chip.click({ button: "right" });
  await card.waitFor();
  await card.locator("[data-color=own]").click();
  const mixer = card.locator("[data-group-mixer]");
  await mixer.waitFor();
  await mixer.locator("input").fill("#12abef");
  assert.equal(await chip.evaluate((el: HTMLElement) => el.style.getPropertyValue("--tg")), "#12abef");
  // The wheel is round: around it the hue, toward the middle the paler shades.
  const sv = (await mixer.locator(".note-mix-wheel").boundingBox())!;
  assert.ok(Math.abs(sv.width - sv.height) < 1, "a round wheel");
  assert.equal(await mixer.locator(".note-mix-wheel").evaluate((el: HTMLElement) => getComputedStyle(el).borderRadius), "50%");
  await page.mouse.move(sv.x + sv.width / 2, sv.y + sv.height / 2);
  await page.mouse.down();
  await page.mouse.move(sv.x + sv.width / 2 - 40, sv.y + sv.height / 2 + 30, { steps: 6 });
  await page.mouse.up();
  const mixed = await chip.evaluate((el: HTMLElement) => el.style.getPropertyValue("--tg"));
  assert.ok(/^#[0-9a-f]{6}$/.test(mixed) && mixed !== "#12abef", `dragging on the wheel mixes another colour: ${mixed}`);
  assert.equal(await mixer.locator("input").inputValue(), mixed);
  const bar = (await mixer.locator(".note-mix-bar").boundingBox())!;
  await page.mouse.click(bar.x + bar.width * 0.5, bar.y + bar.height / 2);
  const darker = await chip.evaluate((el: HTMLElement) => el.style.getPropertyValue("--tg"));
  assert.notEqual(darker, mixed, "the bar under it sets the brightness");
  await page.mouse.click(bar.x + bar.width * 0.9, bar.y + bar.height / 2);
  const kept = await chip.evaluate((el: HTMLElement) => el.style.getPropertyValue("--tg"));
  await shot("11-own-colour");
  await page.keyboard.press("Escape");
  await card.waitFor({ state: "detached" });
  await page.reload();
  await page.locator("[data-pane]").first().waitFor();
  assert.equal(await chip.evaluate((el: HTMLElement) => el.style.getPropertyValue("--tg")), kept, "kept across a reload");

  // ---- pinned tabs move: among themselves, and to another pane, where they stay pinned.
  await menu("other", "Pin");
  now = await order();
  assert.deepEqual(now.slice(0, 2), ["third", "other"]);
  await drag(await mid(tab("third")), await mid(tab("other"), 0.8), "12-dragging-pin");
  now = await order();
  assert.deepEqual(now.slice(0, 2), ["other", "third"], `the pins swapped: ${now}`);
  assert.equal(await tab("third").getAttribute("data-pinned"), "true");
  assert.equal(await tab("third").locator(".note-tab-icon img").count(), 1, "its icon came along");
  // A pinned tab goes anywhere along the strip, not only among the pins: to the far end, still pinned.
  const lastTab = page.locator(".note-tab").last();
  const lastId = await lastTab.getAttribute("data-tab");
  await drag(await mid(tab("third")), await mid(lastTab, 0.85), "13-pin-to-the-end");
  now = await order();
  assert.equal(now.at(-1), "third", `the pinned tab is last now: ${now}`);
  assert.notEqual(lastId, ids.third);
  assert.equal(await tab("third").getAttribute("data-pinned"), "true");
  await page.reload();
  await page.locator("[data-pane]").first().waitFor();
  await tab("third").waitFor();
  assert.equal((await order()).at(-1), "third", "kept across a reload");
  // …and back in front of the other pin.
  await drag(await mid(tab("third")), await mid(tab("other"), 0.2));
  now = await order();
  assert.deepEqual(now.slice(0, 2), ["third", "other"], `back at the front: ${now}`);
  await drag(await mid(tab("third")), await mid(tab("other"), 0.8));
  // Beside a folded group: dropped just left of its label it lands in front of the group, just right of it, after.
  const groupTabs = async () => page.locator(".note-tab.in-group").evaluateAll((els: HTMLElement[]) => els.map((x) => x.dataset.tab));
  const members = await groupTabs();
  const beside = async (dx: (b: { x: number; width: number }) => number) => {
    if ((await chip.getAttribute("aria-expanded")) === "true") await chip.click();
    await sleep(250);
    const c = (await chip.boundingBox())!;
    await drag(await mid(tab("third")), { x: dx(c), y: c.y + c.height / 2 });
    assert.equal(await chip.getAttribute("aria-expanded"), "false", "the group stays folded");
    await chip.click();
    await sleep(250);
    assert.deepEqual(await groupTabs(), members, "it didn't join the group");
    assert.equal(await tab("third").getAttribute("data-pinned"), "true");
    return tabs();
  };
  let all = await beside((c) => c.x - 4);
  assert.equal(all.indexOf(ids.third), all.indexOf(members[0]) - 1, "right in front of the group");
  all = await beside((c) => c.x + c.width + 5);
  assert.equal(all.indexOf(ids.third), all.indexOf(members.at(-1)) + 1, "right after the group");
  await drag(await mid(tab("third")), await mid(tab("other"), 0.8));
  now = await order();
  assert.deepEqual(now.slice(0, 2), ["other", "third"]);

  const paneBox = (await page.locator("[data-pane]").first().boundingBox())!;
  await drag(await mid(tab("third")), { x: paneBox.x + paneBox.width - 80, y: 500 });
  assert.equal(await page.locator("[data-pane]").count(), 2, "dragged to the right edge: a pane of its own");
  assert.equal(await tab("third").getAttribute("data-pinned"), "true", "still pinned there");
  assert.equal(await tab("third").locator(".note-tab-icon img").count(), 1);
  // Back onto the first pane's tabs, in front of the other pin.
  await drag(await mid(tab("third")), await mid(tab("other"), 0.2));
  assert.equal(await page.locator("[data-pane]").count(), 1);
  now = await order();
  assert.deepEqual(now.slice(0, 2), ["third", "other"], `pinned again in the first pane: ${now}`);
  assert.equal(await tab("third").getAttribute("data-pinned"), "true");
  await menu("other", "Unpin");

  // ---- out again: Remove from group, Ungroup from the label's card, Unpin.
  await menu("fourth", "Remove from group");
  assert.equal(await page.locator(".note-tab.in-group").count(), 1);
  await chip.click({ button: "right" });
  await card.getByRole("button", { name: "Ungroup" }).click();
  await sleep(250);
  assert.equal(await page.locator("[data-tab-group]").count(), 0);
  assert.equal((await tabs()).length, 5, "every tab is still open");
  await menu("third", "Unpin");
  assert.equal(await tab("third").getAttribute("data-pinned"), null);
  await shot("4-plain-again");

  assert.deepEqual(errors, [], "no page errors");
  console.log("ok", SHOTS);
} catch (e) {
  failed = true;
  console.error(e);
  await page?.screenshot({ path: join(SHOTS, "failed.png") }).catch(() => {});
  console.error("url", page?.url());
} finally {
  await browser.close();
  server.kill("SIGTERM");
}
process.exit(failed ? 1 : 0);
