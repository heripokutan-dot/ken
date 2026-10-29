import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createTranscriptRecorder,
  clipText,
  countChars,
  MAX_BODY_CHARS,
  MAX_BODY_JSON_BYTES,
  TITLE_MAX_CHARS,
} from "../frontend/transcript-recorder.js";

// Characters that are hard to see in source are built from code points on purpose.
const cp = (...codes) => String.fromCodePoint(...codes);
const SMILE = cp(0x1f600);
const FAMILY = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467); // one user-perceived character, 5 code points
const FLAG = cp(0x1f1ef, 0x1f1f5); // one user-perceived character, 2 code points
const IDEOGRAPHIC_SPACE = cp(0x3000);
const NBSP = cp(0xa0);
const LINE_SEPARATOR = cp(0x2028);
const CONTROL = cp(0x01);
const COMBINING_ACUTE = cp(0x0301);

const USER = "あなた：";
const AI = "AI：";

function recorderWith(parts) {
  const recorder = createTranscriptRecorder();
  for (const [speaker, text] of parts) recorder.add(speaker, text);
  return recorder;
}
const takeFrom = (parts) => recorderWith(parts).take();
const jsonBytes = (text) => new TextEncoder().encode(JSON.stringify(text)).length - 2;

const sourceOf = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

// ---------- shape ----------

test("the recorder has exactly reset, add and take", () => {
  assert.deepEqual(Object.keys(createTranscriptRecorder()).sort(), ["add", "reset", "take"]);
});

test("two recorders do not share anything", () => {
  const a = createTranscriptRecorder();
  const b = createTranscriptRecorder();
  a.add("user", "こんにちは");
  assert.deepEqual(b.take(), { kind: "none", reason: "empty" });
  assert.equal(a.take().kind, "note");
});

// ---------- joining and speakers ----------

test("fragments from the same speaker join into one line", () => {
  const result = takeFrom([["user", "今日は"], ["user", "いい天気"], ["user", "ですね"]]);
  assert.deepEqual(result, { kind: "note", title: "今日はいい天気ですね", body: `${USER}今日はいい天気ですね`, clipped: false });
});

test("a change of speaker starts a new line and the order is the order of arrival", () => {
  const result = takeFrom([
    ["user", "こんにちは"],
    ["ai", "こんにちは。"],
    ["ai", "元気ですか"],
    ["user", "元気です"],
    ["ai", "よかったです"],
  ]);
  assert.equal(result.kind, "note");
  assert.equal(result.body, [`${USER}こんにちは`, `${AI}こんにちは。元気ですか`, `${USER}元気です`, `${AI}よかったです`].join("\n"));
});

test("the same speaker coming back after the other one is a new line, not appended to the old one", () => {
  const { body } = takeFrom([["user", "A"], ["ai", "B"], ["user", "C"]]);
  assert.equal(body, `${USER}A\n${AI}B\n${USER}C`);
});

// ---------- blanks ----------

test("a blank fragment at the start of a line is dropped and does not switch the speaker", () => {
  assert.equal(takeFrom([["user", "   "], ["user", "あ"]]).body, `${USER}あ`);
  assert.equal(takeFrom([["ai", "\n"], ["user", "あ"]]).body, `${USER}あ`, "a blank AI fragment creates no AI line");
  assert.equal(takeFrom([["user", "あ"], ["ai", " "], ["user", "い"]]).body, `${USER}あい`, "the user line continues");
  for (const blank of [IDEOGRAPHIC_SPACE, NBSP, LINE_SEPARATOR, "\t", " \r\n "]) {
    assert.equal(takeFrom([["user", "あ"], ["ai", blank], ["user", "い"]]).body, `${USER}あい`);
  }
});

test("a blank fragment inside a line is kept, so English words do not run together", () => {
  assert.equal(takeFrom([["user", "Hello"], ["user", " "], ["user", "world"]]).body, `${USER}Hello world`);
  assert.equal(takeFrom([["user", "x"], ["ai", "Good"], ["ai", " "], ["ai", "morning"]]).body, `${USER}x\n${AI}Good morning`);
  assert.equal(takeFrom([["user", "Hello"], ["user", " world"]]).body, `${USER}Hello world`);
});

test("line breaks inside a fragment become spaces and never split a line", () => {
  assert.equal(takeFrom([["user", "one\ntwo"]]).body, `${USER}one two`);
  assert.equal(takeFrom([["user", "a\r\nb"]]).body, `${USER}a b`, "CRLF is a single space");
  assert.equal(takeFrom([["user", `a${LINE_SEPARATOR}b`]]).body, `${USER}a b`);
  assert.equal(takeFrom([["user", "a"], ["user", "\n"], ["user", "b"]]).body, `${USER}a b`);
  assert.equal(takeFrom([["user", "\n"], ["user", "a"]]).body, `${USER}a`);
  const { body } = takeFrom([["user", "x\ny"], ["ai", "p\nq"]]);
  assert.equal(body.split("\n").length, 2, "one break between the two lines and none inside them");
});

test("each line is trimmed when taken and inner spacing is left alone", () => {
  assert.equal(takeFrom([["user", "  a  b  "]]).body, `${USER}a  b`);
  assert.equal(takeFrom([["user", "a"], ["user", "  "], ["user", "  b "]]).body, `${USER}a    b`);
  assert.equal(takeFrom([["user", "a"], ["user", "   "]]).body, `${USER}a`);
  assert.equal(takeFrom([["user", `${IDEOGRAPHIC_SPACE}あ${NBSP}`]]).body, `${USER}あ`);
});

// ---------- bad input ----------

test("unknown speakers and non-string text never throw and record nothing", () => {
  const recorder = createTranscriptRecorder();
  const badSpeakers = [undefined, null, "", "User", "AI", "system", "user ", 0, true, {}, [], Symbol("x"), () => "user"];
  const badTexts = [undefined, null, 123, true, {}, ["a"], Symbol("x"), new String("x"), () => "x", { toString() { throw new Error("boom"); } }];
  for (const speaker of badSpeakers) assert.doesNotThrow(() => assert.equal(recorder.add(speaker, "text"), false));
  for (const text of badTexts) {
    assert.doesNotThrow(() => assert.equal(recorder.add("user", text), false));
    assert.doesNotThrow(() => assert.equal(recorder.add("ai", text), false));
  }
  assert.doesNotThrow(() => recorder.add());
  assert.deepEqual(recorder.take(), { kind: "none", reason: "empty" });
});

test("ignored input does not disturb the lines around it", () => {
  const recorder = createTranscriptRecorder();
  recorder.add("user", "あ");
  recorder.add("system", "x");
  recorder.add("ai", 42);
  recorder.add("ai", undefined);
  recorder.add("user", "い");
  assert.equal(recorder.take().body, `${USER}あい`);
});

test("add says whether it took the fragment", () => {
  const recorder = createTranscriptRecorder();
  assert.equal(recorder.add("user", "あ"), true);
  assert.equal(recorder.add("user", "   "), true, "a blank in the middle of a line is kept");
  assert.equal(recorder.add("ai", "   "), false, "a blank at the start of a line is dropped");
});

// ---------- title ----------

test("the title is the first line from the user without its label", () => {
  assert.equal(takeFrom([["user", "今日の天気を教えて"]]).title, "今日の天気を教えて");
});

test("the title comes from the first user line even when the AI spoke first", () => {
  const { title } = takeFrom([["ai", "ようこそ"], ["user", "最初の質問"], ["ai", "答え"], ["user", "二つ目の質問"]]);
  assert.equal(title, "最初の質問");
});

test("the title is made from the joined fragments of that line", () => {
  assert.equal(takeFrom([["user", "今日は"], ["user", "いい天気"]]).title, "今日はいい天気");
});

test("the title collapses line breaks and runs of spaces into one space", () => {
  assert.equal(takeFrom([["user", "a\n\n  b\t\tc"]]).title, "a b c");
  assert.equal(takeFrom([["user", `a${IDEOGRAPHIC_SPACE}${IDEOGRAPHIC_SPACE}b`]]).title, "a b");
  assert.equal(takeFrom([["user", `a${LINE_SEPARATOR}${NBSP}b`]]).title, "a b");
});

test("the title is at most 30 characters", () => {
  assert.equal(TITLE_MAX_CHARS, 30);
  assert.equal(takeFrom([["user", "あ".repeat(30)]]).title, "あ".repeat(30));
  assert.equal(takeFrom([["user", "あ".repeat(31)]]).title, "あ".repeat(30));
  assert.equal(takeFrom([["user", "あ".repeat(500)]]).title, "あ".repeat(30));
});

test("the title never cuts an emoji in half", () => {
  assert.equal(takeFrom([["user", SMILE.repeat(40)]]).title, SMILE.repeat(30));
  assert.equal(takeFrom([["user", `${"a".repeat(29)}${FAMILY}`]]).title, "a".repeat(29), "a 5-code-point sequence that does not fit is left out whole");
  assert.equal(takeFrom([["user", `${"a".repeat(28)}${FLAG}b`]]).title, `${"a".repeat(28)}${FLAG}`, "a sequence that fits exactly is kept");
  const title = takeFrom([["user", `${"a".repeat(28)}${SMILE.repeat(5)}`]]).title;
  assert.equal(title.isWellFormed(), true);
});

// ---------- body length ----------

test("a body of exactly 10,000 characters is not clipped, and nothing is added to mark a cut", () => {
  assert.equal(MAX_BODY_CHARS, 10000);
  const result = takeFrom([["user", "a".repeat(10000 - USER.length)]]);
  assert.equal(countChars(result.body), 10000);
  assert.equal(result.clipped, false);
  assert.equal(result.body, USER + "a".repeat(9996));
});

test("one character over 10,000 is clipped to 10,000 and flagged, with no marker added", () => {
  const result = takeFrom([["user", "a".repeat(10000 - USER.length + 1)]]);
  assert.equal(result.clipped, true);
  assert.equal(result.body, USER + "a".repeat(9996));
  assert.equal(result.body.includes("以降省略"), false);
});

test("labels and line breaks count toward the 10,000", () => {
  // 4 + 5000 + 1 + 3 + 4992 = 10,000 exactly.
  const exact = takeFrom([["user", "a".repeat(5000)], ["ai", "b".repeat(4992)]]);
  assert.equal(countChars(exact.body), 10000);
  assert.equal(exact.clipped, false);
  const over = takeFrom([["user", "a".repeat(5000)], ["ai", "b".repeat(5000)]]);
  assert.equal(countChars(over.body), 10000);
  assert.equal(over.clipped, true);
  assert.equal(over.body, `${USER}${"a".repeat(5000)}\n${AI}${"b".repeat(4992)}`, "the head is kept");
});

test("the 10,000 character cut never splits an emoji", () => {
  const emoji = takeFrom([["user", SMILE.repeat(10000)]]);
  assert.equal(emoji.clipped, true);
  assert.equal(emoji.body, USER + SMILE.repeat(9996));
  assert.equal(emoji.body.isWellFormed(), true);

  // The family emoji would straddle character 10,000, so it is left out whole.
  const family = takeFrom([["user", `${"a".repeat(9994)}${FAMILY}x`]]);
  assert.equal(family.clipped, true);
  assert.equal(family.body, USER + "a".repeat(9994));

  const flag = takeFrom([["user", `${"a".repeat(9995)}${FLAG}x`]]);
  assert.equal(flag.body, USER + "a".repeat(9995));
});

// ---------- byte safety net ----------

test("ordinary text of 10,000 characters is far below the byte limit and is not cut by it", () => {
  assert.equal(MAX_BODY_JSON_BYTES, 50000);
  const japanese = takeFrom([["user", "あ".repeat(20000)]]);
  assert.equal(countChars(japanese.body), 10000);
  assert.ok(jsonBytes(japanese.body) < 35000);
  const emoji = takeFrom([["user", SMILE.repeat(20000)]]);
  assert.equal(countChars(emoji.body), 10000, "emoji (the widest ordinary case) still keep all 10,000 characters");
  assert.ok(jsonBytes(emoji.body) <= MAX_BODY_JSON_BYTES);
});

test("abnormal text that would exceed 50,000 bytes once escaped is cut further and flagged", () => {
  // A control character becomes six bytes in JSON (\u0001), so 10,000 of them are about 60,000 bytes.
  const result = takeFrom([["user", CONTROL.repeat(12000)]]);
  assert.equal(result.kind, "note");
  assert.equal(result.clipped, true);
  assert.ok(jsonBytes(result.body) <= MAX_BODY_JSON_BYTES, `body is ${jsonBytes(result.body)} bytes`);
  assert.ok(jsonBytes(result.body) > 40000, "it is not cut far more than needed");
  assert.ok(countChars(result.body) < 10000);
  assert.ok(result.body.startsWith(USER + CONTROL), "the head is kept");
});

test("lone surrogates, which JSON writes as six bytes, are handled by the same net", () => {
  const lone = String.fromCharCode(0xd800);
  const result = takeFrom([["user", lone.repeat(12000)]]);
  assert.equal(result.clipped, true);
  assert.ok(jsonBytes(result.body) <= MAX_BODY_JSON_BYTES);
});

test("the net also applies to a body made of several lines", () => {
  const result = takeFrom([["user", CONTROL.repeat(4000)], ["ai", CONTROL.repeat(4000)], ["user", CONTROL.repeat(4000)]]);
  assert.equal(result.clipped, true);
  assert.ok(jsonBytes(result.body) <= MAX_BODY_JSON_BYTES);
});

// ---------- nothing to save ----------

test("no speech at all, or only blanks, is 'empty'", () => {
  assert.deepEqual(createTranscriptRecorder().take(), { kind: "none", reason: "empty" });
  assert.deepEqual(takeFrom([["user", "   "], ["ai", "\n"], ["user", NBSP]]), { kind: "none", reason: "empty" });
});

test("only the AI speaking, such as a greeting, is 'no_user_speech'", () => {
  assert.deepEqual(takeFrom([["ai", "ようこそ。何をお手伝いしましょうか"]]), { kind: "none", reason: "no_user_speech" });
  assert.deepEqual(takeFrom([["user", "   "], ["ai", "こんにちは"]]), { kind: "none", reason: "no_user_speech" }, "a blank user fragment is not speech");
});

test("'empty' is decided before 'no_user_speech'", () => {
  assert.deepEqual(takeFrom([["ai", "   "]]), { kind: "none", reason: "empty" });
});

test("taking again is 'already_taken' whatever the first result was, and it is decided first", () => {
  const empty = createTranscriptRecorder();
  assert.equal(empty.take().reason, "empty");
  assert.deepEqual(empty.take(), { kind: "none", reason: "already_taken" });

  const aiOnly = recorderWith([["ai", "こんにちは"]]);
  assert.equal(aiOnly.take().reason, "no_user_speech");
  assert.deepEqual(aiOnly.take(), { kind: "none", reason: "already_taken" });

  const spoken = recorderWith([["user", "こんにちは"]]);
  assert.equal(spoken.take().kind, "note");
  assert.deepEqual(spoken.take(), { kind: "none", reason: "already_taken" });
  assert.deepEqual(spoken.take(), { kind: "none", reason: "already_taken" });
});

test("a 'none' result also closes the record: what arrives afterwards is ignored", () => {
  const recorder = createTranscriptRecorder();
  assert.equal(recorder.take().reason, "empty");
  assert.equal(recorder.add("user", "遅れて届いた発言"), false);
  assert.deepEqual(recorder.take(), { kind: "none", reason: "already_taken" });
});

// ---------- take once, reset ----------

test("a fragment that arrives after take() is ignored and cannot make a partial second note", () => {
  const recorder = recorderWith([["user", "さようなら"]]);
  assert.equal(recorder.take().kind, "note");
  assert.equal(recorder.add("ai", "遅れて届いた断片"), false);
  assert.equal(recorder.add("user", "もう一言"), false);
  assert.deepEqual(recorder.take(), { kind: "none", reason: "already_taken" });
});

test("take() empties the record, and reset() opens it again for a new conversation", () => {
  const recorder = recorderWith([["user", "古い会話"]]);
  recorder.take();
  recorder.reset();
  assert.deepEqual(recorder.take(), { kind: "none", reason: "empty" }, "nothing of the old conversation is left");
  recorder.reset();
  recorder.add("user", "新しい会話");
  const result = recorder.take();
  assert.equal(result.body, `${USER}新しい会話`);
  assert.equal(result.body.includes("古い"), false);
});

test("reset() discards what has been recorded but not taken", () => {
  const recorder = recorderWith([["user", "途中まで"], ["ai", "はい"]]);
  recorder.reset();
  assert.deepEqual(recorder.take(), { kind: "none", reason: "empty" });
});

test("reset() can be called any number of times, also before anything was added", () => {
  const recorder = createTranscriptRecorder();
  recorder.reset();
  recorder.reset();
  recorder.add("user", "あ");
  recorder.reset();
  recorder.add("user", "い");
  assert.equal(recorder.take().body, `${USER}い`);
});

test("take() never throws, even when the environment breaks halfway", () => {
  const original = globalThis.TextEncoder;
  globalThis.TextEncoder = class {
    encode() {
      throw new Error("broken");
    }
  };
  try {
    const recorder = recorderWith([["user", "こんにちは"]]);
    let result;
    assert.doesNotThrow(() => {
      result = recorder.take();
    });
    assert.equal(result.kind, "none");
  } finally {
    globalThis.TextEncoder = original;
  }
});

// ---------- clipText and the path without Intl.Segmenter ----------

test("countChars counts characters, not UTF-16 units", () => {
  assert.equal(countChars("abc"), 3);
  assert.equal(countChars(SMILE), 1);
  assert.equal(SMILE.length, 2);
  assert.equal(countChars(FAMILY), 5);
});

test("clipText leaves text within the limit unchanged", () => {
  assert.deepEqual(clipText("abc", 3), { text: "abc", clipped: false });
  assert.deepEqual(clipText("", 3), { text: "", clipped: false });
});

test("clipText keeps a whole user-perceived character together when Intl.Segmenter exists", () => {
  assert.deepEqual(clipText(`abc${FAMILY}d`, 5), { text: "abc", clipped: true });
  assert.deepEqual(clipText(`abc${FLAG}d`, 4), { text: "abc", clipped: true });
  assert.deepEqual(clipText(`abc${FAMILY}d`, 8), { text: `abc${FAMILY}`, clipped: true });
});

test("the code point path (no Intl.Segmenter) cuts by code point and never splits a surrogate pair", () => {
  const text = `abc${FAMILY}d`;
  const result = clipText(text, 5, { useSegmenter: false });
  assert.deepEqual(result, { text: `abc${cp(0x1f468, 0x200d)}`, clipped: true });
  assert.equal(result.text.isWellFormed(), true);
  const emoji = clipText(SMILE.repeat(5), 3, { useSegmenter: false });
  assert.equal(emoji.text, SMILE.repeat(3));
  assert.equal(emoji.text.isWellFormed(), true);
});

test("when Intl.Segmenter is missing, the same code point path is used automatically", () => {
  const original = Intl.Segmenter;
  const text = `abc${FAMILY}d`;
  const expected = clipText(text, 5, { useSegmenter: false });
  Intl.Segmenter = undefined;
  try {
    assert.deepEqual(clipText(text, 5), expected);
    const recorder = recorderWith([["user", SMILE.repeat(10001)]]);
    const result = recorder.take();
    assert.equal(result.clipped, true);
    assert.equal(countChars(result.body), 10000);
    assert.equal(result.body.isWellFormed(), true);
  } finally {
    Intl.Segmenter = original;
  }
});

test("when Intl.Segmenter exists but cannot be created, it falls back instead of throwing", () => {
  const original = Intl.Segmenter;
  Intl.Segmenter = function () {
    throw new RangeError("no segmentation data");
  };
  try {
    assert.doesNotThrow(() => clipText(`abc${FAMILY}d`, 5));
    assert.deepEqual(clipText(`abc${FAMILY}d`, 5), clipText(`abc${FAMILY}d`, 5, { useSegmenter: false }));
  } finally {
    Intl.Segmenter = original;
  }
});

test("a single huge user-perceived character falls back to a code point cut", () => {
  const pile = `e${COMBINING_ACUTE.repeat(50)}`;
  const result = clipText(pile, 30);
  assert.equal(result.clipped, true);
  assert.equal(countChars(result.text), 30);
  assert.equal(result.text.isWellFormed(), true);
});

// ---------- the module keeps to itself ----------

test("the source uses no browser storage and no logging", () => {
  const source = sourceOf("../frontend/transcript-recorder.js");
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|\bconsole\b/i);
});

test("the source does not depend on the page, the network or timers", () => {
  const source = sourceOf("../frontend/transcript-recorder.js");
  assert.doesNotMatch(source, /\bdocument\b|\bwindow\b|\bnavigator\b|\bfetch\b|WebSocket|XMLHttpRequest|setTimeout|setInterval|requestAnimationFrame/);
  assert.doesNotMatch(source, /^\s*import\s/m, "it imports nothing");
});

test("the source contains no raw line-terminator characters (a regex literal with one would not even parse)", () => {
  const source = sourceOf("../frontend/transcript-recorder.js");
  assert.equal(source.includes(cp(0x2028)), false);
  assert.equal(source.includes(cp(0x2029)), false);
});

// ---------- how app.js feeds it ----------

test("app.js feeds the recorder only from the confirmed transcription events, and resets it at the start of a conversation", () => {
  const app = sourceOf("../frontend/app.js");
  const count = (text) => app.split(text).length - 1;

  assert.equal(count('import { createTranscriptRecorder } from "./transcript-recorder.js";'), 1);
  assert.equal(count("const transcriptRecorder = createTranscriptRecorder();"), 1);

  const inputBlock = /if \(content\.inputTranscription\?\.text\) \{[^}]*\}/.exec(app)?.[0] ?? "";
  assert.equal(count('transcriptRecorder.add("user", content.inputTranscription.text);'), 1);
  assert.ok(inputBlock.includes('transcriptRecorder.add("user", content.inputTranscription.text);'));

  const outputBlock = /if \(content\.outputTranscription\?\.text\) \{[^}]*\}/.exec(app)?.[0] ?? "";
  assert.equal(count('transcriptRecorder.add("ai", content.outputTranscription.text);'), 1);
  assert.ok(outputBlock.includes('transcriptRecorder.add("ai", content.outputTranscription.text);'));

  const interimBlock = /if \(content\.interimInputTranscription\?\.text\) \{[^}]*\}/.exec(app)?.[0] ?? "";
  assert.ok(interimBlock.length > 0);
  assert.equal(interimBlock.includes("transcriptRecorder"), false, "interim text is never recorded");

  const start = app.indexOf("async function startSession()");
  const reset = app.indexOf("transcriptRecorder.reset();");
  const connect = app.indexOf("await connectWebSocket(");
  assert.equal(count("transcriptRecorder.reset();"), 1);
  assert.ok(start >= 0 && start < reset && reset < connect, "reset happens inside startSession, before the connection is made");
});
