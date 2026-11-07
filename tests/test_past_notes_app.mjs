import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

// Static checks of how app.js, index.html and package.json use "use past notes". Nothing here runs the page:
// the logic itself is tested in test_past_notes.mjs and test_past_notes_client.mjs. These checks keep the
// switch small and keep everything the other tests rely on in app.js as it was.

const sourceOf = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
const app = sourceOf("../frontend/app.js");
const html = sourceOf("../frontend/index.html");
const pastNotes = sourceOf("../frontend/past-notes.js");
const packageJson = JSON.parse(sourceOf("../package.json"));

function functionText(source, header) {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `${header} not found`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `end of ${header} not found`);
  return source.slice(start, end + 2);
}

const startSession = functionText(app, "async function startSession(");
const updateControls = functionText(app, "function updateControls(");
const connect = functionText(app, "function connectWebSocket(");

const at = (text, marker) => {
  const index = text.indexOf(marker);
  assert.ok(index >= 0, `${marker} not found`);
  return index;
};

// ---------- the import ----------

test("app.js imports the four functions it uses, written like the other imports, and all of them exist", () => {
  const line = 'import { appendPastNotes, loadPastNotes, readStoredUsePastNotes, writeStoredUsePastNotes } from "./past-notes.js";';
  assert.ok(app.includes(line));
  for (const name of ["appendPastNotes", "loadPastNotes", "readStoredUsePastNotes", "writeStoredUsePastNotes"]) {
    assert.match(pastNotes, new RegExp(`export (async )?function ${name}\\(`), name);
  }
  assert.equal([...app.matchAll(/^import /gm)].length, 8, "one import line was added to the seven it had");
});

// ---------- the page ----------

test("index.html has the switch row: hidden, off to start with, with a label, a permanent description and a message area", () => {
  assert.match(html, /<div id="pastnotes-row" class="autosave-row" hidden>/);
  assert.match(html, /<label class="switch">\s*<input id="pastnotes-switch" type="checkbox">\s*<span>過去のメモを使う<\/span>\s*<\/label>/);
  assert.doesNotMatch(html, /id="pastnotes-switch"[^>]*checked/, "off unless the saved value says on");
  const row = html.slice(at(html, '<div id="pastnotes-row"'), at(html, '<div id="note-save"'));
  assert.match(row, /<p class="help-text">[^<]*直近のメモ 3 件[^<]*Google に送られます[^<]*自動保存がオフだと、メモは増えません。<\/p>/);
  assert.match(row, /<p id="pastnotes-status" class="help-text" role="status" aria-live="polite"><\/p>/);
  assert.doesNotMatch(row, /<(script|img|iframe|a)\b/);
});

test("the row sits under the auto-save row and before the save result area, which the notes panel test keeps free of notes ids", () => {
  const autosave = at(html, '<div id="autosave-row"');
  const past = at(html, '<div id="pastnotes-row"');
  const result = at(html, '<div id="note-save"');
  assert.ok(autosave < past && past < result);
  assert.ok(html.slice(autosave, past).includes("</div>"), "the auto-save row is closed before the new one starts");
});

test("the page still has the two script tags it had, and no id is used twice", () => {
  assert.equal([...html.matchAll(/<script\b/g)].length, 2);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ["pastnotes-row", "pastnotes-switch", "pastnotes-status"]) assert.ok(ids.includes(id), id);
});

test("app.js looks the three elements up like the others", () => {
  assert.ok(app.includes('const pastNotesRow = document.querySelector("#pastnotes-row");'));
  assert.ok(app.includes('const pastNotesSwitch = document.querySelector("#pastnotes-switch");'));
  assert.ok(app.includes('const pastNotesStatus = document.querySelector("#pastnotes-status");'));
});

// ---------- hosted version only ----------

test("the row is shown from one place only: the place that shows the auto-save row", () => {
  assert.equal([...app.matchAll(/pastNotesRow\.hidden = false;/g)].length, 1);
  assert.match(functionText(app, "function showAutoSaveControls("), /pastNotesRow\.hidden = false;/);
  assert.equal([...app.matchAll(/pastNotesRow/g)].length, 2, "the lookup and the one place that shows it");
});

test("a conversation uses the notes only when the page is the hosted version and the switch is on, read once at the start", () => {
  assert.equal([...app.matchAll(/pastNotesSwitch\.checked/g)].length, 3, "the stored value, the saving of a change, and startSession");
  assert.equal([...startSession.matchAll(/pastNotesSwitch\.checked/g)].length, 1);
  assert.ok(startSession.includes("const usePastNotes = authRequired && pastNotesSwitch.checked;"));
  assert.equal([...startSession.matchAll(/\busePastNotes\b/g)].length, 2, "taken once, used once");
  const take = at(startSession, "const usePastNotes");
  assert.ok(take > at(startSession, "if (isStarting || isConnected) return;"), "after the guard");
  assert.ok(take < at(startSession, "audioContext = new AudioContext"), "before anything of the conversation starts");
});

// ---------- the switch itself ----------

test("the saved value is shown when the page opens and a change is saved; the storage stays inside past-notes.js", () => {
  assert.ok(app.includes("pastNotesSwitch.checked = readStoredUsePastNotes();"));
  assert.ok(app.indexOf("pastNotesSwitch.checked = readStoredUsePastNotes();") > app.indexOf("personaSelect.value = readStoredPersonaId();"));
  assert.ok(app.includes('pastNotesSwitch.addEventListener("change", () => writeStoredUsePastNotes(pastNotesSwitch.checked));'));
  assert.equal([...app.matchAll(/localStorage/g)].length, 2, "only the two auto-save lines name it, as before");
  assert.ok(!app.includes("ken.usePastNotes"), "the key lives in past-notes.js");
});

test("the switch is locked with the character menu, without changing updateControls", () => {
  // test_persona_app.mjs runs updateControls on its own, so it must not name anything new.
  assert.doesNotMatch(updateControls, /pastNotes/);
  const observer = app.match(/new MutationObserver\(\(\) => \{\s*pastNotesSwitch\.disabled = personaSelect\.disabled;\s*\}\)\.observe\(personaSelect, \{ attributes: true, attributeFilter: \["disabled"\] \}\);/);
  assert.ok(observer, "the switch follows the menu's disabled state");
  assert.equal([...app.matchAll(/new MutationObserver\(/g)].length, 1);
  assert.equal([...app.matchAll(/pastNotesSwitch\.disabled/g)].length, 1);
});

// ---------- start of a conversation ----------

test("the notes are asked for once, in startSession, only when on, before the microphone and the connection", () => {
  const call = "const pastNotesTask = usePastNotes ? loadPastNotes({ getIdToken: () => idToken }) : null;";
  assert.ok(startSession.includes(call));
  assert.equal([...app.matchAll(/loadPastNotes\(/g)].length, 1, "one place in the whole page");
  const task = at(startSession, call);
  assert.ok(task > at(startSession, "const usePastNotes"));
  assert.ok(task > at(startSession, "このブラウザーは必要な音声機能に対応していません"), "a browser that cannot start asks for nothing");
  assert.ok(task < at(startSession, "audioContext = new AudioContext"));
  assert.ok(task < at(startSession, "getUserMedia({"));
  assert.ok(task < at(startSession, 'fetch("/api/live-token"'));
  assert.doesNotMatch(call, /\bawait\b/, "it runs in the background while the microphone and the token are being got");
});

test("the answer is waited for just before the connection opens, and an old answer is dropped", () => {
  const wait = at(startSession, "const pastNotes = await pastNotesTask;");
  const connectCall = at(startSession, "await connectWebSocket(");
  assert.ok(wait < connectCall);
  assert.ok(wait > at(startSession, 'throw new Error("サーバーから不正なセッション情報が返されました。");'), "after the token is valid");
  assert.equal([...startSession.matchAll(/await pastNotesTask/g)].length, 1);
  const between = startSession.slice(wait, connectCall);
  assert.match(between, /if \(runId !== lifecycle\) return;/, "a stopped or restarted conversation drops the answer");
  assert.match(between, /pastNotesBlock = pastNotes\.block;/);
  assert.ok(between.indexOf("if (runId !== lifecycle) return;") < between.indexOf("pastNotesBlock = pastNotes.block;"));
  assert.match(startSession, /connectWebSocket\(\s*tokenData\.token,\s*tokenData\.model,\s*tokenData\.websocket_url,\s*runId,\s*persona\s*\)/);
});

test("the message is shown once the connection is set up, in the area of its own, and is cleared at the next start", () => {
  const cleared = at(startSession, 'pastNotesStatus.textContent = "";');
  assert.ok(cleared > at(startSession, "clearError();"));
  assert.ok(cleared < at(startSession, "audioContext = new AudioContext"));
  assert.ok(at(startSession, 'pastNotesBlock = "";') < at(startSession, "audioContext = new AudioContext"), "an old block is never carried over");
  const shown = at(startSession, "pastNotesStatus.textContent = pastNotesMessage;");
  assert.ok(shown > at(startSession, "await connectWebSocket("));
  assert.ok(shown < at(startSession, 'addModule("/pcm-worklet.js")'));
  assert.equal([...app.matchAll(/pastNotesStatus\.textContent/g)].length, 2, "cleared, and shown");
  assert.doesNotMatch(app, /pastNotesStatus\.(innerHTML|innerText|insertAdjacentHTML)/);
  assert.ok(!errorLine(app).includes("pastNotes"), "the fatal error area is not used");
});

function errorLine(source) {
  return functionText(source, "function showError(");
}

test("a failure of the notes never reaches the failure handling of the conversation", () => {
  assert.doesNotMatch(startSession, /pastNotesTask\s*\.\s*catch|try\s*\{[^}]*pastNotesTask/);
  assert.doesNotMatch(startSession, /throw[^;]*pastNotes/);
  assert.equal([...startSession.matchAll(/idToken\s*=[^=]/g)].length, 1, "only the one place that already cleared it after a 401 of the token request");
  assert.equal([...app.matchAll(/idToken\s*=[^=]/g)].length, 3, "as before: declaration, the one place that clears it, the sign-in callback");
});

// ---------- the setup message ----------

test("the setup message is built by the same line as before, and the frame is added to it right after", () => {
  const build = "const setup = buildSetupMessage(model, SYSTEM_INSTRUCTION, { voiceName: persona.voiceName, extraInstruction: persona.instruction });";
  const send = "activeSocket.send(JSON.stringify(setup));";
  assert.ok(connect.includes(build));
  assert.ok(connect.includes(send));
  assert.equal([...app.matchAll(/buildSetupMessage\(/g)].length, 1);
  assert.equal([...app.matchAll(/appendPastNotes\(/g)].length, 1);
  const lines = connect.split("\n").map((line) => line.trim());
  const buildAt = lines.indexOf(build);
  assert.equal(lines[buildAt + 1], "appendPastNotes(setup, pastNotesBlock);");
  assert.equal(lines[buildAt + 2], send);
  assert.equal(lines[buildAt + 3], 'pastNotesBlock = "";', "the block is not kept once it was sent");
  assert.match(connect, /^function connectWebSocket\(token, model, websocketBaseUrl, runId, persona\) \{/, "same arguments");
});

// ---------- what app.js still is ----------

test("app.js starts no request of its own for this: the two fetches it had are the only ones", () => {
  assert.equal([...app.matchAll(/\bfetch\(/g)].length, 2);
  assert.equal([...app.matchAll(/createNotesApi\(/g)].length, 1);
  assert.equal([...app.matchAll(/noteSaver\.submit\(/g)].length, 1);
  assert.equal([...app.matchAll(/new\s+AudioContext\s*\(/g)].length, 1);
  assert.doesNotMatch(app, /sessionStorage|indexedDB|\bconsole\b|innerHTML|outerHTML|insertAdjacentHTML/i);
});

test("the module keeps to what it promised: no log, no markup, no page access, no copy of the notes in storage", () => {
  assert.doesNotMatch(pastNotes, /\bconsole\b|sessionStorage|indexedDB|innerHTML|outerHTML|insertAdjacentHTML|\bdocument\b|wrangler/);
  assert.equal([...pastNotes.matchAll(/localStorage/g)].length, 1, "only the switch is stored");
  assert.equal([...pastNotes.matchAll(/\bfetch\(/g)].length, 0, "requests go through the existing notes client");
  assert.ok(pastNotes.includes('from "./notes-list-client.js"'));
});

test("no wrangler file was added (it would hide the dashboard settings from the functions)", () => {
  for (const name of ["wrangler.toml", "wrangler.jsonc", "wrangler.json"]) {
    assert.equal(existsSync(new URL(`../${name}`, import.meta.url)), false, name);
  }
});

// ---------- the test list ----------

test("package.json runs the three new test files with the frontend tests, after the ones it had", () => {
  const script = packageJson.scripts["test:frontend"];
  const names = ["tests/test_past_notes.mjs", "tests/test_past_notes_client.mjs", "tests/test_past_notes_app.mjs"];
  for (const name of names) assert.equal(script.split(/\s+/).filter((part) => part === name).length, 1, name);
  assert.ok(script.endsWith(names.join(" ")), "appended at the end, so the existing order is as it was");
  assert.ok(script.startsWith("node --test tests/test_error_messages.mjs "));
});
