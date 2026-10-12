import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { errorResponse, HttpError, logServerError } from "../errors.js";
import type { AiRun, Enricher } from "./enrichment.js";
import type { NotesRepo } from "./repo.js";
import type { AiField, Note } from "./types.js";
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

// A repeat of an Idempotency-Key must carry the note it stored. The issues name the fields that differ, not their text.
function assertSameNote(input: CreateNoteInput, stored: Note) {
  const labels = { title: "Title", content: "Content" } as const;
  const issues = (["title", "content"] as const)
    .filter((field) => input[field] !== stored[field])
    .map((field) => ({ path: field, message: `${labels[field]} does not match the note stored for this Idempotency-Key.` }));
  if (issues.length > 0) {
    throw new HttpError(422, "idempotency_key_reused", "This Idempotency-Key was already used for a different note.", issues);
  }
}

const wantsStream = (req: Request) => req.get("accept")?.includes("text/event-stream") === true;

function beginStream(res: Response) {
  res.status(200).set({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.socket?.setNoDelay(true);
  res.flushHeaders();
}

// Headers wait for the first event, so a failure before any text still gets its own HTTP status as JSON.
// Once an event is sent the status is 200, so a later failure becomes an error event.
async function writeStream(res: Response, run: AiRun) {
  const send = (event: "preview" | "done" | "error", data: unknown) => {
    if (!res.headersSent) beginStream(res);
    if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const stop = run.watch((preview) => send("preview", preview));
  try {
    send("done", { note: found(await run.note) });
  } catch (err) {
    if (!res.headersSent) throw err;
    logServerError(err);
    send("error", errorResponse(err).body);
  } finally {
    stop();
  }
  res.end();
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
    if (created) enrich.start(note);
    else assertSameNote(input, note);
    res.status(created ? 201 : 200).json({ note });
  });

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

  // Cached after the first call; ?regenerate=true forces a new one.
  // Joins the call a new note started, if it is still running.
  // Accept: text/event-stream sends preview events, then done. Anything else gets one JSON body.
  const enrichNote = (field: AiField) => async (req: Request, res: Response) => {
    const run = await enrich.open(noteId(req), field, { regenerate: req.query.regenerate === "true" });
    if (wantsStream(req)) await writeStream(res, run);
    else res.json({ note: found(await run.note) });
  };

  router.post("/notes/:id/summary", enrichNote("summary"));
  router.post("/notes/:id/tags", enrichNote("tags"));

  return router;
}
