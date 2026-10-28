-- Saved conversation notes for POST/GET/DELETE /api/notes (Cloudflare D1). Additive only: touches no existing table.
-- Single-user app, so there is no user column. created_at is epoch milliseconds.
-- Apply with: wrangler d1 execute <database-name> --remote --file migrations/0002_notes.sql
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  persona TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes (created_at);
