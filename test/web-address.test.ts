import { test } from "node:test";
import assert from "node:assert/strict";
import { addressOf } from "../web/src/lib/web-address.ts";

const S = "https://search.test/?q=";

test("an address is kept, and a bare host gets https", () => {
  assert.equal(addressOf("https://en.wikipedia.org/wiki/FSRS", S), "https://en.wikipedia.org/wiki/FSRS");
  assert.equal(addressOf("http://example.com", S), "http://example.com");
  assert.equal(addressOf("  example.com  ", S), "https://example.com");
  assert.equal(addressOf("en.wikipedia.org/wiki/Spaced_repetition", S), "https://en.wikipedia.org/wiki/Spaced_repetition");
  assert.equal(addressOf("github.com/Zibhelina?tab=repos", S), "https://github.com/Zibhelina?tab=repos");
});

test("this computer and IP addresses get http, a port included", () => {
  assert.equal(addressOf("localhost:3000", S), "http://localhost:3000");
  assert.equal(addressOf("localhost", S), "http://localhost");
  assert.equal(addressOf("192.168.1.10:8080/x", S), "http://192.168.1.10:8080/x");
});

test("words are a search", () => {
  assert.equal(addressOf("fsrs algorithm", S), S + "fsrs%20algorithm");
  assert.equal(addressOf("c++", S), S + "c%2B%2B");
  assert.equal(addressOf("3.14", S), S + "3.14");
  assert.equal(addressOf("what is example.com", S), S + "what%20is%20example.com");
});

test("nothing, and pages that aren't web pages, go nowhere", () => {
  assert.equal(addressOf("   ", S), null);
  assert.equal(addressOf("file:///etc/hosts", S), null);
  assert.equal(addressOf("javascript:alert(1)", S), null);
  assert.equal(addressOf("mailto:a@b.c", S), null);
});
