import { StreamingResampler, floatToPcm16 } from "./pcm-utils.js";

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const chunkSamples = options.processorOptions?.chunkSamples ?? 320;
    this.chunkSamples = Math.max(160, Math.floor(chunkSamples));
    this.resampler = new StreamingResampler(sampleRate, 16000);
    this.pending = new Float32Array(this.chunkSamples);
    this.pendingLength = 0;
    this.stopped = false;

    this.port.onmessage = (event) => {
      if (event.data?.type === "stop") {
        this.stopped = true;
      }
    };
  }

  process(inputs) {
    if (this.stopped) return false;

    const channels = inputs[0];
    if (!channels || channels.length === 0 || channels[0].length === 0) return true;

    const frameCount = channels[0].length;
    const mono = new Float32Array(frameCount);
    for (let channel = 0; channel < channels.length; channel += 1) {
      const samples = channels[channel];
      for (let i = 0; i < frameCount; i += 1) {
        mono[i] += samples[i] / channels.length;
      }
    }

    const resampled = this.resampler.process(mono);
    for (let i = 0; i < resampled.length; i += 1) {
      this.pending[this.pendingLength] = resampled[i];
      this.pendingLength += 1;

      if (this.pendingLength === this.chunkSamples) {
        const pcm = floatToPcm16(this.pending);
        this.port.postMessage({ type: "audio", buffer: pcm.buffer }, [pcm.buffer]);
        this.pending = new Float32Array(this.chunkSamples);
        this.pendingLength = 0;
      }
    }

    return true;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
