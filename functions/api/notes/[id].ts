// /api/notes/<id> — Cloudflare Pages route file. The handler (it reads the id from the URL) lives in index.ts.

import { handleNotes, type NotesEnv } from "./index.ts";

export const onRequest = (context: { request: Request; env: NotesEnv }) =>
  handleNotes(context.request, context.env);
