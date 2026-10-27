// Verifies a Cloudflare Access application JWT (RS256) using the team's published public keys.
// Fails closed: any problem rejects. Requires Cloudflare Access, which needs payment details to activate.

import { verifyRs256Jwt, JwtVerificationError } from "./jwt-rs256.ts";

export interface AccessConfig {
  teamDomain: string; // hostname only, e.g. "team.cloudflareaccess.com"
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

export { clearJwksCache as clearAccessKeyCache } from "./jwt-rs256.ts";

export async function verifyAccessJwt(
  token: string,
  config: AccessConfig,
  fetcher: typeof fetch = fetch,
): Promise<VerifiedAccess> {
  let claims;
  try {
    claims = await verifyRs256Jwt(
      token,
      {
        jwksUrl: `https://${config.teamDomain}/cdn-cgi/access/certs`,
        issuers: [`https://${config.teamDomain}`],
        audience: [config.audience],
        nowSeconds: config.nowSeconds,
      },
      fetcher,
    );
  } catch (err) {
    if (err instanceof JwtVerificationError) throw new AccessAuthError();
    throw err;
  }
  if (typeof claims.email !== "string" || !claims.email) throw new AccessAuthError();
  return { email: claims.email, subject: typeof claims.sub === "string" ? claims.sub : "" };
}
