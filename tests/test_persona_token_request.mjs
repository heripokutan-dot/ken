import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PERSONAS } from "../frontend/personas.js";
import { personaRejectedHint, PERSONA_REJECTED_HINT } from "../frontend/error-messages.js";

// What app.js sends to /api/live-token, and how it words a failure, for each character. Static checks in the same
// style as test_persona_app.mjs and test_notes_list_app.mjs; the expressions that matter are taken out of the real
// source text and run, so the test follows the code rather than a copy of it.

const sourceOf = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
const app = sourceOf("../frontend/app.js");

// The whole function, closing brace included (a function ends at the first "}" that starts a line).
function functionText(source, header) {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `${header} not found`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `end of ${header} not found`);
  return source.slice(start, end + 2);
}

const startSession = functionText(app, "async function startSession() {");
const connectWebSocket = functionText(app, "function connectWebSocket(");

// The text of the fetch call to /api/live-token, from "fetch(" to its closing "});".
function tokenFetchText() {
  const start = startSession.indexOf('fetch("/api/live-token"');
  assert.ok(start >= 0, "the token request is in startSession");
  const end = startSession.indexOf("});", start);
  assert.ok(end > start);
  return startSession.slice(start, end + 3);
}

// ---- the request body ---------------------------------------------------------------------------------------------------

const BODY_STATEMENT = /^\s*const tokenRequestBody = (.+);$/m;

function bodyFor(persona) {
  const match = BODY_STATEMENT.exec(startSession);
  assert.ok(match, "one 'const tokenRequestBody = ...;' line in startSession");
  return new Function("persona", `return ${match[1]};`)(persona);
}

test("the request body is worked out once, in startSession, from the character chosen when the conversation starts", () => {
  assert.equal([...app.matchAll(/const tokenRequestBody\s*=/g)].length, 1);
  const at = startSession.search(BODY_STATEMENT);
  assert.ok(at > startSession.indexOf("const persona = getPersona(personaSelect.value);"), "after the choice is taken");
  assert.ok(at < startSession.indexOf('fetch("/api/live-token"'), "before the request");
  assert.equal([...startSession.matchAll(/getPersona\(/g)].length, 1, "the menu is read once, at the start");
});

test("standard sends the same body as before: {}", () => {
  const standard = PERSONAS.find((persona) => persona.id === "standard");
  assert.strictEqual(bodyFor(standard), "{}");
});

test("every other character sends its id and nothing else", () => {
  for (const persona of PERSONAS.filter((p) => p.id !== "standard")) {
    const body = bodyFor(persona);
    assert.strictEqual(body, JSON.stringify({ persona: persona.id }), persona.id);
    assert.deepEqual(Object.keys(JSON.parse(body)), ["persona"], persona.id);
    assert.equal(body.includes(persona.voiceName), false, "the voice name is not sent in the token request");
    assert.equal(body.includes(persona.label), false, "the label is not sent");
    assert.equal(body.includes("instruction"), false);
  }
});

test("the body expression uses only the chosen character's id", () => {
  const expression = BODY_STATEMENT.exec(startSession)[1];
  assert.match(expression, /persona\.id/);
  assert.doesNotMatch(expression, /voiceName|instruction|label|personaSelect|localStorage|getPersona|fetch/);
});

test("the request uses that body, and the old literal body is gone from the call", () => {
  const call = tokenFetchText();
  assert.match(call, /^\s*body: tokenRequestBody,$/m);
  assert.doesNotMatch(call, /body:\s*"\{\}"/);
  assert.match(call, /method: "POST"/);
  assert.match(call, /^\s*headers,$/m, "the headers (with the sign-in) are passed as before");
});

test("app.js still starts no new request: two fetches, the token and the sign-in settings", () => {
  assert.equal([...app.matchAll(/\bfetch\(/g)].length, 2);
  assert.ok(app.includes('fetch("/api/live-token"'));
  assert.ok(app.includes('fetch("/api/auth-config"'));
});

// ---- what the browser still sends when it connects ----------------------------------------------------------------------

test("the browser keeps sending the voice and the extra instruction in the setup message", () => {
  const line = "buildSetupMessage(model, SYSTEM_INSTRUCTION, { voiceName: persona.voiceName, extraInstruction: persona.instruction })";
  assert.equal([...app.matchAll(/buildSetupMessage\(/g)].length, 1);
  assert.ok(connectWebSocket.includes(line));
});

// ---- the failure messages ------------------------------------------------------------------------------------------------------

test("a refused token request is worded with the chosen character's id; the sign-in message stays as it was", () => {
  assert.ok(startSession.includes("tokenErrorMessage(tokenResponse.status, errorCode, errorBody, persona.id)"));
  assert.ok(startSession.includes("tokenErrorMessage(401)"));
  assert.equal([...app.matchAll(/tokenErrorMessage\(/g)].length, 2);
});

test("the new helper comes from error-messages.js, in the one existing import of that file", () => {
  const imports = [...app.matchAll(/^import \{([^}]*)\} from "\.\/error-messages\.js";$/gm)];
  assert.equal(imports.length, 1);
  const names = imports[0][1].split(",").map((name) => name.trim());
  for (const name of ["userFacingError", "tokenErrorMessage", "closeDetail", "personaRejectedHint"]) {
    assert.ok(names.includes(name), name);
  }
  assert.equal(names.length, 4);
});

// The message for a socket that closed before the setup finished, taken from the source and run.
function closedBeforeSetup(persona, lastCloseDetail) {
  const match = /reject\(new Error\((`Gemini Live の接続がセットアップ完了前[^\n]*`)\)\);/.exec(connectWebSocket);
  assert.ok(match, "the closed-before-setup message");
  return new Function("lastCloseDetail", "personaRejectedHint", "persona", `return ${match[1]};`)(
    lastCloseDetail,
    personaRejectedHint,
    persona,
  );
}

test("closed before the setup finished: the message is as before for standard, and gets the sentence for the others", () => {
  const standard = PERSONAS.find((persona) => persona.id === "standard");
  assert.equal(closedBeforeSetup(standard, ""), "Gemini Live の接続がセットアップ完了前に終了しました。");
  assert.equal(
    closedBeforeSetup(standard, "コード 1007、理由: bad"),
    "Gemini Live の接続がセットアップ完了前に終了しました。（コード 1007、理由: bad）",
  );
  for (const persona of PERSONAS.filter((p) => p.id !== "standard")) {
    assert.equal(
      closedBeforeSetup(persona, "コード 1007、理由: bad"),
      `Gemini Live の接続がセットアップ完了前に終了しました。（コード 1007、理由: bad）${PERSONA_REJECTED_HINT}`,
      persona.id,
    );
    assert.equal(
      closedBeforeSetup(persona, ""),
      `Gemini Live の接続がセットアップ完了前に終了しました。${PERSONA_REJECTED_HINT}`,
      persona.id,
    );
  }
});

test("the other connection messages are not changed", () => {
  for (const text of [
    "Gemini Live に接続できませんでした。API の利用状況とネットワークを確認してください。",
    "Gemini Live から正しい応答を受信できませんでした。（${label}）",
    "Gemini Live との通信でエラーが発生しました。",
  ]) {
    assert.ok(connectWebSocket.includes(text), text);
  }
  assert.equal([...connectWebSocket.matchAll(/personaRejectedHint\(/g)].length, 1, "the sentence is added in one place only");
});
