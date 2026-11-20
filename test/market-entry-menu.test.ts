import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { routeOf } from "../src/browser/native-shell.ts";
import { CONTACT_EMAIL, contactMail, entryLink, reportMail } from "../web/src/lib/contact.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("an entry's copied link opens that entry in the app, for every kind of key", () => {
  for (const key of ["type/kanji-mage", "deck/countries-of-the-world", "theme/dusk-rose", "paid/lst_8f2a", "soon/anatomy-3d"]) {
    const link = entryLink(key);
    assert.match(link, /^https:\/\/etude\.study\/app\/market\?entry=/);
    const path = routeOf(link)!;
    assert.equal(path.split("?")[0], "/market", key);
    assert.equal(new URLSearchParams(path.split("?")[1]).get("entry"), key, key);
  }
});

test("a report is an email to the team with the entry's name, key, link and a line for the reason", () => {
  const url = new URL(reportMail({ name: "Kanji Mage", key: "type/kanji-mage" }));
  assert.equal(url.protocol, "mailto:");
  assert.equal(url.pathname, CONTACT_EMAIL);
  assert.equal(url.searchParams.get("subject"), "Report: Kanji Mage (type/kanji-mage)");
  const body = url.searchParams.get("body")!;
  for (const line of ["Entry: Kanji Mage", "Key: type/kanji-mage", `Link: ${entryLink("type/kanji-mage")}`, "Reason: "]) assert.ok(body.includes(line), line);
  assert.equal(new URL(contactMail()).pathname, "hello@etude.study");
});

test("every Market entry page has the menu and the 13+ mark; the Market says what 13+ covers; Settings has Contact us", () => {
  const detail = read("web/src/components/market-detail.tsx");
  assert.match(detail, /\{menu\}/);
  for (const piece of [/Copy link/, /Report…/, /Hide everything from \{author\}/, /openMail\(reportMail/, /13\+/]) assert.match(detail, piece);
  // Free entries, paid decks and Coming soon pages all pass a menu and show the age.
  for (const [file, name] of [["web/src/pages/market.tsx", "EntryDetail"], ["web/src/components/market-paid.tsx", "PaidDetail"], ["web/src/components/market-soon.tsx", "SoonDetail"]]) {
    const src = read(file);
    assert.match(src, /menu=\{menu\}/, `${name} passes its menu`);
    assert.match(src, /AGE_CELL/, `${name} shows 13+`);
  }
  const market = read("web/src/pages/market.tsx");
  for (const k of ["${openFree.kind}/${openFree.id}", "paid/${openPaid.listing}", "soon/${openSoon.id}"]) assert.ok(market.includes("menuFor(`" + k + "`"), k);
  assert.match(market, /Everything in the Market fits a 13\+ age rating/);
  // Hidden authors leave every list Discover builds (featured, shelves and search all come from `items`).
  assert.match(market, /\]\.filter\(\(it\) => !\(data\?\.hiddenAuthors \?\? \[\]\)\.some\(\(a\) => sameAuthor\(a, it\.e\.author\)\)\)/);
  const settings = read("web/src/pages/settings.tsx");
  assert.match(settings, /openMail\(contactMail\(\)\)/);
  assert.match(settings, /Contact us/);
  assert.match(settings, /<HiddenAuthorsSection \/>/);
  // In the phone and desktop apps a mailto: goes through window.open, which their shells hand to the system.
  assert.match(read("web/src/lib/account.ts"), /if \(isNativeApp\(\) \|\| desktopApp\(\)\) openOutside\(url\);/);
  assert.match(read("desktop/app.ts"), /\["http:", "https:", "mailto:"\]\.includes\(u\.protocol\)/);
});
