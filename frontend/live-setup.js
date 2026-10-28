// Builds the first WebSocket message for Gemini Live. Field placement follows Google's BidiGenerateContentSetup:
// responseModalities belongs inside generationConfig (Google closed the socket with code 1007,
// 'Unknown name "responseModalities" at setup', when it was placed directly under setup).
export function buildSetupMessage(model, systemInstruction) {
  return {
    setup: {
      model: `models/${model}`,
      generationConfig: { responseModalities: ["AUDIO"] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      systemInstruction: { parts: [{ text: systemInstruction }] },
    },
  };
}

// Gemini Live delivers JSON as text frames or as binary frames (Blob / ArrayBuffer in browsers).
// Returns the JSON text, or throws if the payload is not something that can be read as text.
export async function messageDataToText(data) {
  if (typeof data === "string") return data;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder("utf-8", { fatal: true }).decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder("utf-8", { fatal: true }).decode(data);
  throw new Error("unsupported_message_type");
}
