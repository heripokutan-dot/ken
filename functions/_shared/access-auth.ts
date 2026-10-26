// Verifies a Cloudflare Access application JWT (RS256) using the team's published public keys.
// Fails closed: any problem (missing key, bad signature, wrong iss/aud, expired, key fetch error) rejects.

export interface AccessConfig {
  teamDomain: string; // e.g. "team.cloudflareaccess.com" (hostname only)
  audience: string; // Application Audience (AUD) tag
  nowSeconds?: number;
}

export interface VerifiedAccess {
  email: string;
  subject: string;
}

export class AccessAuthError extends Error {
  constructor(message = "access_auth_failed") {
    super(message);
    this.name = "AccessAuthError";
  }
}

type Jwk = JsonWebKey & { kid?: string };
interface KeyCacheEntry {
  keys: Jwk[];
  fetchedAt: number;
}

const KEY_TTL_MS = 5 * 60 * 1000;
const keyCache = new Map<string, KeyCacheEntry>();

export function clearAccessKeyCache(): void {
  keyCache.clear();
}

function base64UrlToBytes(input: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) throw new AccessAuthError();
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson(segment: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new AccessAuthError();
}

async function fetchKeys(teamDomain: string, fetcher: typeof fetch, nowMs: number): Promise<Jwk[]> {
  const cached = keyCache.get(teamDomain);
  if (cached && nowMs - cached.fetchedAt < KEY_TTL_MS) return cached.keys;

  let res: Response;
  try {
    res = await fetcher(`https://${teamDomain}/cdn-cgi/access/certs`);
  } catch {
    throw new AccessAuthError();
  }
  if (!res.ok) throw new AccessAuthError();
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new AccessAuthError();
  }
  const keys = (body as { keys?: unknown })?.keys;
  if (!Array.isArray(keys)) throw new AccessAuthError();
  const usable = keys.filter((k): k is Jwk => !!k && typeof k === "object" && (k as Jwk).kty === "RSA");
  keyCache.set(teamDomain, { keys: usable, fetchedAt: nowMs });
  return usable;
}

export async function verifyAccessJwt(
  token: string,
  config: AccessConfig,
  fetcher: typeof fetch = fetch,
): Promise<VerifiedAccess> {
  if (!token || typeof token !== "string") throw new AccessAuthError();
  const parts = token.split(".");
  if (parts.length !== 3) throw new AccessAuthError();
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = decodeJson(headerB64);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new AccessAuthError();

  const nowMs = (config.nowSeconds !== undefined ? config.nowSeconds : Math.floor(Date.now() / 1000)) * 1000;
  let keys = await fetchKeys(config.teamDomain, fetcher, nowMs);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    // Key rotation: refetch once, bypassing the cache.
    keyCache.delete(config.teamDomain);
    keys = await fetchKeys(config.teamDomain, fetcher, nowMs);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new AccessAuthError();

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
    throw new AccessAuthError();
  }

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    base64UrlToBytes(signatureB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  if (!valid) throw new AccessAuthError();

  const claims = decodeJson(payloadB64);
  const nowSec = nowMs / 1000;
  if (claims.iss !== `https://${config.teamDomain}`) throw new AccessAuthError();
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(config.audience)) throw new AccessAuthError();
  if (typeof claims.exp !== "number" || claims.exp <= nowSec) throw new AccessAuthError();
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > nowSec)) throw new AccessAuthError();
  if (typeof claims.email !== "string" || !claims.email) throw new AccessAuthError();

  return {
    email: claims.email,
    subject: typeof claims.sub === "string" ? claims.sub : "",
  };
}
