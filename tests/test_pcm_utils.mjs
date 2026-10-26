import test from "node:test";
import assert from "node:assert/strict";
import { StreamingResampler, floatToPcm16, pcm16ToFloat } from "../frontend/pcm-utils.js";

test("floatToPcm16 clamps values and encodes little-endian signed PCM16", () => {
  const bytes = floatToPcm16(new Float32Array([0, 1, -1, 0.5]));
  assert.deepEqual([...bytes], [0, 0, 255, 127, 0, 128, 0, 64]);
});

test("pcm16ToFloat decodes little-endian signed PCM16", () => {
  assert.deepEqual(
    [...pcm16ToFloat(new Uint8Array([255, 127, 0, 128, 0, 0]))],
    [1, -1, 0],
  );
});

test("StreamingResampler emits approximately the target rate across chunk boundaries", () => {
  const resampler = new StreamingResampler(48000, 16000);
  const first = resampler.process(new Float32Array(480).fill(0.25));
  const second = resampler.process(new Float32Array(480).fill(-0.25));
  assert.equal(first.length, 160);
  assert.equal(second.length, 160);
  assert.ok(Math.abs(first[0] - 0.25) < 0.001);
  assert.ok(Math.abs(second.at(-1) + 0.25) < 0.001);
});

test("StreamingResampler rejects invalid sample rates", () => {
  assert.throws(() => new StreamingResampler(0, 16000), /sample rate/i);
});
