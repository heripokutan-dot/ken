import type { D1Like } from "./rate-limit.ts";

// Test-only helpers for signing Cloudflare Access style JWTs with a real RSA key pair.

function b64url(bytes: ArrayBuffer | Uint8Array | string): string {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : new Uint8Array(bytes as ArrayBuffer);
  let s = "";
  for (const b of data) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface TestKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JsonWebKey & { kid: string };
}

export async function makeKey(kid = "test-kid"): Promise<TestKey> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { kid, privateKey: pair.privateKey, publicJwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
}

export async function signJwt(
  key: TestKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  const h = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: key.kid, ...header }));
  const p = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}

export function validClaims(overrides: Record<string, unknown> = {}, now = Math.floor(Date.now() / 1000)) {
  return {
    iss: "https://team.cloudflareaccess.com",
    aud: ["aud-tag-123"],
    exp: now + 300,
    nbf: now - 10,
    iat: now - 10,
    sub: "user-sub-1",
    email: "owner@example.com",
    ...overrides,
  };
}

// Fake fetch that serves a JWKS document for the Access certs endpoint.
export function jwksFetcher(
  keys: Array<JsonWebKey & { kid: string }>,
  status = 200,
  allowedPrefix = "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
) {
  let calls = 0;
  const fn = async (input: string | URL | Request) => {
    calls++;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(allowedPrefix)) {
      return new Response("unexpected", { status: 500 });
    }
    return new Response(JSON.stringify({ keys }), { status, headers: { "Content-Type": "application/json" } });
  };
  return { fetch: fn as unknown as typeof fetch, calls: () => calls };
}

// Minimal D1-shaped adapter over node:sqlite so the real SQL is exercised.
export function d1FromSqlite(db: { prepare(sql: string): any }): D1Like {
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              return ((stmt.get(...(args as never[])) as T | undefined) ?? null) as T | null;
            },
            async run() {
              stmt.run(...(args as never[]));
              return {};
            },
          };
        },
      };
    },
  };
}

