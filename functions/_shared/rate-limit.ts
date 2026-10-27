// Fixed-window rate limiter backed by a D1 database (Cloudflare Pages Functions supports D1 bindings;
// the Rate Limiting binding is NOT listed as a supported Pages Functions binding).
// Fails closed: a missing or erroring database yields "unavailable", never "ok".

export interface D1Like {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      first<T = unknown>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
}

export const RATE_LIMIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);`;

export type RateLimitResult = "ok" | "limited" | "unavailable";

export interface RateLimitOptions {
  limit: number;
  windowSeconds: number;
  nowSeconds: number;
}

const HIT_SQL = `
INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1
RETURNING count`;

const PRUNE_SQL = `DELETE FROM rate_limits WHERE window_start < ?1`;

export async function checkRateLimit(
  db: D1Like | undefined,
  key: string,
  options: RateLimitOptions,
): Promise<RateLimitResult> {
  if (!db || typeof db.prepare !== "function") return "unavailable";
  const windowStart = Math.floor(options.nowSeconds / options.windowSeconds) * options.windowSeconds;
  try {
    const row = await db.prepare(HIT_SQL).bind(key, windowStart).first<{ count: number }>();
    // Prune windows that can no longer affect any decision.
    await db.prepare(PRUNE_SQL).bind(windowStart).run();
    if (!row || typeof row.count !== "number") return "unavailable";
    return row.count <= options.limit ? "ok" : "limited";
  } catch {
    return "unavailable";
  }
}
