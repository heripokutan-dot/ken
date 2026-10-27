import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { verifyGoogleIdToken, GoogleAuthError } from "./google-auth.ts";
import { clearJwksCache } from "./jwt-rs256.ts";
import { makeKey, signJwt, jwksFetcher } from "./test-utils.ts";

const CLIENT_ID = "123456-abc.apps.googleusercontent.com";
const JWKS = "https://www.googleapis.com/oauth2/v3/certs";
const ALLOWED = "owner@example.com";

beforeEach(() => clearJwksCache());

function claims(now = Math.floor(Date.now() / 1000), overrides: Record<string, unknown> = {}) {
  return {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    azp: CLIENT_ID,
    exp: now + 300,
    iat: now - 10,
    sub: "google-sub-1",
    email: ALLOWED,
    email_verified: true,
    ...overrides,
  };
}

async function setup(overrides: Record<string, unknown> = {}, now?: number) {
  const key = await makeKey("g-kid");
  const token = await signJwt(key, claims(now, overrides));
  const f = jwksFetcher([key.publicJwk], 200, JWKS);
  return { key, token, fetcher: f.fetch, calls: f.calls };
}

async function expectGoogleError(p: Promise<unknown>) {
  await assert.rejects(p, (e: unknown) => e instanceof GoogleAuthError);
}

test("returns_verified_email_for_valid_google_token", async () => {
  const { token, fetcher } = await setup();
  const result = await verifyGoogleIdToken(token, { clientId: CLIENT_ID, allowedEmail: ALLOWED }, fetcher);
  assert.equal(result.email, ALLOWED);
  assert.equal(result.subject, "google-sub-1");
});

test("accepts_bare_google_issuer_form", async () => {
  const { token, fetcher } = await setup({ iss: "accounts.google.com" });
  const result = await verifyGoogleIdToken(token, { clientId: CLIENT_ID, allowedEmail: ALLOWED }, fetcher);
  assert.equal(result.email, ALLOWED);
});

test("rejects_missing_token", async () => {
  const { fetcher } = await setup();
  await expectGoogleError(verifyGoogleIdToken("", { clientId: CLIENT_ID, allowedEmail: ALLOWED }, fetcher));
});

test("rejects_bad_signature", async () => {
  const { fetcher } = await setup();
  const other = await makeKey("g-kid");
  const forged = await signJwt(other, claims());
  await expectGoogleError(verifyGoogleIdToken(forged, { clientId: CLIENT_ID, allowedEmail: ALLOWED }, fetcher));
});

test("rejects_wrong_issuer", async () => {
  const { token, fetcher } = await setup({ iss: "https://evil.example" });
  await expectGoogleError(verifyGoogleIdToken(token, { clientId: CLIENT_ID, allowedEmail: ALLOWED }, fetcher));
});

test("rejects_token_issued_for_another_client_id", async () => {
  const { token, fetcher } = await setup({ aud: "other.apps.googleusercontent.com", azp: "other.apps.googleusercontent.com" });
  await expectGoogleError(verifyGoogleIdToken(token, { clientId: CLIENT_ID, allowedEmail: ALLOWED }, fetcher));
});

test("rejects_expired_token", async () => {
  const now = Math.floor(Date.now() / 1000);
  const { token, fetcher } = await setup({ exp: now - 60 }, now);
  await expectGoogleError(verifyGoogleIdToken(token, { clientId: CLIENT_ID, allowedEmail: ALLOWED }, fetcher));
});

test("rejects_unverified_email", async () => {
  const { token, fetcher } = await setup({ email_verified: false });
  await expectGoogleError(verifyGoogleIdToken(token, { clientId: CLIENT_ID, allowedEmail: ALLOWED }, fetcher));
});

test("rejects_non_allowlisted_email", async () => {
  const { token, fetcher } = await setup({ email: "stranger@example.com" });
  await expectGoogleError(verifyGoogleIdToken(token, { clientId: CLIENT_ID, allowedEmail: ALLOWED }, fetcher));
});

test("fails_closed_when_client_id_or_allowlist_not_configured", async () => {
  const { token, fetcher, calls } = await setup();
  await expectGoogleError(verifyGoogleIdToken(token, { clientId: "", allowedEmail: ALLOWED }, fetcher));
  await expectGoogleError(verifyGoogleIdToken(token, { clientId: CLIENT_ID, allowedEmail: "" }, fetcher));
  assert.equal(calls(), 0, "must not fetch keys without configuration");
});

test("fails_closed_when_key_fetch_fails", async () => {
  const key = await makeKey("g-kid");
  const token = await signJwt(key, claims());
  const f = jwksFetcher([key.publicJwk], 503, JWKS);
  await expectGoogleError(verifyGoogleIdToken(token, { clientId: CLIENT_ID, allowedEmail: ALLOWED }, f.fetch));
});
