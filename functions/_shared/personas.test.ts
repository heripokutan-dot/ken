import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PERSONAS, findPersona } from "./personas.ts";

// Anything that is not exactly one of the four ids. Same idea as tests/test_personas.mjs on the page side.
const NOT_AN_ID: unknown[] = [
  undefined, null, "", " ", "Buddy", "BUDDY", " buddy", "buddy ", "buddy\n", "unknown", "__proto__", "constructor",
  "prototype", "toString", "hasOwnProperty", "0", "1", "null", "undefined", "true", "[object Object]", "buddy,teacher",
  "相棒", "Puck", "Charon", "Kore", "x".repeat(10000),
  0, 1, -1, NaN, true, false, 10n, Symbol("buddy"),
  {}, { id: "buddy" }, ["buddy"], [], () => "buddy", new String("buddy"),
  { toString: () => "buddy" }, { valueOf: () => "buddy" },
];

// ---- the table ------------------------------------------------------------------------------------------------------

test("the server table has the four characters, in order, with the agreed voices", () => {
  assert.deepEqual(
    PERSONAS.map((persona) => ({ ...persona })),
    [
      { id: "standard", voiceName: null },
      { id: "buddy", voiceName: "Pulcherrima" },
      { id: "teacher", voiceName: "Algieba" },
      { id: "listener", voiceName: "Despina" },
    ],
  );
});

test("the table cannot be changed while the server runs", () => {
  assert.ok(Object.isFrozen(PERSONAS));
  for (const persona of PERSONAS) assert.ok(Object.isFrozen(persona), persona.id);
});

// ---- looking one up -------------------------------------------------------------------------------------------------

test("an exact id gives its character", () => {
  for (const persona of PERSONAS) assert.equal(findPersona(persona.id), persona);
});

test("anything that is not exactly one of the ids gives nothing (there is no fallback to standard)", () => {
  for (const value of NOT_AN_ID) assert.equal(findPersona(value), undefined, String(typeof value));
});

test("the lookup compares values; it never uses the input as a property name", () => {
  const source = readFileSync(new URL("./personas.ts", import.meta.url), "utf8");
  assert.match(source, /\.find\(/, "an array lookup with ===");
  assert.match(source, /===/);
  assert.doesNotMatch(source, /\[\s*value\s*\]|\[\s*id\s*\]|\bin\s+PERSONAS|hasOwn/, "no property access by the input");
});

// ---- the page's table and the server's table must agree ----------------------------------------------------------------
// The server code never reads frontend/; only this test does, so that the two copies cannot drift apart unnoticed.

test("the server table matches frontend/personas.js: ids, order and voice names", async () => {
  const page = (await import(new URL("../../frontend/personas.js", import.meta.url).href)) as {
    PERSONAS: ReadonlyArray<{ id: string; voiceName: string | null }>;
  };
  assert.deepEqual(
    PERSONAS.map(({ id, voiceName }) => ({ id, voiceName })),
    page.PERSONAS.map(({ id, voiceName }) => ({ id, voiceName })),
  );
});

test("no server code reads anything from frontend/", () => {
  for (const file of [
    "_shared/personas.ts", "_shared/read-json.ts", "_shared/gemini-token.ts", "api/live-token.ts",
  ]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*frontend/, `${file} imports from frontend/`);
    assert.doesNotMatch(source, /import\(\s*["'][^"']*frontend/, `${file} imports from frontend/`);
    assert.doesNotMatch(source, /readFile/, `${file} reads files`);
  }
});
