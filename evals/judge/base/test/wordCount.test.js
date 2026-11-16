import assert from "node:assert/strict";
import { test } from "node:test";
import { wordCount } from "../src/index.js";

test("counts words separated by any whitespace", () => {
  assert.equal(wordCount("one two\tthree\nfour"), 4);
});

test("blank text has no words", () => {
  assert.equal(wordCount("   "), 0);
  assert.equal(wordCount(""), 0);
});
