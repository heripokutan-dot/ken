// Issues a constrained, single-use Gemini Live ephemeral token. All model/config values are server-defined.
// Never log or return the API key, the raw provider response, or provider error text.

export const MODEL_ID = "gemini-3.8-live";
export const WEBSOCKET_URL =
  "wss://generativelanguage.googleapis.com/ws/" +
  "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";
const AUTH_TOKENS_URL = "https://generativelanguage.googleapis.com/v1beta/auth_tokens";

const SYSTEM_INSTRUCTION =
  "あなたは日本語で自然に会話する音声アシスタントです。簡潔で親しみやすく、相手の発話に直接答えてください。";

export class GeminiTokenError extends Error {
  readonly status: number;
  // HTTP status Google answered with (a bare number, never any response text), when there was an answer.
  readonly upstreamStatus?: number;
  // Allowlisted Google error enums and schema field paths only (never provider message text).
  readonly upstreamCode?: string;
  readonly upstreamReason?: string;
  readonly upstreamField?: string;
  constructor(
    status: number,
    safeMessage: string,
    upstreamStatus?: number,
    extra: { code?: string; reason?: string; field?: string } = {},
  ) {
    super(safeMessage);
    this.name = "GeminiTokenError";
    this.status = status;
    this.upstreamStatus = upstreamStatus;
    this.upstreamCode = extra.code;
    this.upstreamReason = extra.reason;
    this.upstreamField = extra.field;
  }
}

export interface EphemeralToken {
  token: string;
  model: string;
  websocketUrl: string;
}

const GOOGLE_CODES = new Set([
  "INVALID_ARGUMENT", "FAILED_PRECONDITION", "OUT_OF_RANGE", "UNAUTHENTICATED", "PERMISSION_DENIED",
  "NOT_FOUND", "ALREADY_EXISTS", "RESOURCE_EXHAUSTED", "UNIMPLEMENTED", "INTERNAL", "UNAVAILABLE",
]);
const GOOGLE_REASONS = new Set([
  "API_KEY_INVALID", "API_KEY_EXPIRED", "API_KEY_SERVICE_BLOCKED", "API_KEY_HTTP_REFERRER_BLOCKED",
  "API_KEY_IP_ADDRESS_BLOCKED", "SERVICE_DISABLED", "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "RATE_LIMIT_EXCEEDED",
  "RESOURCE_EXHAUSTED", "CONSUMER_SUSPENDED", "BILLING_DISABLED", "SERVICE_NOT_ACTIVATED",
]);
const FIELD_PATH = /^[A-Za-z][A-Za-z0-9_.\[\]]{0,79}$/;

// Extracts only allowlisted enums and a schema field path from a Google error body. Everything else is dropped.
async function safeGoogleErrorInfo(res: Response): Promise<{ code?: string; reason?: string; field?: string }> {
  try {
    const err = ((await res.json()) as { error?: { status?: unknown; details?: unknown } })?.error;
    const out: { code?: string; reason?: string; field?: string } = {};
    if (typeof err?.status === "string" && GOOGLE_CODES.has(err.status)) out.code = err.status;
    if (Array.isArray(err?.details)) {
      for (const d of err.details as Array<Record<string, unknown>>) {
        if (!out.reason && typeof d?.reason === "string" && GOOGLE_REASONS.has(d.reason)) out.reason = d.reason;
        const v = Array.isArray(d?.fieldViolations) ? (d.fieldViolations as Array<Record<string, unknown>>)[0] : undefined;
        if (!out.field && typeof v?.field === "string" && FIELD_PATH.test(v.field)) out.field = v.field;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export async function createGeminiEphemeralToken(input: {
  apiKey: string | undefined;
  fetcher?: typeof fetch;
  now?: Date;
}): Promise<EphemeralToken> {
  if (!input.apiKey) throw new GeminiTokenError(503, "gemini_not_configured");
  const fetcher = input.fetcher ?? fetch;
  const now = input.now ?? new Date();
  // Google's documented format is YYYY-MM-DDTHH:MM:SSZ (no milliseconds).
  const plusMinutes = (m: number) => new Date(now.getTime() + m * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");

  const body = {
    uses: 1,
    expireTime: plusMinutes(30),
    newSessionExpireTime: plusMinutes(1),
    liveConnectConstraints: {
      model: `models/${MODEL_ID}`,
      config: {
        responseModalities: ["AUDIO"],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      },
    },
  };

  let res: Response;
  try {
    res = await fetcher(AUTH_TOKENS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": input.apiKey },
      body: JSON.stringify(body),
    });
  } catch {
    throw new GeminiTokenError(502, "token_upstream_unreachable");
  }
  if (!res.ok) throw new GeminiTokenError(502, "token_upstream_rejected", res.status, await safeGoogleErrorInfo(res));

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new GeminiTokenError(502, "token_upstream_malformed");
  }
  const obj = (json ?? {}) as { name?: unknown; token?: { name?: unknown } };
  const token = typeof obj.name === "string" && obj.name ? obj.name : obj.token?.name;
  if (typeof token !== "string" || !token) throw new GeminiTokenError(502, "token_upstream_malformed");

  return { token, model: MODEL_ID, websocketUrl: WEBSOCKET_URL };
}
