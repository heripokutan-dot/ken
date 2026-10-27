// Generic RS256 JWT verification against a JWKS endpoint. Fails closed on any problem.
// Callers supply the expected issuers and audience and perform their own identity checks.

export class JwtVerificationError extends Error {
  constructor(message = "jwt_verification_failed") {
    super(message);
    this.name = "JwtVerificationError";
  }
}

export interface JwksConfig {
  jwksUrl: string;
  issuers: string[];
  audience: string[]; // token is accepted if its aud/azp matches any entry
  nowSeconds?: number;
  allowAzp?: boolean; // when true, azp may stand in for aud (Google ID tokens)
}

export interface VerifiedClaims {
  [claim: string]: unknown;
}

type Jwk = JsonWebKey & { kid?: string };
interface KeyCacheEntry {
  keys: Jwk[];
  fetchedAt: number;
}

const KEY_TTL_MS = 5 * 60 * 1000;
const keyCache = new Map<string, KeyCacheEntry>();

export function clearJwksCache(): void {
  keyCache.clear();
}

export function base64UrlToBytes(input: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) throw new JwtVerificationError();
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJsonSegment(segment: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new JwtVerificationError();
}

async function fetchKeys(jwksUrl: string, fetcher: typeof fetch, nowMs: number, bypassCache: boolean): Promise<Jwk[]> {
  const cached = keyCache.get(jwksUrl);
  if (!bypassCache && cached && nowMs - cached.fetchedAt < KEY_TTL_MS) return cached.keys;

  let res: Response;
  try {
    res = await fetcher(jwksUrl);
  } catch {
    throw new JwtVerificationError();
  }
  if (!res.ok) throw new JwtVerificationError();
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new JwtVerificationError();
  }
  const keys = (body as { keys?: unknown })?.keys;
  if (!Array.isArray(keys)) throw new JwtVerificationError();
  const usable = keys.filter((k): k is Jwk => !!k && typeof k === "object" && (k as Jwk).kty === "RSA");
  keyCache.set(jwksUrl, { keys: usable, fetchedAt: nowMs });
  return usable;
}

export async function verifyRs256Jwt(
  token: string,
  config: JwksConfig,
  fetcher: typeof fetch = fetch,
): Promise<VerifiedClaims> {
  if (!token || typeof token !== "string") throw new JwtVerificationError();
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtVerificationError();
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = decodeJsonSegment(headerB64);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new JwtVerificationError();

  const nowSec = config.nowSeconds !== undefined ? config.nowSeconds : Math.floor(Date.now() / 1000);
  const nowMs = nowSec * 1000;

  let keys = await fetchKeys(config.jwksUrl, fetcher, nowMs, false);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    // Key rotation: refetch once, bypassing the cache.
    keys = await fetchKeys(config.jwksUrl, fetcher, nowMs, true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new JwtVerificationError();

  let publicKey: CryptoKey;
  try {
    publicKey = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    throw new JwtVerificationError();
  }

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    base64UrlToBytes(signatureB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  if (!valid) throw new JwtVerificationError();

  const claims = decodeJsonSegment(payloadB64);
  if (typeof claims.iss !== "string" || !config.issuers.includes(claims.iss)) throw new JwtVerificationError();

  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const audOk = aud.some((a) => typeof a === "string" && config.audience.includes(a));
  const azpOk =
    config.allowAzp === true && typeof claims.azp === "string" && config.audience.includes(claims.azp);
  if (!audOk && !azpOk) throw new JwtVerificationError();

  if (typeof claims.exp !== "number" || claims.exp <= nowSec) throw new JwtVerificationError();
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > nowSec)) {
    throw new JwtVerificationError();
  }
  return claims;
}
