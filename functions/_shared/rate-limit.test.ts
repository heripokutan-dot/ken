import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { checkRateLimit, RATE_LIMIT_SCHEMA, type D1Like } from "./rate-limit.ts";
import { d1FromSqlite } from "./test-utils.ts";

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(RATE_LIMIT_SCHEMA);
  return { db, d1: d1FromSqlite(db) };
}

const OPTS = { limit: 3, windowSeconds: 60 };

test("allows_requests_up_to_the_limit_then_blocks", async () => {
  const { d1 } = freshDb();
  const results = [];
  for (let i = 0; i < 4; i++) {
    results.push(await checkRateLimit(d1, "owner@example.com", { ...OPTS, nowSeconds: 1000 }));
  }
  assert.deepEqual(results, ["ok", "ok", "ok", "limited"]);
});

test("keys_are_counted_independently", async () => {
  const { d1 } = freshDb();
  for (let i = 0; i < 3; i++) await checkRateLimit(d1, "a@example.com", { ...OPTS, nowSeconds: 1000 });
  assert.equal(await checkRateLimit(d1, "a@example.com", { ...OPTS, nowSeconds: 1000 }), "limited");
  assert.equal(await checkRateLimit(d1, "b@example.com", { ...OPTS, nowSeconds: 1000 }), "ok");
});

test("a_new_window_resets_the_count", async () => {
  const { d1 } = freshDb();
  for (let i = 0; i < 3; i++) await checkRateLimit(d1, "owner@example.com", { ...OPTS, nowSeconds: 1000 });
  assert.equal(await checkRateLimit(d1, "owner@example.com", { ...OPTS, nowSeconds: 1000 }), "limited");
  assert.equal(await checkRateLimit(d1, "owner@example.com", { ...OPTS, nowSeconds: 1060 }), "ok");
});

test("old_windows_are_pruned", async () => {
  const { db, d1 } = freshDb();
  await checkRateLimit(d1, "owner@example.com", { ...OPTS, nowSeconds: 1000 });
  await checkRateLimit(d1, "owner@example.com", { ...OPTS, nowSeconds: 2000 });
  const rows = db.prepare("SELECT window_start FROM rate_limits").all() as Array<{ window_start: number }>;
  assert.deepEqual(rows.map((r) => r.window_start), [1980]);
});

test("missing_database_is_unavailable_not_ok", async () => {
  assert.equal(await checkRateLimit(undefined, "owner@example.com", { ...OPTS, nowSeconds: 1000 }), "unavailable");
});

test("database_errors_are_unavailable_not_ok", async () => {
  const broken: D1Like = {
    prepare() {
      return {
        bind() {
          return {
            async first() {
              throw new Error("D1 offline");
            },
            async run() {
              throw new Error("D1 offline");
            },
          };
        },
      };
    },
  };
  assert.equal(await checkRateLimit(broken, "owner@example.com", { ...OPTS, nowSeconds: 1000 }), "unavailable");
});
