// The characters that can be picked from the menu. A character is a voice plus a short addition to the system
// instruction. "standard" is the default: it asks for no voice and adds nothing, so its setup message is the same
// as it was before characters existed.
//
// EXPERIMENT (temporary change, to see whether a voice takes effect at all):
// The voice names below were swapped from Pulcherrima / Algieba / Despina (buddy / teacher / listener) to
// Puck / Charon / Kore. They are names that appear in Google's general voice list, chosen from general knowledge and
// NOT checked against the official list. Whether they work with gemini-3.8-live is not confirmed.
//
// NOT CONFIRMED for gemini-3.8-live (see docs/project-status.md):
//   - that these voice names exist for that model, and
//   - that a voice is accepted at generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName at all.
// If a voice does not work, Google closes the socket and the page shows the close code; "standard" always works as before.
//
// A choice is kept (and remembered on the phone) as one of these ids, never as a voice name or as Japanese text.

const PRIORITY = "共通の指示と話し方が合わない場合は、この役割の話し方を優先すること。";

export const PERSONAS = Object.freeze([
  Object.freeze({ id: "standard", label: "標準", voiceName: null, instruction: "" }),
  Object.freeze({
    id: "buddy",
    label: "相棒",
    voiceName: "Puck",
    instruction: "明るく積極的に話し、返事は短く、話を前に進める。",
  }),
  Object.freeze({
    id: "teacher",
    label: "先生",
    voiceName: "Charon",
    instruction: `落ち着いて丁寧に話し、必要に応じて例え話で説明する。${PRIORITY}`,
  }),
  Object.freeze({
    id: "listener",
    label: "聞き役",
    voiceName: "Kore",
    instruction: `穏やかに話し、まず受け止めてから、質問を一つ返す。${PRIORITY}`,
  }),
]);

export const DEFAULT_PERSONA_ID = "standard";
export const PERSONA_STORAGE_KEY = "ken.persona";

// The character for an id. Only an exact match counts; anything else (an unknown or damaged saved value, a number,
// an object, "__proto__", ...) gives the default. Values are compared, never used as a property name.
export function getPersona(value) {
  return (
    PERSONAS.find((persona) => persona.id === value) ??
    PERSONAS.find((persona) => persona.id === DEFAULT_PERSONA_ID)
  );
}

export function resolvePersonaId(value) {
  return getPersona(value).id;
}

// Looking up localStorage can itself throw (blocked storage), so it happens inside the try, like the auto-save switch.
const pageStorage = () => localStorage;

export function readStoredPersonaId(getStorage = pageStorage) {
  try {
    return resolvePersonaId(getStorage().getItem(PERSONA_STORAGE_KEY));
  } catch {
    return DEFAULT_PERSONA_ID;
  }
}

export function writeStoredPersonaId(value, getStorage = pageStorage) {
  try {
    getStorage().setItem(PERSONA_STORAGE_KEY, resolvePersonaId(value));
  } catch {
    // Without storage the menu still works for this page view.
  }
}
