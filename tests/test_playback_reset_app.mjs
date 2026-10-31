import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Static check of how startSession prepares playback state.
// Each conversation gets a new AudioContext whose clock starts at 0, so the playback schedule and the
// "suppress playback" flag left over from the previous conversation must be reset right after it is created.
// Nothing here runs the page. Whitespace and line breaks are allowed to differ.

const app = readFileSync(new URL("../frontend/app.js", import.meta.url), "utf8");

function functionBody(source, header) {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `${header} not found`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start);
  return source.slice(start, end);
}

const startSession = functionBody(app, "async function startSession(");
const createContext = /audioContext\s*=\s*new\s+AudioContext\s*\(\s*\)\s*;/;
const resetSchedule = /nextPlaybackTime\s*=\s*0\s*;/;
const resetSuppress = /suppressPlayback\s*=\s*false\s*;/;

test("a new AudioContext is created in exactly one place, inside startSession", () => {
  assert.equal([...app.matchAll(/new\s+AudioContext\s*\(/g)].length, 1);
  assert.match(startSession, createContext);
});

test("startSession resets nextPlaybackTime and suppressPlayback right after creating the AudioContext", () => {
  const created = startSession.search(createContext);
  const afterCreate = startSession.slice(created).replace(createContext, "");
  const scheduleAt = afterCreate.search(resetSchedule);
  const suppressAt = afterCreate.search(resetSuppress);
  assert.ok(scheduleAt >= 0, "nextPlaybackTime = 0 must follow new AudioContext");
  assert.ok(suppressAt >= 0, "suppressPlayback = false must follow new AudioContext");
  // Nothing but these resets may sit between the creation and the microphone request.
  const beforeMicrophone = afterCreate.slice(0, afterCreate.search(/getUserMedia\s*\(/));
  assert.match(beforeMicrophone, resetSchedule);
  assert.match(beforeMicrophone, resetSuppress);
});

test("the resets come before resume, the token request, the WebSocket and any audio handling", () => {
  const resetsEnd = Math.max(
    startSession.search(resetSchedule) + startSession.match(resetSchedule)[0].length,
    startSession.search(resetSuppress) + startSession.match(resetSuppress)[0].length,
  );
  for (const later of [/\.resume\s*\(/, /fetch\s*\(\s*"\/api\/live-token"/, /connectWebSocket\s*\(/, /new\s+WebSocket\s*\(/, /playAudioChunk\s*\(/]) {
    const at = startSession.search(later);
    if (at >= 0) assert.ok(at >= resetsEnd, `${later} appears before the resets`);
  }
});

test("each reset appears once inside startSession, and the other playback code is as before", () => {
  assert.equal([...startSession.matchAll(/nextPlaybackTime\s*=/g)].length, 1);
  assert.equal([...startSession.matchAll(/suppressPlayback\s*=/g)].length, 1);
  // The functions that own playback keep their own handling of these values.
  assert.match(functionBody(app, "function stopScheduledPlayback("), /nextPlaybackTime\s*=\s*audioContext\s*\?\s*audioContext\.currentTime\s*:\s*0\s*;/);
  assert.match(functionBody(app, "function interruptPlayback("), /suppressPlayback\s*=\s*true\s*;/);
});
