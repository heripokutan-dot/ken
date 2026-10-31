// Guards the deployment contract: binding names, migration SQL, code references, and docs must agree.
// Reads repository files only; never reads secrets (none are stored in the repository).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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

// --- migrations/0002_notes.sql (saved conversation notes) ---

const withoutComments = (sql: string) =>
  sql
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

test("notes_migration_is_additive_only_and_never_touches_the_rate_limit_table", () => {
  const sql = withoutComments(read("migrations/0002_notes.sql"));
  const statements = sql
    .split(";")
    .map((s) => squash(s))
    .filter((s) => s.length > 0);
  assert.equal(statements.length, 2);
  assert.match(statements[0], /^CREATE TABLE IF NOT EXISTS notes \(/);
  assert.match(statements[1], /^CREATE INDEX IF NOT EXISTS \w+ ON notes \(created_at\)$/);
  assert.doesNotMatch(sql, /\b(DROP|ALTER|DELETE|UPDATE|INSERT|REPLACE|TRUNCATE)\b/i);
  assert.doesNotMatch(sql, /rate_limits/i);
});

test("notes_migration_creates_the_columns_the_notes_api_needs", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(read("migrations/0002_notes.sql"));
  const columns = db.prepare("PRAGMA table_info(notes)").all() as unknown as ColumnInfo[];
  assert.deepEqual(
    columns.map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk]),
    [
      ["id", "TEXT", 0, null, 1],
      ["created_at", "INTEGER", 1, null, 0],
      ["persona", "TEXT", 1, "''", 0],
      ["title", "TEXT", 1, "''", 0],
      ["body", "TEXT", 1, null, 0],
      ["truncated", "INTEGER", 1, "0", 0],
    ],
  );
});

test("notes_migration_indexes_created_at", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(read("migrations/0002_notes.sql"));
  const indexes = db.prepare("PRAGMA index_list(notes)").all() as unknown as Array<{ name: string }>;
  const indexedColumns = indexes.map((i) =>
    (db.prepare(`PRAGMA index_info(${i.name})`).all() as unknown as Array<{ name: string }>).map((c) => c.name),
  );
  assert.ok(indexedColumns.some((cols) => cols.length === 1 && cols[0] === "created_at"));
});

test("notes_migration_applies_defaults_and_rejects_bad_truncated_values", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(read("migrations/0002_notes.sql"));
  db.prepare("INSERT INTO notes (id, created_at, body) VALUES (?, ?, ?)").run("n1", 1700000000000, "text");
  const row = db.prepare("SELECT persona, title, truncated FROM notes WHERE id = ?").get("n1") as unknown as {
    persona: string;
    title: string;
    truncated: number;
  };
  assert.deepEqual({ ...row }, { persona: "", title: "", truncated: 0 });
  assert.throws(() => db.prepare("INSERT INTO notes (id, created_at, body, truncated) VALUES (?, ?, ?, ?)").run("n2", 1, "t", 2));
  assert.throws(() => db.prepare("INSERT INTO notes (id, created_at) VALUES (?, ?)").run("n3", 1));
});

test("notes_migration_can_be_applied_twice_and_after_0001_without_changing_rate_limits", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(read("migrations/0001_rate_limits.sql"));
  const before = db.prepare("PRAGMA table_info(rate_limits)").all() as unknown as ColumnInfo[];
  db.exec(read("migrations/0002_notes.sql"));
  db.exec(read("migrations/0002_notes.sql"));
  const after = db.prepare("PRAGMA table_info(rate_limits)").all() as unknown as ColumnInfo[];
  assert.deepEqual(after.map((c) => ({ ...c })), before.map((c) => ({ ...c })));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as unknown as Array<{ name: string }>;
  assert.deepEqual(tables.map((t) => t.name), ["notes", "rate_limits"]);
});

test("notes_migration_contains_no_account_identifiers_or_secret_shaped_values", () => {
  const text = read("migrations/0002_notes.sql");
  assert.doesNotMatch(text, /AIza[0-9A-Za-z_-]{20,}/);
  assert.doesNotMatch(text, /account_id|accountId|[0-9a-f]{32}/i);
});
