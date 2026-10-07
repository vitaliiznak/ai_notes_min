import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { errorResponse, HttpError, logServerError } from "../errors.js";
import type { Enricher, LiveEnrichment } from "./enrichment.js";
import type { NotesRepo } from "./repo.js";
import type { AiField, Note } from "./limits.js";
import { CreateNoteInput } from "./schema.js";

const notFound = () => new HttpError(404, "not_found", "Note not found.");

// A malformed id can't name an existing note, so it's a 404 like any unknown id.
function noteId(req: Request): string {
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) throw notFound();
  return id.data;
}

function found(note: Note | null): Note {
  if (!note) throw notFound();
  return note;
}

// Optional. A client that sends one can retry a create without storing the note twice.
function idempotencyKey(req: Request): string | undefined {
  const header = req.get("idempotency-key");
  if (header === undefined) return undefined;
  const key = z.uuid().safeParse(header);
  if (!key.success) throw new HttpError(400, "invalid_idempotency_key", "Idempotency-Key must be a UUID.");
  return key.data;
}

function wantsStream(req: Request): boolean {
  const accept = req.headers.accept;
  return typeof accept === "string" && accept.includes("text/event-stream");
}

function writeEvent(res: Response, event: string, data: unknown) {
  if (res.destroyed || res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function beginStream(res: Response) {
  res.status(200);
  res.set({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.socket?.setNoDelay(true);
  res.flushHeaders();
}

// Hold the response until the first preview so a failure with no text keeps its HTTP status.
// Once text has started, a later failure is an error event: the status is already 200.
async function writeStream(res: Response, live: LiveEnrichment) {
  const iterator = live.previews[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) {
    const note = found(await live.note);
    beginStream(res);
    writeEvent(res, "done", { note });
    res.end();
    return;
  }

  beginStream(res);
  writeEvent(res, "preview", first.value);
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      writeEvent(res, "preview", next.value);
    }
    writeEvent(res, "done", { note: found(await live.note) });
  } catch (err) {
    logServerError(err);
    writeEvent(res, "error", errorResponse(err).body);
  } finally {
    if (!res.writableEnded) res.end();
  }
}

export function notesRouter(repo: NotesRepo, enrich: Enricher): Router {
  const router = Router();

  router.get("/notes", async (_req, res) => {
    res.json({ notes: await repo.list() });
  });

  // Responds as soon as the note is stored; its tags (and summary, if long enough) are generated after.
  // 201 the first time. A repeat of the same Idempotency-Key returns the stored note with 200 and starts nothing.
  router.post("/notes", async (req, res) => {
    const input = CreateNoteInput.parse(req.body);
    const { note, created } = await repo.create(input, idempotencyKey(req));
    if (!created && (note.title !== input.title || note.content !== input.content)) {
      throw new HttpError(422, "idempotency_key_reused", "This Idempotency-Key was already used for a different note.");
    }
    if (created) enrich.start(note);
    res.status(created ? 201 : 200).json({ note });
  });

  // Cross-site requests are already rejected in app.ts, like every other mutation.
  router.delete("/notes", async (_req, res) => {
    res.json({ deleted: await repo.removeAll() });
  });

  router.delete("/notes/:id", async (req, res) => {
    if (!await repo.remove(noteId(req))) throw notFound();
    res.json({ deleted: 1 });
  });

  router.get("/notes/:id", async (req, res) => {
    res.json({ note: found(await repo.get(noteId(req))) });
  });

  // POST /notes/:id/summary and /notes/:id/tags. Cached after the first call; ?regenerate=true forces a new one.
  // Joins the call a new note started, if it is still running.
  // Accept: text/event-stream sends preview events, then done. Anything else gets one JSON body.
  for (const field of ["summary", "tags"] satisfies AiField[]) {
    router.post(`/notes/:id/${field}`, async (req, res) => {
      const live = await enrich.open(noteId(req), field, { regenerate: req.query.regenerate === "true" });
      if (wantsStream(req)) await writeStream(res, live);
      else res.json({ note: found(await live.note) });
    });
  }

  return router;
}
