import test from "node:test";
import assert from "node:assert/strict";
import { buildSetupMessage, messageDataToText } from "../frontend/live-setup.js";

test("responseModalities is inside generationConfig, not directly under setup", () => {
  const { setup } = buildSetupMessage("gemini-3.8-live", "指示");
  assert.equal("responseModalities" in setup, false);
  assert.deepEqual(setup.generationConfig, { responseModalities: ["AUDIO"] });
  assert.equal(setup.model, "models/gemini-3.8-live");
  assert.deepEqual(setup.systemInstruction, { parts: [{ text: "指示" }] });
  assert.deepEqual(setup.inputAudioTranscription, {});
  assert.deepEqual(setup.outputAudioTranscription, {});
});

test("binary and text WebSocket frames are decoded to JSON text", async () => {
  const json = JSON.stringify({ setupComplete: {} });
  assert.equal(await messageDataToText(json), json);
  assert.equal(await messageDataToText(new Blob([json])), json);
  assert.equal(await messageDataToText(new TextEncoder().encode(json).buffer), json);
  assert.equal(await messageDataToText(new TextEncoder().encode(json)), json);
  await assert.rejects(messageDataToText(42), /unsupported_message_type/);
  await assert.rejects(messageDataToText(new Uint8Array([0xff, 0xfe, 0xfd])));
});
