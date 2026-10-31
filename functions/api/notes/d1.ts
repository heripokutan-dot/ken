// D1 shape used by /api/notes. It is a superset of _shared/rate-limit.ts's D1Like (which has no multi-row read),
// so the same binding can be passed to checkRateLimit. _shared is left unchanged on purpose.

export interface NotesD1Statement {
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<unknown>;
  all<T = unknown>(): Promise<{ results?: T[] }>;
}

export interface NotesD1Like {
  prepare(sql: string): {
    bind(...args: unknown[]): NotesD1Statement;
  };
}
