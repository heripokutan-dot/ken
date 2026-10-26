import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { verifyAccessJwt, clearAccessKeyCache, AccessAuthError } from "./access-auth.ts";
import { makeKey, signJwt, validClaims, jwksFetcher } from "./test-utils.ts";

const CONFIG = { teamDomain: "team.cloudflareaccess.com", audience: "aud-tag-123" };

beforeEach(() => clearAccessKeyCache());

async function expectRejects(promise: Promise<unknown>) {
  await assert.rejects(promise, (e: unknown) => e instanceof AccessAuthError);
}

test("rejects_missing_token", async () => {
  await expectRejects(verifyAccessJwt("", CONFIG, jwksFetcher([]).fetch));
});

test("rejects_malformed_token", async () => {
  await expectRejects(verifyAccessJwt("not.a-jwt", CONFIG, jwksFetcher([]).fetch));
});

test("rejects_bad_signature", async () => {
  const key = await makeKey();
  const other = await makeKey();
  const token = await signJwt(other, validClaims());
  const f = jwksFetcher([key.publicJwk]);
  await expectRejects(verifyAccessJwt(token, CONFIG, f.fetch));
});

test("rejects_wrong_issuer", async () => {
  const key = await makeKey();
  const token = await signJwt(key, validClaims({ iss: "https://evil.cloudflareaccess.com" }));
  await expectRejects(verifyAccessJwt(token, CONFIG, jwksFetcher([key.publicJwk]).fetch));
});

test("rejects_wrong_audience", async () => {
  const key = await makeKey();
  const token = await signJwt(key, validClaims({ aud: ["someone-else"] }));
  await expectRejects(verifyAccessJwt(token, CONFIG, jwksFetcher([key.publicJwk]).fetch));
});

test("rejects_expired_token", async () => {
  const key = await makeKey();
  const token = await signJwt(key, validClaims({ exp: Math.floor(Date.now() / 1000) - 60 }));
  await expectRejects(verifyAccessJwt(token, CONFIG, jwksFetcher([key.publicJwk]).fetch));
});

test("rejects_not_yet_valid_token", async () => {
  const key = await makeKey();
  const token = await signJwt(key, validClaims({ nbf: Math.floor(Date.now() / 1000) + 600 }));
  await expectRejects(verifyAccessJwt(token, CONFIG, jwksFetcher([key.publicJwk]).fetch));
});

test("rejects_non_rs256_algorithm", async () => {
  const key = await makeKey();
  const token = await signJwt(key, validClaims(), { alg: "none" });
  await expectRejects(verifyAccessJwt(token, CONFIG, jwksFetcher([key.publicJwk]).fetch));
});

test("fails_closed_when_key_fetch_fails", async () => {
  const key = await makeKey();
  const token = await signJwt(key, validClaims());
  await expectRejects(verifyAccessJwt(token, CONFIG, jwksFetcher([key.publicJwk], 503).fetch));
});

test("returns_verified_email_for_valid_token", async () => {
  const key = await makeKey();
  const token = await signJwt(key, validClaims());
  const result = await verifyAccessJwt(token, CONFIG, jwksFetcher([key.publicJwk]).fetch);
  assert.equal(result.email, "owner@example.com");
  assert.equal(result.subject, "user-sub-1");
});

test("caches_public_keys_between_verifications", async () => {
  const key = await makeKey();
  const f = jwksFetcher([key.publicJwk]);
  await verifyAccessJwt(await signJwt(key, validClaims()), CONFIG, f.fetch);
  await verifyAccessJwt(await signJwt(key, validClaims()), CONFIG, f.fetch);
  assert.equal(f.calls(), 1);
});
