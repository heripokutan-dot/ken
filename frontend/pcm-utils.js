export class StreamingResampler {
  constructor(inputRate, outputRate) {
    if (!Number.isFinite(inputRate) || !Number.isFinite(outputRate) || inputRate <= 0 || outputRate <= 0) {
      throw new RangeError("sample rate must be a positive finite number");
    }
    this.step = inputRate / outputRate;
    this.nextOutputPosition = 0;
    this.inputIndex = 0;
    this.lastSample = 0;
    this.hasSample = false;
  }

  process(input) {
    const output = [];
    for (let i = 0; i < input.length; i += 1) {
      const current = input[i];
      const index = this.inputIndex;
      if (!this.hasSample) {
        while (this.nextOutputPosition <= index) {
          output.push(current);
          this.nextOutputPosition += this.step;
        }
        this.lastSample = current;
        this.hasSample = true;
        this.inputIndex += 1;
        continue;
      }

      const previousIndex = index - 1;
      while (this.nextOutputPosition <= index) {
        const fraction = Math.max(0, Math.min(1, this.nextOutputPosition - previousIndex));
        output.push(this.lastSample + (current - this.lastSample) * fraction);
        this.nextOutputPosition += this.step;
      }
      this.lastSample = current;
      this.inputIndex += 1;
    }
    return Float32Array.from(output);
  }
}

export function floatToPcm16(samples) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    const value = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
    view.setInt16(i * 2, value, true);
  }
  return bytes;
}

export function pcm16ToFloat(bytes) {
  if (bytes.byteLength % 2 !== 0) {
    throw new RangeError("PCM16 data must contain an even number of bytes");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(bytes.byteLength / 2);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = view.getInt16(i * 2, true) / 32768;
  }
  return samples;
}
