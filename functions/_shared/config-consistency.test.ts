// Guards the deployment contract: binding names, migration SQL, code references, and docs must agree.
// Reads repository files only; never reads secrets (none are stored in the repository).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
});

test("no_wrangler_file_so_the_pages_dashboard_stays_the_source_of_truth", () => {
  // With a Wrangler file Pages manages variables and bindings from the file and the dashboard accepts only
  // Secrets; dashboard Secrets then did not reach Preview Functions. Settings live in the dashboard instead.
  for (const name of ["wrangler.toml", "wrangler.json", "wrangler.jsonc"]) {
    assert.equal(existsSync(new URL(name, ROOT)), false, `${name} must not exist`);
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
  for (const rel of ["migrations/0001_rate_limits.sql"]) {
    const text = read(rel);
    assert.doesNotMatch(text, /AIza[0-9A-Za-z_-]{20,}/, `${rel} must not contain a Gemini-style key`);
    assert.doesNotMatch(text, /account_id|accountId|[0-9a-f]{32}/i, `${rel} must not contain account identifiers`);
  }
});
