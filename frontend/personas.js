// The characters that can be picked from the menu. A character is a voice plus a short addition to the system
// instruction. "standard" is the default: it asks for no voice and adds nothing, so its setup message is the same
// as it was before characters existed.
//
// Voices: buddy = Pulcherrima, teacher = Algieba, listener = Despina; standard has none.
// The same table is kept in functions/_shared/personas.ts (a test compares the two). Change both together.
//
// Where the voice has to be: a voice sent only in the browser's setup message (the speechConfig built from this table)
// did NOT change the voice. A voice put into the short-lived Gemini token did. The server does that from the character's
// id, so the page also sends the id when it asks for the token (never the voice name), and still sends the same voice in
// the setup message. Why the token matters is NOT CONFIRMED.
//
// NOT CONFIRMED (see docs/project-status.md):
//   - Algieba is not confirmed against Google's official list of voices. A name must not be changed on a guess; if one is
//     not accepted, a real device shows it.
//   - how far the token's lock reaches, and what happens if the token and the browser's setup disagree.
//
// When a voice does not work, read what the page shows:
//   - an error right after the conversation starts (the token request was refused): the token could not be issued;
//   - the connection closes before the setup finishes (a close code and reason are shown): the connection was refused;
//   - no error, but the voice sounds like "standard": the voice setting has no effect.
// "standard" always works as before.
//
// A choice is kept (and remembered on the phone) as one of these ids, never as a voice name or as Japanese text.

const PRIORITY = "共通の指示と話し方が合わない場合は、この役割の話し方を優先すること。";

export const PERSONAS = Object.freeze([
  Object.freeze({ id: "standard", label: "標準", voiceName: null, instruction: "" }),
  Object.freeze({
    id: "buddy",
    label: "相棒",
    voiceName: "Pulcherrima",
    instruction: "明るく積極的に話し、返事は短く、話を前に進める。",
  }),
  Object.freeze({
    id: "teacher",
    label: "先生",
    voiceName: "Algieba",
    instruction: `落ち着いて丁寧に話し、必要に応じて例え話で説明する。${PRIORITY}`,
  }),
  Object.freeze({
    id: "listener",
    label: "聞き役",
    voiceName: "Despina",
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
