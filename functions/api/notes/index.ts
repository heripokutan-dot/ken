// /api/notes and /api/notes/<id> — Cloudflare Pages Function (saved conversation notes in D1).
//
//   GET    /api/notes                         list (no body text, newest first)
//   POST   /api/notes                         save   { "body": string, "title"?: string, "persona"?: string }
//   DELETE /api/notes?confirm=delete-all      delete every note (refused without the confirmation value)
//   GET    /api/notes/<id>                    one note, with its body
//   DELETE /api/notes/<id>                    delete one note
//
// Order (same as live-token): route + method -> same-origin checks -> configuration (503) -> sign-in verification
//        (google | access) -> allowlisted email -> rate limit (D1) -> request body (POST only) -> D1.
// Nothing (note text, email, token, provider error text) is logged or echoed back on failure.
// The sign-in part is a copy of live-token.ts on purpose: live-token.ts is not touched.

import { errorResponse, SECURITY_HEADERS } from "../../_shared/http-security.ts";
import { verifyAccessJwt } from "../../_shared/access-auth.ts";
import { verifyGoogleIdToken } from "../../_shared/google-auth.ts";
import { checkRateLimit } from "../../_shared/rate-limit.ts";
import type { NotesD1Like } from "./d1.ts";
import { BODY_MAX_CHARS, PERSONA_MAX_CHARS, TITLE_MAX_CHARS, TRUNCATION_MARK, clipText } from "./text.ts";

export interface NotesEnv {
  AUTH_PROVIDER?: string; // "google" (default recommended) or "access"
  ALLOWED_EMAIL?: string;
  GOOGLE_CLIENT_ID?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUDIENCE?: string;
  RATE_LIMIT_DB?: NotesD1Like; // the existing binding; it holds the notes table too
}

// Separate keys ("notes:...") from live-token's bare-email key. The window stays 60 seconds because
// checkRateLimit prunes every key's rows older than the current window.
export const NOTES_WRITE_RATE_LIMIT = { limit: 10, windowSeconds: 60 }; // save + delete one + delete all
export const NOTES_READ_RATE_LIMIT = { limit: 30, windowSeconds: 60 }; // list + get one
export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_NOTES = 200;
export const DELETE_ALL_CONFIRMATION = "delete-all";

type Operation = "list" | "get" | "save" | "delete" | "delete_all";

interface NoteRow {
  id: string;
  created_at: number;
  persona: string;
  title: string;
  truncated: number;
  body?: string;
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

function summarize(row: NoteRow) {
  return {
    id: row.id,
    created_at: row.created_at,
    persona: row.persona,
    title: row.title,
    truncated: row.truncated === 1,
  };
}

// Same sign-in handling as live-token.ts.
async function authenticate(
  request: Request,
  env: NotesEnv,
  fetcher: typeof fetch,
  allowedEmail: string,
): Promise<{ email: string } | Response> {
  const provider = env.AUTH_PROVIDER;
  try {
    if (provider === "google") {
      const bearer = request.headers.get("Authorization") ?? "";
      const match = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(bearer);
      if (!match) return errorResponse(401, "unauthenticated");
      const user = await verifyGoogleIdToken(
        match[1],
        { clientId: env.GOOGLE_CLIENT_ID ?? "", allowedEmail },
        fetcher,
      );
      return { email: user.email };
    }
    if (provider === "access") {
      const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
      if (!jwt) return errorResponse(401, "unauthenticated");
      const user = await verifyAccessJwt(
        jwt,
        { teamDomain: env.ACCESS_TEAM_DOMAIN ?? "", audience: env.ACCESS_AUDIENCE ?? "" },
        fetcher,
      );
      return { email: user.email };
    }
  } catch {
    return errorResponse(401, "unauthenticated");
  }
  return errorResponse(503, "service_misconfigured");
}

// Reads at most maxBytes of the request body. Returns null as soon as the limit is exceeded.
async function readLimitedBytes(request: Request, maxBytes: number): Promise<Uint8Array | null> {
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

function optionalText(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : null; // null = wrong type
}

async function saveNote(request: Request, db: NotesD1Like): Promise<Response> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_REQUEST_BYTES) {
    return errorResponse(413, "payload_too_large"); // rejected before reading anything
  }

  let bytes: Uint8Array | null;
  try {
    bytes = await readLimitedBytes(request, MAX_REQUEST_BYTES);
  } catch {
    return errorResponse(400, "invalid_json");
  }
  if (bytes === null) return errorResponse(413, "payload_too_large");

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return errorResponse(400, "invalid_json");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return errorResponse(400, "invalid_json");
  }
  const input = parsed as Record<string, unknown>;

  const rawBody = input.body;
  if (typeof rawBody !== "string") return jsonResponse(400, { error: "invalid_request", field: "body" });
  const rawTitle = optionalText(input.title);
  if (rawTitle === null) return jsonResponse(400, { error: "invalid_request", field: "title" });
  const rawPersona = optionalText(input.persona);
  if (rawPersona === null) return jsonResponse(400, { error: "invalid_request", field: "persona" });

  // Nothing worth keeping: not an error, but nothing is stored and the response says so.
  if (rawBody.trim() === "") return jsonResponse(200, { saved: false, reason: "empty_body" });

  const clippedBody = clipText(rawBody, BODY_MAX_CHARS);
  const body = clippedBody.clipped ? clippedBody.text + TRUNCATION_MARK : clippedBody.text;
  const title = clipText(rawTitle ?? "", TITLE_MAX_CHARS).text;
  const persona = clipText(rawPersona ?? "", PERSONA_MAX_CHARS).text;
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const truncated = clippedBody.clipped ? 1 : 0;

  try {
    // The count check and the insert are ONE statement, so two saves arriving together cannot pass the check
    // at the same time and exceed the limit. No row comes back when the limit has been reached.
    const row = await db
      .prepare(
        `INSERT INTO notes (id, created_at, persona, title, body, truncated)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE (SELECT COUNT(*) FROM notes) < ?7
         RETURNING id`,
      )
      .bind(id, createdAt, persona, title, body, truncated, MAX_NOTES)
      .first<{ id: string }>();
    if (!row) return jsonResponse(409, { error: "notes_limit_reached", limit: MAX_NOTES });
  } catch {
    return errorResponse(503, "notes_unavailable");
  }
  return jsonResponse(201, {
    saved: true,
    note: summarize({ id, created_at: createdAt, persona, title, truncated }),
  });
}

async function listNotes(db: NotesD1Like): Promise<Response> {
  try {
    const result = await db
      .prepare(
        `SELECT id, created_at, persona, title, truncated FROM notes
         ORDER BY created_at DESC, rowid DESC LIMIT ?1`,
      )
      .bind(MAX_NOTES)
      .all<NoteRow>();
    return jsonResponse(200, { notes: (result.results ?? []).map(summarize), limit: MAX_NOTES });
  } catch {
    return errorResponse(503, "notes_unavailable");
  }
}

async function getNote(db: NotesD1Like, id: string): Promise<Response> {
  try {
    const row = await db
      .prepare(`SELECT id, created_at, persona, title, body, truncated FROM notes WHERE id = ?1`)
      .bind(id)
      .first<NoteRow>();
    if (!row) return errorResponse(404, "not_found");
    return jsonResponse(200, { note: { ...summarize(row), body: row.body ?? "" } });
  } catch {
    return errorResponse(503, "notes_unavailable");
  }
}

async function deleteNote(db: NotesD1Like, id: string): Promise<Response> {
  try {
    const row = await db.prepare(`DELETE FROM notes WHERE id = ?1 RETURNING id`).bind(id).first<{ id: string }>();
    if (!row) return errorResponse(404, "not_found");
    return jsonResponse(200, { deleted: true });
  } catch {
    return errorResponse(503, "notes_unavailable");
  }
}

async function deleteAllNotes(db: NotesD1Like): Promise<Response> {
  try {
    const result = await db.prepare(`DELETE FROM notes RETURNING id`).bind().all<{ id: string }>();
    return jsonResponse(200, { deleted: (result.results ?? []).length });
  } catch {
    return errorResponse(503, "notes_unavailable");
  }
}

export async function handleNotes(
  request: Request,
  env: NotesEnv,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);

  // Route and method.
  let itemId: string | null = null;
  if (url.pathname !== "/api/notes" && url.pathname !== "/api/notes/") {
    const match = /^\/api\/notes\/([^/]+)$/.exec(url.pathname);
    if (!match) return errorResponse(404, "not_found");
    try {
      itemId = decodeURIComponent(match[1]);
    } catch {
      return errorResponse(404, "not_found");
    }
  }
  const isItem = itemId !== null;
  const allowed = isItem ? ["GET", "DELETE"] : ["GET", "POST", "DELETE"];
  if (!allowed.includes(request.method)) {
    return errorResponse(405, "method_not_allowed", { Allow: allowed.join(", ") });
  }
  const operation: Operation =
    request.method === "GET" ? (isItem ? "get" : "list")
    : request.method === "POST" ? "save"
    : isItem ? "delete"
    : "delete_all";
  const isWrite = operation === "save" || operation === "delete" || operation === "delete_all";

  // Same-origin checks. Browsers always send Origin on POST/DELETE; a same-origin GET may omit it.
  // No CORS headers are ever emitted, so cross-origin pages cannot read responses.
  const origin = request.headers.get("Origin");
  if (origin === null ? isWrite : origin !== url.origin) return errorResponse(403, "forbidden_origin");
  if (operation === "save") {
    const contentType = (request.headers.get("Content-Type") ?? "").toLowerCase();
    if (!contentType.startsWith("application/json")) return errorResponse(415, "unsupported_media_type");
  }

  // Fail closed on incomplete configuration; names only, never values.
  const missing: string[] = [];
  if (!env.ALLOWED_EMAIL) missing.push("ALLOWED_EMAIL");
  if (env.AUTH_PROVIDER === "google") {
    if (!env.GOOGLE_CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
  } else if (env.AUTH_PROVIDER === "access") {
    if (!env.ACCESS_TEAM_DOMAIN) missing.push("ACCESS_TEAM_DOMAIN");
    if (!env.ACCESS_AUDIENCE) missing.push("ACCESS_AUDIENCE");
  } else {
    missing.push("AUTH_PROVIDER");
  }
  if (missing.length > 0) {
    return new Response(JSON.stringify({ error: "service_misconfigured", missing }), {
      status: 503,
      headers: { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" },
    });
  }
  const allowedEmail = env.ALLOWED_EMAIL as string;

  const auth = await authenticate(request, env, fetcher, allowedEmail);
  if (auth instanceof Response) return auth;

  // Any account other than the allowlisted one is "not signed in" for this API (401, never 403).
  const email = auth.email.trim().toLowerCase();
  if (email !== allowedEmail.trim().toLowerCase()) return errorResponse(401, "unauthenticated");

  const limitOptions = isWrite ? NOTES_WRITE_RATE_LIMIT : NOTES_READ_RATE_LIMIT;
  const limit = await checkRateLimit(env.RATE_LIMIT_DB, `notes:${isWrite ? "write" : "read"}:${email}`, {
    ...limitOptions,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  if (limit === "limited") return errorResponse(429, "rate_limited", { "Retry-After": "60" });
  if (limit === "unavailable") return errorResponse(503, "rate_limit_unavailable");
  const db = env.RATE_LIMIT_DB as NotesD1Like; // checkRateLimit returned ok, so the binding exists

  switch (operation) {
    case "list":
      return listNotes(db);
    case "get":
      return getNote(db, itemId as string);
    case "save":
      return saveNote(request, db);
    case "delete":
      return deleteNote(db, itemId as string);
    case "delete_all":
      if (url.searchParams.get("confirm") !== DELETE_ALL_CONFIRMATION) {
        return errorResponse(400, "confirmation_required");
      }
      return deleteAllNotes(db);
  }
}

// Pages Functions entrypoint: method checks happen inside handleNotes.
export const onRequest = (context: { request: Request; env: NotesEnv }) =>
  handleNotes(context.request, context.env);
