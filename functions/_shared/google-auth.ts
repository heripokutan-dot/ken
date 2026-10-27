// Verifies a Google Identity Services ID token on the server. No payment method, no client secret needed:
// only the public OAuth client ID is used. Fails closed on any problem.

import { verifyRs256Jwt, JwtVerificationError } from "./jwt-rs256.ts";

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export interface GoogleAuthConfig {
  clientId: string; // OAuth 2.0 Web client ID (public, not a secret)
  allowedEmail: string; // the single permitted account
  nowSeconds?: number;
}

export interface VerifiedGoogleUser {
  email: string;
  subject: string;
}

export class GoogleAuthError extends Error {
  constructor(message = "google_auth_failed") {
    super(message);
    this.name = "GoogleAuthError";
  }
}

export async function verifyGoogleIdToken(
  token: string,
  config: GoogleAuthConfig,
  fetcher: typeof fetch = fetch,
): Promise<VerifiedGoogleUser> {
  // Fail closed before any network call if the server is not configured.
  if (!config.clientId || !config.allowedEmail) throw new GoogleAuthError();

  let claims;
  try {
    claims = await verifyRs256Jwt(
      token,
      {
        jwksUrl: GOOGLE_JWKS_URL,
        issuers: GOOGLE_ISSUERS,
        audience: [config.clientId],
        allowAzp: true,
        nowSeconds: config.nowSeconds,
      },
      fetcher,
    );
  } catch (err) {
    if (err instanceof JwtVerificationError) throw new GoogleAuthError();
    throw err;
  }

  if (claims.email_verified !== true) throw new GoogleAuthError();
  if (typeof claims.email !== "string" || !claims.email) throw new GoogleAuthError();
  if (claims.email.trim().toLowerCase() !== config.allowedEmail.trim().toLowerCase()) {
    throw new GoogleAuthError();
  }
  return { email: claims.email, subject: typeof claims.sub === "string" ? claims.sub : "" };
}
