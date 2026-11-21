import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_TITLE, validTitle } from "../src/branches.ts";

test("validTitle trims and collapses whitespace", () => {
  assert.equal(validTitle(" \tSide  \n\t quest \r\n"), "Side quest");
});

test("validTitle enforces the 100-character limit after normalization", () => {
  assert.equal(MAX_TITLE, 100);
  const prefix = "x".repeat(MAX_TITLE - 2);
  assert.equal(validTitle(`  ${prefix}   y  `), `${prefix} y`);
  assert.equal(validTitle(`${prefix} yy`), undefined);
});

test("validTitle rejects empty and whitespace-only titles", () => {
  assert.equal(validTitle(""), undefined);
  assert.equal(validTitle(" \t\r\n "), undefined);
});

test("validTitle rejects controls that remain after whitespace normalization", () => {
  assert.equal(validTitle("bad\u0000title"), undefined);
  assert.equal(validTitle("bad\u001ftitle"), undefined);
  assert.equal(validTitle("bad\u007ftitle"), undefined);
});

test("validTitle rejects non-strings without coercing them", () => {
  for (const value of [undefined, null, 42, true, ["title"], { title: "title" }]) {
    assert.equal(validTitle(value), undefined, `input: ${JSON.stringify(value)}`);
  }
});
