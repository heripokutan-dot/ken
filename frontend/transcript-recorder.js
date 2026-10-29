// Keeps what was said in a conversation, in the order it arrived, as a record separate from the on-screen transcript.
//
// Pure logic: no DOM, no network, no timers, and nothing is written to browser storage or to any log.
// What was said leaves this module only through take(). None of the three methods ever throws, because the caller
// runs inside the message handler, where an exception would end the conversation.
//
//   reset()             start a new, empty record and accept add() again
//   add(speaker, text)  speaker is "user" or "ai"; anything else is ignored
//   take()              hand over the record once; every later call says "already_taken" until reset()

export const MAX_BODY_CHARS = 10000; // counted in Unicode characters, labels and line breaks included
export const MAX_BODY_JSON_BYTES = 50000; // see fitBodyToBytes
export const TITLE_MAX_CHARS = 30;

const LABELS = { user: "あなた：", ai: "AI：" };

// CR, LF and the two Unicode line separators (U+2028, U+2029). The separators are built from their code points
// so that the source file itself never contains a raw line-terminator character.
const LINE_BREAKS = new RegExp(`\\r\\n|[\\r\\n${String.fromCharCode(0x2028, 0x2029)}]`, "g");

export function countChars(text) {
  let count = 0;
  for (const _char of text) count += 1;
  return count;
}

// Splits into user-perceived characters (an emoji with modifiers, a ZWJ sequence, a flag) when Intl.Segmenter exists.
// Otherwise, or when asked not to, it splits into code points (which never splits a surrogate pair).
function* units(text, useSegmenter) {
  let segmenter = null;
  if (useSegmenter && typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    try {
      segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    } catch {
      segmenter = null; // an environment without usable segmentation data falls back to code points
    }
  }
  if (segmenter) {
    for (const part of segmenter.segment(text)) yield part.segment;
    return;
  }
  for (const char of text) yield char;
}

// Keeps at most `max` characters from the start, never cutting inside a user-perceived character.
// `useSegmenter: false` forces the code point path (the one used where Intl.Segmenter is missing).
export function clipText(text, max, { useSegmenter = true } = {}) {
  if (countChars(text) <= max) return { text, clipped: false };

  let used = 0;
  let end = 0; // UTF-16 index of the end of the kept part
  for (const unit of units(text, useSegmenter)) {
    const size = countChars(unit);
    if (used + size > max) break;
    used += size;
    end += unit.length;
  }
  if (end === 0) {
    // The first user-perceived character alone is longer than the limit (a pile of combining marks).
    return { text: Array.from(text).slice(0, max).join(""), clipped: true };
  }
  return { text: text.slice(0, end), clipped: true };
}

// Size of the text as it goes out in a JSON request: UTF-8 bytes of the JSON string, without its two quotes.
// JSON escaping can make this larger than the plain UTF-8 size (a control character becomes six bytes).
function jsonBytes(text) {
  return new TextEncoder().encode(JSON.stringify(text)).length - 2;
}

// Safety net for abnormal text: the server refuses a request over 64 KB outright, which would lose the whole note.
// 10,000 characters of ordinary text stay far below this (Japanese about 30 KB, emoji about 40 KB).
function fitBodyToBytes(text) {
  let body = text;
  let clipped = false;
  let guard = 0;
  while (jsonBytes(body) > MAX_BODY_JSON_BYTES && guard < 64) {
    const bytes = jsonBytes(body);
    const chars = countChars(body);
    const target = Math.min(chars - 1, Math.floor((chars * MAX_BODY_JSON_BYTES) / bytes));
    body = clipText(body, Math.max(0, target)).text;
    clipped = true;
    guard += 1;
  }
  return { text: body, clipped };
}

function makeTitle(firstUserLine) {
  const collapsed = firstUserLine.replace(/\s+/g, " ").trim();
  return clipText(collapsed, TITLE_MAX_CHARS).text;
}

export function createTranscriptRecorder() {
  let lines = []; // [{ speaker, text }] in arrival order
  let taken = false;

  function reset() {
    lines = [];
    taken = false;
  }

  function add(speaker, text) {
    try {
      if (taken) return false;
      if (speaker !== "user" && speaker !== "ai") return false;
      if (typeof text !== "string") return false;

      // A line break inside a fragment must not be mistaken for the break between two lines.
      const piece = text.replace(LINE_BREAKS, " ");
      const last = lines.length > 0 ? lines[lines.length - 1] : null;
      const continuing = last !== null && last.speaker === speaker;

      if (piece.trim() === "") {
        // A blank fragment at the start of a line is dropped (it does not even switch the speaker).
        // In the middle of a line it is kept: it can be the space between two English words.
        if (!continuing) return false;
        last.text += piece;
        return true;
      }
      if (continuing) last.text += piece;
      else lines.push({ speaker, text: piece });
      return true;
    } catch {
      return false;
    }
  }

  function take() {
    try {
      if (taken) return { kind: "none", reason: "already_taken" };
      taken = true; // whatever the result, this conversation's record has now been handed out
      const snapshot = lines;
      lines = [];

      const kept = [];
      for (const line of snapshot) {
        const text = line.text.trim();
        if (text !== "") kept.push({ speaker: line.speaker, text });
      }
      if (kept.length === 0) return { kind: "none", reason: "empty" };
      const firstUser = kept.find((line) => line.speaker === "user");
      if (!firstUser) return { kind: "none", reason: "no_user_speech" };

      const joined = kept.map((line) => LABELS[line.speaker] + line.text).join("\n");
      const byLength = clipText(joined, MAX_BODY_CHARS);
      const byBytes = fitBodyToBytes(byLength.text);
      return {
        kind: "note",
        title: makeTitle(firstUser.text),
        body: byBytes.text,
        clipped: byLength.clipped || byBytes.clipped,
      };
    } catch {
      // Not expected. The record is already marked as handed out, so there is nothing to retry.
      return { kind: "none", reason: "empty" };
    }
  }

  return { reset, add, take };
}
