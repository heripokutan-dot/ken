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
