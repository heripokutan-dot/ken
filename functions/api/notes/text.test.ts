import { test } from "node:test";
import assert from "node:assert/strict";
import { clipText, countChars, BODY_MAX_CHARS, TITLE_MAX_CHARS, PERSONA_MAX_CHARS, TRUNCATION_MARK } from "./text.ts";

const FAMILY = "\u{1F468}‍\u{1F469}‍\u{1F467}"; // one user-perceived character, 5 code points
const FLAG = "\u{1F1EF}\u{1F1F5}"; // one user-perceived character, 2 code points

test("limits_are_the_agreed_numbers", () => {
  assert.equal(BODY_MAX_CHARS, 8000);
  assert.equal(TITLE_MAX_CHARS, 30);
  assert.equal(PERSONA_MAX_CHARS, 32);
  assert.equal(TRUNCATION_MARK, "（以降省略）");
});

test("countChars_counts_code_points_not_utf16_units", () => {
  assert.equal(countChars("abc"), 3);
  assert.equal(countChars("あい"), 2);
  assert.equal(countChars("\u{1F600}"), 1);
  assert.equal("\u{1F600}".length, 2);
});

test("text_within_the_limit_is_returned_unchanged", () => {
  assert.deepEqual(clipText("abc", 3), { text: "abc", clipped: false });
  assert.deepEqual(clipText("", 3), { text: "", clipped: false });
  const emoji = "\u{1F600}".repeat(3);
  assert.deepEqual(clipText(emoji, 3), { text: emoji, clipped: false });
});

test("text_over_the_limit_is_cut_to_the_limit", () => {
  assert.deepEqual(clipText("abcd", 3), { text: "abc", clipped: true });
  assert.deepEqual(clipText("あいうえお", 2), { text: "あい", clipped: true });
});

test("a_cut_never_splits_a_surrogate_pair", () => {
  const result = clipText("\u{1F600}".repeat(5), 3);
  assert.equal(result.text, "\u{1F600}".repeat(3));
  assert.equal(result.clipped, true);
  assert.equal(result.text.isWellFormed(), true);
});

test("a_cut_never_splits_a_zwj_sequence", () => {
  // 6 + 5 code points = 11 > 8, and a code point cut at 8 would leave half of the family.
  const result = clipText(`abcdef${FAMILY}xyz`, 8);
  assert.equal(result.text, "abcdef");
  assert.equal(result.clipped, true);
});

test("a_cut_never_splits_a_flag", () => {
  const result = clipText(`abc${FLAG}d`, 4);
  assert.equal(result.text, "abc");
  assert.equal(result.clipped, true);
});

test("a_whole_sequence_that_fits_is_kept", () => {
  const result = clipText(`abc${FAMILY}xyz`, 8);
  assert.equal(result.text, `abc${FAMILY}`);
});

test("one_huge_user_perceived_character_falls_back_to_a_code_point_cut", () => {
  const pile = `e${"́".repeat(50)}`; // one grapheme of 51 code points
  const result = clipText(pile, 30);
  assert.equal(result.clipped, true);
  assert.equal(countChars(result.text), 30);
  assert.equal(result.text.isWellFormed(), true);
});

test("without_intl_segmenter_the_cut_is_by_code_point_and_still_well_formed", () => {
  const intl = Intl as unknown as { Segmenter?: unknown };
  const original = intl.Segmenter;
  intl.Segmenter = undefined;
  try {
    const result = clipText(`${"a".repeat(7999)}\u{1F600}\u{1F600}`, 8000);
    assert.equal(result.text, `${"a".repeat(7999)}\u{1F600}`);
    assert.equal(result.clipped, true);
    assert.equal(result.text.isWellFormed(), true);
  } finally {
    intl.Segmenter = original;
  }
});
