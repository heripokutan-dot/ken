// Reads a small JSON request body, with a size limit. Used only after sign-in and the rate limit have passed.
// Same approach as functions/api/notes/index.ts (a declared Content-Length is checked first; the body is read in
// pieces and the read stops as soon as the limit is passed), but with its own, much smaller limit.
// Nothing here logs, returns or throws the text of the body.

export const MAX_JSON_BODY_BYTES = 1024;

export type JsonBody =
  | { kind: "empty" } // no body, or a body of zero bytes
  | { kind: "json"; value: unknown } // valid JSON of any shape; judging the shape is the caller's job
  | { kind: "too_large" } // over the limit (declared, or counted while reading)
  | { kind: "invalid" }; // could not be read, is not UTF-8, or is not JSON

// Reads at most maxBytes of the request body. Returns null as soon as the limit is exceeded.
export async function readLimitedBytes(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readJsonBody(request: Request, maxBytes: number = MAX_JSON_BODY_BYTES): Promise<JsonBody> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    return { kind: "too_large" }; // refused before reading anything
  }

  let bytes: Uint8Array | null;
  try {
    bytes = await readLimitedBytes(request, maxBytes);
  } catch {
    return { kind: "invalid" };
  }
  if (bytes === null) return { kind: "too_large" };
  if (bytes.byteLength === 0) return { kind: "empty" };

  try {
    return { kind: "json", value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown };
  } catch {
    return { kind: "invalid" };
  }
}
