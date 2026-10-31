// Text limits for saved notes. Lengths are counted in Unicode characters (code points), not UTF-16 units,
// and a cut never lands inside a user-perceived character (an emoji with modifiers, a ZWJ sequence, a flag).

export const BODY_MAX_CHARS = 8000;
export const TITLE_MAX_CHARS = 30;
export const PERSONA_MAX_CHARS = 32;
export const TRUNCATION_MARK = "（以降省略）";

export function countChars(text: string): number {
  let count = 0;
  for (const _char of text) count += 1;
  return count;
}

// Splits into user-perceived characters when the runtime has Intl.Segmenter; otherwise into code points.
function* units(text: string): Generator<string> {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    for (const part of segmenter.segment(text)) yield part.segment;
    return;
  }
  for (const char of text) yield char;
}

// Keeps at most `max` characters from the start. `clipped` tells whether anything was removed.
export function clipText(text: string, max: number): { text: string; clipped: boolean } {
  if (countChars(text) <= max) return { text, clipped: false };

  let used = 0;
  let end = 0; // UTF-16 index of the end of the kept part
  for (const unit of units(text)) {
    const size = countChars(unit);
    if (used + size > max) break;
    used += size;
    end += unit.length;
  }
  if (end === 0) {
    // The very first user-perceived character is longer than the limit (for example a pile of combining marks).
    // Fall back to a code point cut, which still never splits a surrogate pair.
    return { text: Array.from(text).slice(0, max).join(""), clipped: true };
  }
  return { text: text.slice(0, end), clipped: true };
}
