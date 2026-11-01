import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PERSONAS, DEFAULT_PERSONA_ID } from "../frontend/personas.js";

// Static checks of how app.js, index.html and styles.css use the character menu, in the same style as
// test_notes_list_app.mjs and test_playback_reset_app.mjs. Nothing here runs the page, except that the real text of
// updateControls is run against stand-in elements to see when the menu can be pressed.

const sourceOf = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
const app = sourceOf("../frontend/app.js");
const html = sourceOf("../frontend/index.html");
const css = sourceOf("../frontend/styles.css");

// The whole function, closing brace included (a function ends at the first "}" that starts a line).
function functionText(source, header) {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `${header} not found`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `end of ${header} not found`);
  return source.slice(start, end + 2);
}

// ---- reading personas.js, and the common instruction --------------------------------------------------------------

test("personas.js is read like live-setup.js: one plain import, and no new script tag in the page", () => {
  assert.match(app, /^import \{ buildSetupMessage, messageDataToText \} from "\.\/live-setup\.js";$/m);
  assert.match(app, /^import \{ getPersona, readStoredPersonaId, writeStoredPersonaId \} from "\.\/personas\.js";$/m);
  assert.equal([...html.matchAll(/<script\b/g)].length, 2, "the two scripts it had");
  assert.ok(!html.includes("personas.js"), "the page does not name the module; app.js imports it");
});

test("the common instruction in app.js is exactly what it was", () => {
  const original =
    'const SYSTEM_INSTRUCTION =\n' +
    '  "あなたは日本語で自然に会話する音声アシスタントです。" +\n' +
    '  "簡潔で親しみやすく、相手の発話に直接答えてください。";\n';
  assert.ok(app.includes(original));
  assert.equal([...app.matchAll(/SYSTEM_INSTRUCTION\s*=/g)].length, 1);
});

// ---- the menu in the page -----------------------------------------------------------------------------------------

test("the menu sits directly above the conversation buttons, with a label, the four options and the notice", () => {
  const row = html.match(/<div class="persona-row">([\s\S]*?)<\/div>\s*<div class="controls"/);
  assert.ok(row, "a persona-row block directly before the controls");
  const inside = row[1];

  assert.match(inside, /<label[^>]*\bfor="persona-select"[^>]*>[^<]+<\/label>/);
  assert.equal([...html.matchAll(/id="persona-select"/g)].length, 1, "the id is used once");
  assert.match(inside, /<select[^>]*\bid="persona-select"[^>]*>/);

  const options = [...inside.matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)<\/option>/g)].map((m) => ({
    id: m[1],
    selected: /\bselected\b/.test(m[2]),
    label: m[3],
  }));
  assert.deepEqual(options.map(({ id, label }) => ({ id, label })), PERSONAS.map(({ id, label }) => ({ id, label })));
  assert.deepEqual(options.filter((o) => o.selected).map((o) => o.id), [DEFAULT_PERSONA_ID]);

  const select = inside.indexOf("</select>");
  const notice = inside.indexOf("次に会話を始めたときから変わります");
  assert.ok(select >= 0 && notice > select, "the notice is under the menu");
  assert.match(inside.slice(inside.lastIndexOf("<p", notice), notice), /^<p class="help-text">$/, "always shown: not hidden");
});

test("app.js looks the menu up by that id, in the same way as the other elements", () => {
  assert.ok(app.includes('const personaSelect = document.querySelector("#persona-select");'));
});

test("the menu text is 16px or larger, so iPhone Safari does not zoom in when it is tapped", () => {
  const rule = css.match(/\.persona-select\s*\{([^}]*)\}/);
  assert.ok(rule, ".persona-select rule");
  const size = rule[1].match(/font-size:\s*(\d+(?:\.\d+)?)px/);
  assert.ok(size, "font-size in px");
  assert.ok(Number(size[1]) >= 16, `font-size is ${size[1]}px`);
});

// ---- the menu can only be used while no conversation is starting, running or ending -------------------------------

function menuDisabledFor(state) {
  const names = ["startButton", "interruptButton", "stopButton", "personaSelect", "authRequired", "idToken",
    "isStarting", "isConnected", "socket", "microphoneStream", "audioContext"];
  const elements = { startButton: {}, interruptButton: {}, stopButton: {}, personaSelect: {} };
  const idle = { authRequired: false, idToken: null, isStarting: false, isConnected: false, socket: null, microphoneStream: null, audioContext: null };
  const values = { ...elements, ...idle, ...state };
  const run = new Function(...names, `${functionText(app, "function updateControls(")}\nupdateControls();`);
  run(...names.map((name) => values[name]));
  return elements.personaSelect.disabled;
}

test("the menu can be used when idle", () => {
  assert.equal(menuDisabledFor({}), false);
  assert.equal(menuDisabledFor({ authRequired: true, idToken: null }), false, "before sign-in the choice can still be made");
});

test("the menu cannot be used while a conversation is starting or running", () => {
  assert.equal(menuDisabledFor({ isStarting: true }), true);
  assert.equal(menuDisabledFor({ isConnected: true }), true);
});

test("the menu stays locked while a conversation is ending, as long as anything of it is still held", () => {
  assert.equal(menuDisabledFor({ socket: {} }), true);
  assert.equal(menuDisabledFor({ microphoneStream: {} }), true);
  assert.equal(menuDisabledFor({ audioContext: {} }), true);
});

test("the menu follows the same states as the stop button", () => {
  const body = functionText(app, "function updateControls(");
  const stop = body.match(/stopButton\.disabled = !\(([^)]*)\);/);
  const menu = body.match(/personaSelect\.disabled = Boolean\(([^)]*)\);/);
  assert.ok(stop && menu);
  assert.equal(menu[1], stop[1]);
});

// ---- the choice made when the conversation starts is the one used -------------------------------------------------

test("startSession takes the choice once, right after its guard and before anything else starts", () => {
  const start = functionText(app, "async function startSession(");
  const guard = start.indexOf("if (isStarting || isConnected) return;");
  const take = start.indexOf("const persona = getPersona(personaSelect.value);");
  const context = start.search(/audioContext\s*=\s*new\s+AudioContext/);
  assert.ok(guard >= 0, "the guard is still there");
  assert.ok(take > guard, "taken after the guard");
  assert.ok(context > take, "taken before the AudioContext is created");
  assert.equal([...start.matchAll(/getPersona\(/g)].length, 1);
  assert.match(start, /connectWebSocket\(\s*tokenData\.token,\s*tokenData\.model,\s*tokenData\.websocket_url,\s*runId,\s*persona\s*\)/);
});

test("the setup message is built in one place, with the common text, the voice and the extra instruction of that choice", () => {
  assert.equal([...app.matchAll(/buildSetupMessage\(/g)].length, 1);
  const connect = functionText(app, "function connectWebSocket(");
  assert.match(connect, /^function connectWebSocket\(token, model, websocketBaseUrl, runId, persona\) \{/);
  assert.match(
    connect,
    /buildSetupMessage\(\s*model,\s*SYSTEM_INSTRUCTION,\s*\{\s*voiceName:\s*persona\.voiceName,\s*extraInstruction:\s*persona\.instruction\s*\}\s*\)/,
  );
});

// ---- remembering the choice ---------------------------------------------------------------------------------------

test("the saved choice is shown when the page opens, and a change is saved; storage stays inside personas.js", () => {
  assert.match(app, /personaSelect\.value\s*=\s*readStoredPersonaId\(\)\s*;/);
  const handler = app.match(/personaSelect\.addEventListener\("change",[\s\S]*?\n\}\);/);
  assert.ok(handler, "a change handler");
  assert.match(handler[0], /getPersona\(personaSelect\.value\)/);
  assert.match(handler[0], /writeStoredPersonaId\(/);
  assert.equal([...app.matchAll(/localStorage/g)].length, 2, "only the two auto-save lines name localStorage");
  assert.ok(!app.includes('"ken.persona"'), "the key lives in personas.js");
});
