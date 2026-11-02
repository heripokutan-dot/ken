import test from "node:test";
import assert from "node:assert/strict";
import {
  PERSONAS,
  DEFAULT_PERSONA_ID,
  PERSONA_STORAGE_KEY,
  resolvePersonaId,
  getPersona,
  readStoredPersonaId,
  writeStoredPersonaId,
} from "../frontend/personas.js";
import { buildSetupMessage } from "../frontend/live-setup.js";

// The common instruction every character keeps. It is copied here on purpose: tests/test_persona_app.mjs checks
// that app.js still holds exactly this text, so a change to it has to be made (and noticed) in both places.
const COMMON = "あなたは日本語で自然に会話する音声アシスタントです。簡潔で親しみやすく、相手の発話に直接答えてください。";
const PRIORITY = "共通の指示と話し方が合わない場合は、この役割の話し方を優先すること。";
const MODEL = "gemini-3.8-live";

// What the setup message was before characters existed (two-argument call), written out character for character.
const SETUP_BEFORE =
  '{"setup":{"model":"models/gemini-3.8-live","generationConfig":{"responseModalities":["AUDIO"]},' +
  '"inputAudioTranscription":{},"outputAudioTranscription":{},' +
  `"systemInstruction":{"parts":[{"text":"${COMMON}"}]}}}`;

const AGREED = [
  { id: "standard", label: "標準", voiceName: null, instruction: "" },
  { id: "buddy", label: "相棒", voiceName: "Pulcherrima", instruction: "明るく積極的に話し、返事は短く、話を前に進める。" },
  { id: "teacher", label: "先生", voiceName: "Algieba", instruction: `落ち着いて丁寧に話し、必要に応じて例え話で説明する。${PRIORITY}` },
  { id: "listener", label: "聞き役", voiceName: "Despina", instruction: `穏やかに話し、まず受け止めてから、質問を一つ返す。${PRIORITY}` },
];

// Anything that is not exactly one of the four ids. Several of these are what a tampered or damaged saved value could be.
const NOT_AN_ID = [
  undefined, null, "", " ", "Buddy", "BUDDY", " buddy", "buddy ", "buddy\n", "unknown", "__proto__", "constructor",
  "prototype", "toString", "hasOwnProperty", "0", "1", "null", "undefined", "true", "[object Object]", "buddy,teacher",
  "相棒", "Pulcherrima", "x".repeat(10000),
  0, 1, -1, NaN, true, false, 10n, Symbol("buddy"),
  {}, { id: "buddy" }, ["buddy"], [], () => "buddy", new String("buddy"),
  { toString: () => "buddy" }, { valueOf: () => "buddy" },
];

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  const calls = [];
  return {
    data,
    calls,
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      calls.push([key, value]);
      data.set(key, String(value));
    },
  };
}

// ---- the four characters -------------------------------------------------------------------------------------------

test("the four characters, in menu order, are exactly the agreed ones", () => {
  assert.deepEqual(PERSONAS.map((persona) => ({ ...persona })), AGREED);
});

test("the default is standard, which asks for no voice and adds no text", () => {
  assert.equal(DEFAULT_PERSONA_ID, "standard");
  const standard = getPersona(DEFAULT_PERSONA_ID);
  assert.equal(standard.voiceName, null);
  assert.equal(standard.instruction, "");
});

test("the list cannot be changed while the page runs", () => {
  assert.ok(Object.isFrozen(PERSONAS));
  for (const persona of PERSONAS) assert.ok(Object.isFrozen(persona), persona.id);
});

test("the teacher and the listener say that their way of speaking wins over the common instruction", () => {
  for (const id of ["teacher", "listener"]) assert.ok(getPersona(id).instruction.endsWith(PRIORITY), id);
  for (const id of ["standard", "buddy"]) assert.ok(!getPersona(id).instruction.includes(PRIORITY), id);
});

// ---- choosing a character, and bad values --------------------------------------------------------------------------

test("every valid id is kept as it is", () => {
  for (const { id } of AGREED) assert.equal(resolvePersonaId(id), id);
});

test("anything that is not exactly one of the ids becomes standard", () => {
  for (const value of NOT_AN_ID) assert.equal(resolvePersonaId(value), "standard", String(typeof value));
});

test("getPersona gives the character for a valid id, and standard for anything else", () => {
  for (const expected of AGREED) assert.deepEqual({ ...getPersona(expected.id) }, expected);
  for (const value of NOT_AN_ID) assert.equal(getPersona(value).id, "standard");
});

// ---- remembering the choice ----------------------------------------------------------------------------------------

test("the choice is remembered under the key ken.persona", () => {
  assert.equal(PERSONA_STORAGE_KEY, "ken.persona");
});

test("a saved valid id is read back", () => {
  for (const { id } of AGREED) {
    const storage = fakeStorage({ [PERSONA_STORAGE_KEY]: id });
    assert.equal(readStoredPersonaId(() => storage), id);
  }
});

test("nothing saved gives standard", () => {
  assert.equal(readStoredPersonaId(() => fakeStorage()), "standard");
});

test("a saved value that is not a valid id gives standard", () => {
  for (const value of NOT_AN_ID) {
    const storage = { getItem: () => value };
    assert.equal(readStoredPersonaId(() => storage), "standard", String(typeof value));
  }
});

test("reading never throws: storage that cannot be reached, or that fails while reading, gives standard", () => {
  assert.equal(readStoredPersonaId(() => { throw new Error("blocked"); }), "standard");
  assert.equal(readStoredPersonaId(() => undefined), "standard");
  assert.equal(readStoredPersonaId(() => null), "standard");
  assert.equal(readStoredPersonaId(() => ({ getItem: () => { throw new Error("denied"); } })), "standard");
  assert.equal(readStoredPersonaId(() => ({})), "standard");
});

test("writing stores the id, once, under ken.persona", () => {
  for (const { id } of AGREED) {
    const storage = fakeStorage();
    writeStoredPersonaId(id, () => storage);
    assert.deepEqual(storage.calls, [["ken.persona", id]]);
  }
});

test("writing a value that is not a valid id stores standard", () => {
  for (const value of NOT_AN_ID) {
    const storage = fakeStorage();
    writeStoredPersonaId(value, () => storage);
    assert.deepEqual(storage.calls, [["ken.persona", "standard"]], String(typeof value));
  }
});

test("writing never throws, whatever the storage does", () => {
  assert.doesNotThrow(() => writeStoredPersonaId("buddy", () => { throw new Error("blocked"); }));
  assert.doesNotThrow(() => writeStoredPersonaId("buddy", () => undefined));
  assert.doesNotThrow(() => writeStoredPersonaId("buddy", () => ({ setItem: () => { throw new Error("full"); } })));
  assert.doesNotThrow(() => writeStoredPersonaId("buddy", () => ({})));
});

test("without a storage argument, the page's localStorage is used", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = fakeStorage({ [PERSONA_STORAGE_KEY]: "listener" });
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  try {
    assert.equal(readStoredPersonaId(), "listener");
    writeStoredPersonaId("teacher");
    assert.deepEqual(storage.calls, [["ken.persona", "teacher"]]);
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
  }
});

// ---- the setup message ---------------------------------------------------------------------------------------------

test("without a voice and an extra instruction, the setup message is exactly what it was before", () => {
  assert.equal(JSON.stringify(buildSetupMessage(MODEL, COMMON)), SETUP_BEFORE);
});

test("standard gives that same message, character for character", () => {
  const standard = getPersona("standard");
  const message = buildSetupMessage(MODEL, COMMON, { voiceName: standard.voiceName, extraInstruction: standard.instruction });
  assert.equal(JSON.stringify(message), SETUP_BEFORE);
  assert.equal("speechConfig" in message.setup.generationConfig, false);
});

test("a voice goes into generationConfig, next to responseModalities, and nowhere else", () => {
  const { setup } = buildSetupMessage(MODEL, COMMON, { voiceName: "Pulcherrima" });
  assert.deepEqual(setup.generationConfig, {
    responseModalities: ["AUDIO"],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Pulcherrima" } } },
  });
  assert.equal("speechConfig" in setup, false);
  assert.equal("responseModalities" in setup, false);
});

test("the extra instruction follows the common text, which stays exactly as it was", () => {
  for (const persona of PERSONAS) {
    const { setup } = buildSetupMessage(MODEL, COMMON, { voiceName: persona.voiceName, extraInstruction: persona.instruction });
    const text = setup.systemInstruction.parts[0].text;
    assert.ok(text.startsWith(COMMON), persona.id);
    assert.equal(text, COMMON + persona.instruction, persona.id);
    assert.equal(setup.systemInstruction.parts.length, 1);
  }
});

test("every character gives the agreed voice, and only the characters with a voice add a speechConfig", () => {
  for (const persona of AGREED) {
    const { setup } = buildSetupMessage(MODEL, COMMON, { voiceName: persona.voiceName, extraInstruction: persona.instruction });
    const voice = setup.generationConfig.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName ?? null;
    assert.equal(voice, persona.voiceName, persona.id);
  }
});

test("an empty or non-text voice or extra instruction is ignored, and so are options that are not an object", () => {
  for (const bad of [undefined, null, "", 5, {}, [], true]) {
    assert.equal(JSON.stringify(buildSetupMessage(MODEL, COMMON, { voiceName: bad })), SETUP_BEFORE, `voiceName ${String(bad)}`);
    assert.equal(JSON.stringify(buildSetupMessage(MODEL, COMMON, { extraInstruction: bad })), SETUP_BEFORE, `extra ${String(bad)}`);
  }
  for (const bad of [null, 5, "buddy", true, []]) {
    assert.equal(JSON.stringify(buildSetupMessage(MODEL, COMMON, bad)), SETUP_BEFORE, `options ${String(bad)}`);
  }
});

test("the other parts of the setup message keep their names and order", () => {
  const { setup } = buildSetupMessage(MODEL, COMMON, { voiceName: "Despina", extraInstruction: "追加。" });
  assert.deepEqual(Object.keys(setup), ["model", "generationConfig", "inputAudioTranscription", "outputAudioTranscription", "systemInstruction"]);
  assert.equal(setup.model, "models/gemini-3.8-live");
  assert.deepEqual(setup.inputAudioTranscription, {});
  assert.deepEqual(setup.outputAudioTranscription, {});
});
