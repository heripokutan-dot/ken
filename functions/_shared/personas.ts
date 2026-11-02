// The characters (personas) the token endpoint knows, and the voice each one asks for.
//
// This is the server's own copy of the table in frontend/personas.js: the same ids, in the same order, with the same
// voice names. This code never reads the page's file; a test (personas.test.ts) compares the two copies, so a change to
// one that is not made in the other fails the tests.
//
// A request names a character by id only. The voice always comes from this table, never from the request.
// "standard" has no voice (null): the token it gets is the same as before characters existed.
//
// NOT CONFIRMED: that these voice names exist for gemini-3.8-live (they are the experimental Puck, Charon and Kore).

export interface ServerPersona {
  readonly id: string;
  readonly voiceName: string | null;
}

export const PERSONAS: readonly ServerPersona[] = Object.freeze([
  Object.freeze({ id: "standard", voiceName: null }),
  Object.freeze({ id: "buddy", voiceName: "Puck" }),
  Object.freeze({ id: "teacher", voiceName: "Charon" }),
  Object.freeze({ id: "listener", voiceName: "Kore" }),
]);

// The character for an id. Only an exact match counts; anything else (wrong case, spaces, "__proto__", a number, an
// array, an object, null, ...) gives undefined, and the caller must refuse it. There is no fallback to "standard".
// Values are compared with ===, never used as a property name.
export function findPersona(value: unknown): ServerPersona | undefined {
  return PERSONAS.find((persona) => persona.id === value);
}
