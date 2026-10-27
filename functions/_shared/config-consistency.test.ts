// Guards the deployment contract: binding names, migration SQL, code references, and docs must agree.
// Reads repository files only; never reads secrets (none are stored in the repository).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RATE_LIMIT_SCHEMA } from "./rate-limit.ts";

const ROOT = new URL("../../", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, ROOT), "utf8");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

test("migration_sql_matches_the_schema_the_code_uses", () => {
  const migration = read("migrations/0001_rate_limits.sql")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
  assert.equal(squash(migration), squash(RATE_LIMIT_SCHEMA));
});

test("code_reads_the_d1_binding_named_in_the_docs", () => {
  const liveToken = read("functions/api/live-token.ts");
  assert.match(liveToken, /RATE_LIMIT_DB\?: D1Like/);
  assert.match(liveToken, /checkRateLimit\(env\.RATE_LIMIT_DB,/);
  assert.match(read("docs/superpowers/plans/2026-10-27-gemini-live-iphone-cloudflare-setup.md"), /RATE_LIMIT_DB/);
  assert.match(read("wrangler.toml"), /RATE_LIMIT_DB/);
});

test("wrangler_file_declares_the_d1_binding_for_production_and_preview_only", () => {
  // Pages treats wrangler.toml as the source of truth: bindings defined there cannot be edited in the dashboard.
  // d1_databases is not inherited, so Preview needs [[env.preview.d1_databases]]. "previews" is not a Pages key.
  // Secrets (GEMINI_API_KEY, GOOGLE_CLIENT_ID, ALLOWED_EMAIL, ...) stay in the dashboard, never in this file.
  const wrangler = read("wrangler.toml");
  const active = wrangler.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
  assert.match(active, /^\[\[d1_databases\]\]/m);
  assert.match(active, /^\[\[env\.preview\.d1_databases\]\]/m);
  assert.doesNotMatch(active, /previews\./);
  assert.equal((active.match(/binding\s*=\s*"RATE_LIMIT_DB"/g) ?? []).length, 2);
  // Only the non-secret AUTH_PROVIDER and the public OAuth GOOGLE_CLIENT_ID may be declared as a plain variable; everything else stays a dashboard Secret.
  const varsBlocks = [...active.matchAll(/^\[(?:env\.[a-z]+\.)?vars\]\n((?:(?!\[).*\n?)*)/gm)];
  for (const block of varsBlocks) {
    const keys = [...block[1].matchAll(/^\s*([A-Z0-9_]+)\s*=/gm)].map((m) => m[1]);
    assert.deepEqual(keys, ["AUTH_PROVIDER", "GOOGLE_CLIENT_ID"]);
    assert.match(block[1], /AUTH_PROVIDER\s*=\s*"google"/);
    assert.match(block[1], /GOOGLE_CLIENT_ID\s*=\s*"[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com"/);
  }
});

test("secret_and_variable_names_in_docs_match_the_code_interface", () => {
  const liveToken = read("functions/api/live-token.ts");
  const names = ["GEMINI_API_KEY", "AUTH_PROVIDER", "GOOGLE_CLIENT_ID", "ALLOWED_EMAIL", "RATE_LIMIT_DB"];
  const guide = read("docs/superpowers/plans/2026-10-27-gemini-live-iphone-cloudflare-setup.md");
  for (const name of names) {
    assert.match(liveToken, new RegExp(`\\b${name}\\??:`), `code must declare ${name}`);
    assert.match(guide, new RegExp(name), `setup guide must mention ${name}`);
  }
});

test("repository_files_contain_no_account_identifiers_or_secret_shaped_values", () => {
  for (const rel of ["wrangler.toml", "migrations/0001_rate_limits.sql"]) {
    const text = read(rel);
    assert.doesNotMatch(text, /AIza[0-9A-Za-z_-]{20,}/, `${rel} must not contain a Gemini-style key`);
    assert.doesNotMatch(text, /account_id|accountId|[0-9a-f]{32}/i, `${rel} must not contain account identifiers`);
  }
});
