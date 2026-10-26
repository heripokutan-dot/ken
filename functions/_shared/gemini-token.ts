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
  constructor(status: number, safeMessage: string) {
    super(safeMessage);
    this.name = "GeminiTokenError";
    this.status = status;
  }
}

export interface EphemeralToken {
  token: string;
  model: string;
  websocketUrl: string;
}

export async function createGeminiEphemeralToken(input: {
  apiKey: string | undefined;
  fetcher?: typeof fetch;
  now?: Date;
}): Promise<EphemeralToken> {
  if (!input.apiKey) throw new GeminiTokenError(503, "gemini_not_configured");
  const fetcher = input.fetcher ?? fetch;
  const now = input.now ?? new Date();
  const plusMinutes = (m: number) => new Date(now.getTime() + m * 60_000).toISOString();

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
  if (!res.ok) throw new GeminiTokenError(502, "token_upstream_rejected");

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
