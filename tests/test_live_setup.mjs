import test from "node:test";
import assert from "node:assert/strict";
import { buildSetupMessage } from "../frontend/live-setup.js";

test("responseModalities is inside generationConfig, not directly under setup", () => {
  const { setup } = buildSetupMessage("gemini-3.8-live", "指示");
  assert.equal("responseModalities" in setup, false);
  assert.deepEqual(setup.generationConfig, { responseModalities: ["AUDIO"] });
  assert.equal(setup.model, "models/gemini-3.8-live");
  assert.deepEqual(setup.systemInstruction, { parts: [{ text: "指示" }] });
  assert.deepEqual(setup.inputAudioTranscription, {});
  assert.deepEqual(setup.outputAudioTranscription, {});
});
