import assert from "node:assert/strict";
import { test } from "node:test";
import { slugify } from "../src/index.js";

test("lower-cases and joins words with hyphens", () => {
  assert.equal(slugify("Hello World"), "hello-world");
});

test("collapses runs of punctuation and spaces", () => {
  assert.equal(slugify("  Rock & Roll -- forever!  "), "rock-roll-forever");
});

test("returns an empty slug for text with no letters or digits", () => {
  assert.equal(slugify("!!!"), "");
});
