-- Fixed-window rate limit counters for POST /api/live-token (Cloudflare D1).
-- Apply with: wrangler d1 execute <database-name> --remote --file migrations/0001_rate_limits.sql
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);
