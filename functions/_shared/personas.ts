// The characters (personas) the token endpoint knows, and the voice each one asks for.
//
// This is the server's own copy of the table in frontend/personas.js: the same ids, in the same order, with the same
// voice names. This code never reads the page's file; a test (personas.test.ts) compares the two copies, so a change to
// one that is not made in the other fails the tests. Change both together.
//
// A request names a character by id only. The voice always comes from this table, never from the request.
// "standard" has no voice (null): the token it gets is the same as before characters existed.
//
// Voices: buddy = Pulcherrima, teacher = Algieba, listener = Despina.
// This table is what puts the voice into the short-lived Gemini token. That changed the voice on a real device; a voice
// sent only in the browser's setup message did not. Why is NOT CONFIRMED.
//
// NOT CONFIRMED: Algieba is not confirmed against Google's official list of voices (a name must not be changed on a
// guess); how far the token's lock reaches; what happens if the token and the browser's setup disagree.
//
// When a voice does not work: refused right when the conversation starts = the token could not be issued (the 502 shows
// Google's reason and field); closed after connecting = the connection was refused; no error, but the voice is the same
// as "standard" = the voice setting has no effect.

export interface ServerPersona {
  readonly id: string;
  readonly voiceName: string | null;
}

export const PERSONAS: readonly ServerPersona[] = Object.freeze([
  Object.freeze({ id: "standard", voiceName: null }),
  Object.freeze({ id: "buddy", voiceName: "Pulcherrima" }),
  Object.freeze({ id: "teacher", voiceName: "Algieba" }),
  Object.freeze({ id: "listener", voiceName: "Despina" }),
]);

// The character for an id. Only an exact match counts; anything else (wrong case, spaces, "__proto__", a number, an
// array, an object, null, ...) gives undefined, and the caller must refuse it. There is no fallback to "standard".
// Values are compared with ===, never used as a property name.
export function findPersona(value: unknown): ServerPersona | undefined {
  return PERSONAS.find((persona) => persona.id === value);
}
